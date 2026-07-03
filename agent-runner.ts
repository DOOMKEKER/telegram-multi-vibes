#!/usr/bin/env bun
/**
 * Multi-session AgentRunner (Phase 1).
 *
 * One CLI agent per Telegram topic. On each inbound message the daemon hands the
 * (chat_id, thread_id) + text to runAgentTurn(); we look up (or create) the
 * topic's session and run the locally-authenticated CLI, feeding the message as
 * the prompt and returning the final text. Turns within one topic are serialized
 * (a per-topic promise chain); topics run in parallel.
 *
 * The topic -> session-id map is persisted to sessions.json so topics reattach
 * to their agent after a daemon restart.
 *
 * Phase 1 is intentionally "cold" (a fresh `claude -p` per message). See
 * docs/DESIGN-multisession.md for the warm-session upgrade path.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type AgentProvider = 'claude' | 'codex'

export type AgentConfig = {
  stateDir: string
  cwd: string
  provider: AgentProvider
  agentBin: string
  permissionMode: string
  model?: string
  codexProfile?: string
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  codexDangerousBypass?: boolean
  /** Hard backstop on a single agent turn before the child is killed. */
  timeoutMs?: number
  /** Idle cap: kill only after this long with NO output. Resets on every chunk,
   *  so a turn that keeps streaming (thinking/text/tools) is never killed for
   *  "thinking too long" — only a genuinely wedged process trips it. */
  idleMs?: number
  /** Wrap the agent in macOS sandbox-exec, confining writes to its cwd. */
  sandbox?: boolean
}

type SessionRec = {
  sessionId: string
  cwd: string
  createdAt: number
  lastActivity: number
  /** false until the first successful run (decides new session vs resume). */
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
const running = new Map<string, ChildProcess>() // topic key -> current in-flight child
const stopped = new Set<string>() // topics the user asked to stop mid-turn

/** Kill all in-flight agent subprocesses. Called on daemon shutdown so a restart
 *  never orphans CLI children that would keep resuming a session and
 *  collide with the next daemon's turns on the same topic. */
export function killAllAgents(): void {
  for (const c of activeChildren) {
    try { c.kill('SIGKILL') } catch {}
  }
  activeChildren.clear()
}

/** Stop the in-flight agent turn for a topic (user pressed ⏹ Stop). Marks it as
 *  a deliberate stop so the turn ends with a "stopped" notice, not an error. */
export function stopTopic(chatId: string, threadId: string | undefined): boolean {
  const key = topicKey(chatId, threadId)
  const c = running.get(key)
  if (!c) return false
  stopped.add(key)
  try { c.kill('SIGKILL') } catch {}
  return true
}

/** Optional OS-level confinement (macOS): allow writes only to the agent's cwd,
 *  the CLI's own state (~/.claude/~/.codex, needed for resume), and temp.
 *  Defense in depth on top of the CLI's own sandbox. Opt-in via cfg.sandbox. */
function wrapSandbox(cwd: string, args: string[]): [string, string[]] {
  if (!cfg.sandbox) return [cfg.agentBin, args]
  let real = cwd
  try { real = realpathSync(cwd) } catch {}
  const home = homedir()
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath "${real}")`,
    `  (subpath "${home}/.claude")`,
    `  (subpath "${home}/.codex")`,
    '  (subpath "/private/var/folders")',
    '  (subpath "/private/tmp")',
    '  (subpath "/tmp")',
    '  (subpath "/dev"))',
  ].join('\n')
  return ['sandbox-exec', ['-p', profile, cfg.agentBin, ...args]]
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
  cfg = { ...c, timeoutMs: c.timeoutMs ?? 1_800_000, idleMs: c.idleMs ?? 240_000 }
  SESSIONS_FILE = join(c.stateDir, c.provider === 'claude' ? 'sessions.json' : `sessions-${c.provider}.json`)
  mkdirSync(c.stateDir, { recursive: true })
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
  log(`turn provider=${cfg.provider} key=${key} session=${rec.sessionId} ${rec.started ? 'resume' : 'new'} ${stream ? 'stream' : 'json'} cwd=${rec.cwd}`)

  let code = 0
  let stderr = ''
  let result = ''
  let newSessionId = ''
  const onChild = (c: ChildProcess) => running.set(key, c)
  if (cfg.provider === 'codex') {
    const r = await spawnCodex(
      rec.started,
      rec.sessionId,
      rec.cwd,
      prompt,
      opts?.onDelta,
      opts?.onStatus,
      onChild,
    )
    code = r.code
    stderr = r.stderr
    result = r.result
    newSessionId = r.sessionId
  } else {
    const args = ['-p', '--permission-mode', cfg.permissionMode, '--append-system-prompt', APPEND_SYSTEM_PROMPT]
    if (cfg.model) args.push('--model', cfg.model)
    if (rec.started) args.push('--resume', rec.sessionId)
    else args.push('--session-id', rec.sessionId)

    if (stream) {
      const r = await spawnClaudeStream(
        [...args, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
        rec.cwd,
        prompt,
        opts!.onDelta!,
        opts?.onStatus,
        onChild,
      )
      code = r.code
      stderr = r.stderr
      result = r.result
      newSessionId = r.sessionId
    } else {
      const r = await spawnClaude([...args, '--output-format', 'json'], rec.cwd, prompt, onChild)
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
  }

  running.delete(key)

  // User pressed ⏹ Stop — end cleanly, not as a failure.
  if (stopped.has(key)) {
    stopped.delete(key)
    if (!rec.started) sessions.delete(key) // killed a fresh session → start clean next time
    saveSessions()
    return '⏹ Остановлено.'
  }

  // Watchdog timeout (-2) that still produced text: deliver the partial answer
  // with a note instead of throwing it away. A long-but-working turn that hit a
  // cap shouldn't surface as a bare "agent failed".
  if (code === -2 && result.trim()) {
    log(`${cfg.provider} timed out (-2) but produced ${result.length} chars — delivering partial`)
    if (newSessionId) rec.sessionId = newSessionId
    rec.started = true
    rec.fails = 0
    rec.lastActivity = Date.now()
    saveSessions()
    return `${result}\n\n⏳ (прервал по тайм-ауту — это всё, что успел сгенерировать)`
  }

  if (code !== 0) {
    log(`${cfg.provider} exited ${code}: ${stderr.slice(0, 800)}`)
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

  if (cfg.provider === 'codex' && !rec.started && !newSessionId) {
    sessions.delete(key)
    saveSessions()
    throw new Error('codex did not return a thread_id for the new topic session')
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
  onChild?: (c: ChildProcess) => void,
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
    const [bin, spawnArgs] = wrapSandbox(cwd, args)
    const child = spawn(bin, spawnArgs, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    activeChildren.add(child)
    onChild?.(child)
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

function buildCodexPrompt(prompt: string): string {
  return [
    APPEND_SYSTEM_PROMPT,
    '',
    'Telegram message:',
    prompt,
  ].join('\n')
}

function codexArgs(resume: boolean, sessionId: string, cwd: string): string[] {
  const args = resume
    ? ['exec', 'resume', '--json']
    : ['exec', '--json', '--skip-git-repo-check', '-C', cwd]

  if (cfg.model) args.push('-m', cfg.model)
  if (cfg.codexDangerousBypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else if (!resume) {
    args.push('-s', cfg.codexSandbox ?? 'workspace-write')
  }
  if (!resume && cfg.codexProfile) args.push('-p', cfg.codexProfile)
  if (resume) args.push('--skip-git-repo-check', sessionId)
  args.push('-')
  return args
}

function spawnCodex(
  resume: boolean,
  sessionId: string,
  cwd: string,
  prompt: string,
  onDelta?: (accumulated: string) => void,
  onStatus?: (status: string) => void,
  onChild?: (c: ChildProcess) => void,
): Promise<{ code: number; result: string; sessionId: string; stderr: string }> {
  return new Promise(resolve => {
    let done = false
    let buf = ''
    let stderr = ''
    let result = ''
    let newSessionId = ''
    const messages: string[] = []
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const args = codexArgs(resume, sessionId, cwd)
    const [bin, spawnArgs] = wrapSandbox(cwd, args)
    const child = spawn(bin, spawnArgs, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })

    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      activeChildren.delete(child)
      resolve({ code, result, sessionId: newSessionId, stderr })
    }
    const killWith = (note: string) => {
      stderr += `\n[${note}]`
      try { child.kill('SIGKILL') } catch {}
      finish(-2)
    }
    const bump = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => killWith(`no output for ${Math.round((cfg.idleMs ?? 240_000) / 1000)}s`),
        cfg.idleMs ?? 240_000,
      )
    }
    const handleLine = (line: string) => {
      let o: any
      try { o = JSON.parse(line) } catch { return }
      if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
        newSessionId = o.thread_id
        return
      }
      if (o.type === 'turn.started') {
        try { onStatus?.('💭 думаю…') } catch {}
        return
      }
      if (o.type === 'item.started' && o.item?.type) {
        const name = typeof o.item.name === 'string' ? o.item.name : o.item.type
        try { onStatus?.(`⚙️ ${name}…`) } catch {}
        return
      }
      if (
        o.type === 'item.completed' &&
        o.item?.type === 'agent_message' &&
        typeof o.item.text === 'string'
      ) {
        messages.push(o.item.text)
        result = messages.join('\n\n')
        try { onDelta?.(result) } catch {}
      }
    }

    activeChildren.add(child)
    onChild?.(child)
    const hardTimer = setTimeout(
      () => killWith(`hit hard cap ${Math.round((cfg.timeoutMs ?? 1_800_000) / 1000)}s`),
      cfg.timeoutMs ?? 1_800_000,
    )
    bump()
    child.stdout.on('data', d => {
      bump()
      buf += d.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (line) handleLine(line)
      }
    })
    child.stderr.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', err => { stderr += `\n${err}`; finish(-1) })
    child.on('close', code => {
      const tail = buf.trim()
      if (tail) handleLine(tail)
      finish(code ?? -1)
    })
    try {
      child.stdin.write(buildCodexPrompt(prompt))
      child.stdin.end()
    } catch (err) {
      stderr += `stdin write failed: ${err}`
      finish(-1)
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
  onChild?: (c: ChildProcess) => void,
): Promise<{ code: number; result: string; sessionId: string; stderr: string }> {
  return new Promise(resolve => {
    let done = false
    let buf = ''
    let stderr = ''
    let acc = ''
    let result = ''
    let sessionId = ''
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      activeChildren.delete(child)
      resolve({ code, result: result || acc, sessionId, stderr })
    }
    const killWith = (note: string) => {
      stderr += `\n[${note}]`
      try { child.kill('SIGKILL') } catch {}
      finish(-2)
    }
    // Idle watchdog: reset on every byte the agent emits, so a long-but-working
    // turn never dies. Only true silence (a wedged process) trips it.
    const bump = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => killWith(`no output for ${Math.round((cfg.idleMs ?? 240_000) / 1000)}s`),
        cfg.idleMs ?? 240_000,
      )
    }
    const [bin, spawnArgs] = wrapSandbox(cwd, args)
    const child = spawn(bin, spawnArgs, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    activeChildren.add(child)
    onChild?.(child)
    // Absolute backstop for a turn that keeps emitting forever (runaway loop).
    const hardTimer = setTimeout(
      () => killWith(`hit hard cap ${Math.round((cfg.timeoutMs ?? 1_800_000) / 1000)}s`),
      cfg.timeoutMs ?? 1_800_000,
    )
    bump()
    child.stdout.on('data', d => {
      bump()
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
