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

import { spawn } from 'child_process'
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
}

const APPEND_SYSTEM_PROMPT =
  'You are answering a user through a Telegram chat. Keep replies concise and in ' +
  'plain text suitable for a messenger (no huge dumps). The user sees only your ' +
  'final message — your tool output and intermediate steps are not shown to them.'

let cfg: AgentConfig
let SESSIONS_FILE = ''
const sessions = new Map<string, SessionRec>()
const queues = new Map<string, Promise<unknown>>()

export function topicKey(chatId: string, threadId: string | undefined): string {
  return `${chatId}:${threadId ?? ''}`
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
export function runAgentTurn(chatId: string, threadId: string | undefined, prompt: string): Promise<string> {
  const key = topicKey(chatId, threadId)
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => doTurn(key, prompt))
  // Keep the chain alive even if this turn rejects, so the next message still runs.
  queues.set(key, next.catch(() => {}))
  return next
}

async function doTurn(key: string, prompt: string): Promise<string> {
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

  const args = ['-p', '--output-format', 'json', '--permission-mode', cfg.permissionMode]
  args.push('--append-system-prompt', APPEND_SYSTEM_PROMPT)
  if (cfg.model) args.push('--model', cfg.model)
  if (rec.started) args.push('--resume', rec.sessionId)
  else args.push('--session-id', rec.sessionId)

  log(`turn key=${key} session=${rec.sessionId} ${rec.started ? 'resume' : 'new'} cwd=${rec.cwd}`)
  const { code, stdout, stderr } = await spawnClaude(args, rec.cwd, prompt)

  if (code !== 0) {
    log(`claude exited ${code}: ${stderr.slice(0, 800)}`)
    // A failed FIRST run leaves a dangling --session-id; drop it so the next
    // message starts a clean session instead of colliding on the same uuid.
    if (!rec.started) {
      sessions.delete(key)
      saveSessions()
    }
    throw new Error(`agent failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
  }

  let result = ''
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; session_id?: unknown }
    result = typeof parsed.result === 'string' ? parsed.result : stdout
    if (typeof parsed.session_id === 'string' && parsed.session_id) rec.sessionId = parsed.session_id
  } catch {
    result = stdout.trim()
  }

  rec.started = true
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
      resolve(r)
    }
    const child = spawn(cfg.claudeBin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
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
