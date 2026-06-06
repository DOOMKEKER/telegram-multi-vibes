#!/usr/bin/env bun
/**
 * Multi-session AgentRunner (Phase 1).
 *
 * One Claude agent per Telegram topic. On each inbound message the daemon hands
 * the (chat_id, thread_id) + text to runAgentTurn(); we look up (or create) the
 * topic's Claude session and run the locally-authenticated `claude -p`
 * (subscription, no API key), feeding the message as the prompt and returning
 * the final text. First run for a topic uses `--session-id <uuid>`; subsequent
 * runs use `--resume <uuid>` so context is preserved. Turns within one topic are
 * serialized (a per-topic promise chain); topics run in parallel.
 *
 * The topic -> session-id map is persisted to sessions.json so topics reattach
 * to their agent after a daemon restart.
 *
 * Phase 1 is intentionally "cold" (a fresh `claude -p` per message). See
 * docs/DESIGN-multisession.md for the warm-session upgrade path.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export type AgentConfig = {
  stateDir: string
  cwd: string
  claudeBin: string
  permissionMode: string
  model?: string
  /** Hard cap on a single agent turn before the child is killed. */
  timeoutMs?: number
}

type SessionRec = {
  sessionId: string
  cwd: string
  createdAt: number
  lastActivity: number
  /** false until the first successful run (decides --session-id vs --resume). */
  started: boolean
  /** consecutive failed turns; resets the session after a couple in a row. */
  fails?: number
}

const APPEND_SYSTEM_PROMPT =
  'You are replying to a user inside a Telegram chat (not a terminal). Keep replies ' +
  'short and conversational. Telegram renders only light Markdown — bold, italic, ' +
  'inline code, fenced ``` code blocks, links, and simple bullet lists. Do NOT use ' +
  'Markdown tables, ASCII tables, or long ATX headings (#) — they do not render well. ' +
  'The user sees only your final message; your tool calls and intermediate steps are ' +
  'not shown to them.'

let cfg: AgentConfig
let SESSIONS_FILE = ''
const sessions = new Map<string, SessionRec>()
const queues = new Map<string, Promise<unknown>>()
const activeChildren = new Set<ChildProcess>()

/** Kill all in-flight agent subprocesses. Called on daemon shutdown so a restart
 *  never orphans `claude -p` children that would keep --resuming a session and
 *  collide with the next daemon's turns on the same topic. */
export function killAllAgents(): void {
  for (const c of activeChildren) {
    try { c.kill('SIGKILL') } catch {}
  }
  activeChildren.clear()
}

export function topicKey(chatId: string, threadId: string | undefined): string {
  return `${chatId}:${threadId ?? ''}`
}

/** Point a topic at a working directory, starting a FRESH session there (a
 *  running Claude session can't change its cwd, so we reset the mapping). */
export function setTopicCwd(chatId: string, threadId: string | undefined, cwd: string): void {
  sessions.set(topicKey(chatId, threadId), {
    sessionId: randomUUID(),
    cwd,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    started: false,
    fails: 0,
  })
  saveSessions()
}

/** The topic's current working directory, or the configured default if unset. */
export function getTopicCwd(chatId: string, threadId: string | undefined): string {
  return sessions.get(topicKey(chatId, threadId))?.cwd ?? cfg.cwd
}

function log(msg: string): void {
  process.stderr.write(`telegram agent: ${msg}\n`)
}

function loadSessions(): void {
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf8')
    const obj = JSON.parse(raw) as Record<string, SessionRec>
    for (const [k, v] of Object.entries(obj)) sessions.set(k, v)
    log(`loaded ${sessions.size} topic session(s)`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    try { renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.corrupt-${Date.now()}`) } catch {}
    log('sessions.json was corrupt, moved aside. Starting fresh.')
  }
}

function saveSessions(): void {
  const obj: Record<string, SessionRec> = {}
  for (const [k, v] of sessions) obj[k] = v
  const tmp = SESSIONS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, SESSIONS_FILE)
}

export function initAgentRunner(c: AgentConfig): void {
  cfg = { timeoutMs: 600_000, ...c }
  SESSIONS_FILE = join(c.stateDir, 'sessions.json')
  mkdirSync(c.cwd, { recursive: true })
  loadSessions()
}

/** Run one agent turn for a topic. Serialized per topic. Resolves to reply text. */
export function runAgentTurn(
  chatId: string,
  threadId: string | undefined,
  prompt: string,
  opts?: { onDelta?: (accumulated: string) => void; onStatus?: (status: string) => void },
): Promise<string> {
  const key = topicKey(chatId, threadId)
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => doTurn(key, prompt, opts))
  // Keep the chain alive even if this turn rejects, so the next message still runs.
  queues.set(key, next.catch(() => {}))
  return next
}

async function doTurn(
  key: string,
  prompt: string,
  opts?: { onDelta?: (accumulated: string) => void; onStatus?: (status: string) => void },
): Promise<string> {
  let rec = sessions.get(key)
  if (!rec) {
    rec = {
      sessionId: randomUUID(),
      cwd: cfg.cwd,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      started: false,
    }
    sessions.set(key, rec)
    saveSessions()
  }

  const stream = !!opts?.onDelta
  const args = ['-p', '--permission-mode', cfg.permissionMode, '--append-system-prompt', APPEND_SYSTEM_PROMPT]
  if (cfg.model) args.push('--model', cfg.model)
  if (rec.started) args.push('--resume', rec.sessionId)
  else args.push('--session-id', rec.sessionId)

  log(`turn key=${key} session=${rec.sessionId} ${rec.started ? 'resume' : 'new'} ${stream ? 'stream' : 'json'} cwd=${rec.cwd}`)

  let code = 0
  let stderr = ''
  let result = ''
  let newSessionId = ''
  if (stream) {
    const r = await spawnClaudeStream(
      [...args, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
      rec.cwd,
      prompt,
      opts!.onDelta!,
      opts?.onStatus,
    )
    code = r.code
    stderr = r.stderr
    result = r.result
    newSessionId = r.sessionId
  } else {
    const r = await spawnClaude([...args, '--output-format', 'json'], rec.cwd, prompt)
    code = r.code
    stderr = r.stderr
    try {
      const parsed = JSON.parse(r.stdout) as { result?: unknown; session_id?: unknown }
      result = typeof parsed.result === 'string' ? parsed.result : r.stdout
      if (typeof parsed.session_id === 'string') newSessionId = parsed.session_id
    } catch {
      result = r.stdout.trim()
    }
  }

  if (code !== 0) {
    log(`claude exited ${code}: ${stderr.slice(0, 800)}`)
    if (!rec.started) {
      // A failed FIRST run leaves a dangling --session-id; drop it so the next
      // message starts a clean session instead of colliding on the same uuid.
      sessions.delete(key)
    } else {
      // Self-heal: a resumed session that keeps failing is likely broken. After
      // a couple of consecutive failures, drop the mapping so the next message
      // starts a clean session instead of resuming the broken one.
      rec.fails = (rec.fails ?? 0) + 1
      if (rec.fails >= 2) {
        log(`topic ${key}: session failed ${rec.fails}x — resetting to a fresh session`)
        sessions.delete(key)
      }
    }
    saveSessions()
    throw new Error(`agent failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
  }

  if (newSessionId) rec.sessionId = newSessionId
  rec.started = true
  rec.fails = 0
  rec.lastActivity = Date.now()
  saveSessions()
  return result || '(agent returned empty output)'
}

function spawnClaude(
  args: string[],
  cwd: string,
  prompt: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let done = false
    const finish = (r: { code: number; stdout: string; stderr: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      activeChildren.delete(child)
      resolve(r)
    }
    const child = spawn(cfg.claudeBin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ code: -2, stdout, stderr: stderr + `\n[timed out after ${cfg.timeoutMs}ms]` })
    }, cfg.timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString('utf8') })
    child.stderr.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', err => finish({ code: -1, stdout, stderr: `${stderr}\n${err}` }))
    child.on('close', code => finish({ code: code ?? -1, stdout, stderr }))
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (err) {
      finish({ code: -1, stdout, stderr: `stdin write failed: ${err}` })
    }
  })
}

// Streaming variant: parse NDJSON stream-json events, surface text deltas via
// onDelta(accumulatedText), and resolve with the final result text + session id.
function spawnClaudeStream(
  args: string[],
  cwd: string,
  prompt: string,
  onDelta: (accumulated: string) => void,
  onStatus?: (status: string) => void,
): Promise<{ code: number; result: string; sessionId: string; stderr: string }> {
  return new Promise(resolve => {
    let done = false
    let buf = ''
    let stderr = ''
    let acc = ''
    let result = ''
    let sessionId = ''
    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      activeChildren.delete(child)
      resolve({ code, result: result || acc, sessionId, stderr })
    }
    const child = spawn(cfg.claudeBin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    activeChildren.add(child)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(-2)
    }, cfg.timeoutMs)
    child.stdout.on('data', d => {
      buf += d.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (!line) continue
        let o: any
        try { o = JSON.parse(line) } catch { continue }
        if (
          o.type === 'stream_event' &&
          o.event?.type === 'content_block_delta' &&
          o.event?.delta?.type === 'text_delta' &&
          typeof o.event.delta.text === 'string'
        ) {
          acc += o.event.delta.text
          try { onDelta(acc) } catch {}
        } else if (o.type === 'stream_event' && o.event?.type === 'content_block_start' && o.event.content_block) {
          // Surface progress during gaps where no text streams (thinking / tools).
          const cb = o.event.content_block
          if (cb.type === 'tool_use' && onStatus) { try { onStatus(`⚙️ ${cb.name ?? 'tool'}…`) } catch {} }
          else if (cb.type === 'thinking' && onStatus) { try { onStatus('💭 думаю…') } catch {} }
        } else if (o.type === 'result') {
          if (typeof o.result === 'string') result = o.result
          if (typeof o.session_id === 'string') sessionId = o.session_id
        } else if (typeof o.session_id === 'string' && !sessionId) {
          sessionId = o.session_id
        }
      }
    })
    child.stderr.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', err => { stderr += `\n${err}`; finish(-1) })
    child.on('close', code => finish(code ?? -1))
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (err) {
      stderr += `stdin write failed: ${err}`
      finish(-1)
    }
  })
}
