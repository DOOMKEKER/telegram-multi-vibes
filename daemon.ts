#!/usr/bin/env bun
/**
 * Telegram channel daemon for Claude Code (Phase 2).
 *
 * Long-running process that owns the Telegram bot's getUpdates slot. MCP
 * servers from individual `claude` sessions connect over a Unix socket as
 * clients, register a (chat_id, thread_id) claim, and exchange:
 *   - notifications: daemon → client when an inbound message matches the claim
 *   - RPC: client → daemon for outbound (sendMessage, react, edit, getFile)
 *
 * This file is self-sufficient — it can be run directly:
 *   bun daemon.ts
 *
 * server.ts will be refactored in a follow-up commit to connect here as a
 * client; until then this daemon is dormant code. Run-time, the existing
 * server.ts still owns polling.
 */

import { createServer as createNetServer, type Socket } from 'net'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  chmodSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { initAgentRunner, runAgentTurn, killAllAgents, setTopicCwd, getTopicCwd, stopTopic } from './agent-runner'
import { execFile } from 'child_process'
import { promisify } from 'util'
import telegramify from 'telegramify-markdown'
const execFileP = promisify(execFile)

// ---- Paths & env -----------------------------------------------------------

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')
const PID_FILE = join(STATE_DIR, 'daemon.pid')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// Load ~/.claude/channels/telegram/.env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `telegram daemon: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// ---- Multi-session (one Claude agent per topic) ---------------------------
// When on, delivered messages are handed to a per-topic `claude -p --resume`
// agent instead of being broadcast to MCP clients. See docs/DESIGN-multisession.md.
const MULTI_SESSION = process.env.TELEGRAM_MULTI_SESSION === '1'
// NB: must live OUTSIDE ~/.claude — Claude Code blocks writes to its own config
// dir as "sensitive", so an agent cwd inside STATE_DIR can't create files.
const AGENT_CWD = process.env.TELEGRAM_AGENT_CWD ?? join(homedir(), 'telegram-agent-workspace')
const AGENT_PERMISSION_MODE = process.env.TELEGRAM_AGENT_PERMISSION_MODE ?? 'acceptEdits'
const AGENT_MODEL = process.env.TELEGRAM_AGENT_MODEL
const CLAUDE_BIN = process.env.TELEGRAM_CLAUDE_BIN ?? 'claude'
// Stream the agent's reply into one message (placeholder → live edits). On by
// default; set TELEGRAM_AGENT_STREAM=0 for a single final message instead.
const AGENT_STREAM = process.env.TELEGRAM_AGENT_STREAM !== '0'
// Opt-in OS-level confinement (macOS sandbox-exec): writes restricted to the
// agent's cwd (+ ~/.claude state + temp). Default off.
const AGENT_SANDBOX = process.env.TELEGRAM_AGENT_SANDBOX === '1'
// Optional overrides; agent-runner falls back to its own defaults (idle 240s,
// hard cap 1800s) when these are unset or 0.
const AGENT_TIMEOUT_MS = Number(process.env.TELEGRAM_AGENT_TIMEOUT_MS) || undefined
const AGENT_IDLE_MS = Number(process.env.TELEGRAM_AGENT_IDLE_MS) || undefined
if (MULTI_SESSION) {
  initAgentRunner({
    stateDir: STATE_DIR,
    cwd: AGENT_CWD,
    claudeBin: CLAUDE_BIN,
    permissionMode: AGENT_PERMISSION_MODE,
    model: AGENT_MODEL,
    sandbox: AGENT_SANDBOX,
    timeoutMs: AGENT_TIMEOUT_MS,
    idleMs: AGENT_IDLE_MS,
  })
  process.stderr.write(
    `telegram daemon: multi-session ON (cwd=${AGENT_CWD}, perm=${AGENT_PERMISSION_MODE}, bin=${CLAUDE_BIN}, stream=${AGENT_STREAM}, sandbox=${AGENT_SANDBOX}, timeout=${AGENT_TIMEOUT_MS ?? 1_800_000}ms, idle=${AGENT_IDLE_MS ?? 240_000}ms)\n`,
  )
}

// ---- Wire protocol shared with server.ts (the MCP client) ------------------

export type Claim = {
  /** Telegram chat_id (numeric, but always serialized as string). Omit to
   *  match any chat. */
  chat_id?: string
  /** Telegram message_thread_id. Omit to match any thread in chat_id.
   *  Combined with chat_id this identifies a specific forum topic in a DM
   *  (Threaded Mode) or supergroup. */
  thread_id?: string
}

export type ClientFrame =
  | { type: 'register'; claim: Claim; session_id?: string }
  | { type: 'deregister' }
  | { type: 'rpc'; id: string; method: string; params: Record<string, unknown> }
  | { type: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }

export type DaemonFrame =
  | { type: 'registered'; session_id: string }
  | { type: 'rpc_response'; id: string; ok: true; result: unknown }
  | { type: 'rpc_response'; id: string; ok: false; error: string }
  | { type: 'notification'; method: string; params: unknown }

// ---- Single-instance lifecycle ---------------------------------------------

try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    try {
      process.kill(stale, 0)
      process.stderr.write(`telegram daemon: replacing stale daemon pid=${stale}\n`)
      process.kill(stale, 'SIGTERM')
      await new Promise(r => setTimeout(r, 500))
    } catch { /* not running */ }
  }
} catch { /* no PID file */ }

if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH) } catch {}
}

writeFileSync(PID_FILE, String(process.pid))

let shuttingDown = false

function shutdown(code: number): never {
  shuttingDown = true
  try { killAllAgents() } catch {}
  try { ipcServer.close() } catch {}
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { void bot.stop() } catch {}
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (pid === process.pid) unlinkSync(PID_FILE)
  } catch {}
  process.exit(code)
}

process.on('SIGTERM', () => {
  process.stderr.write('telegram daemon: SIGTERM, shutting down\n')
  shutdown(0)
})
process.on('SIGINT', () => shutdown(0))
process.on('uncaughtException', err => {
  process.stderr.write(`telegram daemon: uncaught exception: ${err}\n`)
})
process.on('unhandledRejection', err => {
  process.stderr.write(`telegram daemon: unhandled rejection: ${err}\n`)
})

// ---- Access control types & file ops --------------------------------------

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type TopicPolicy = {
  requireMention?: boolean
  allowFrom?: string[]
  enabled?: boolean
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  topics?: Record<string, TopicPolicy>
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`telegram daemon: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram daemon: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let pruned = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      pruned = true
    }
  }
  return pruned
}

// ---- Helpers ---------------------------------------------------------------

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function effectiveSendThreadId(raw: string | number | undefined | null): number | undefined {
  if (raw == null) return undefined
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (!Number.isFinite(n) || n === 1) return undefined
  return n
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// Local speech-to-text via whisper.cpp. Audio never leaves the machine; no API
// key. Returns the transcript, or undefined to fall back to the placeholder +
// attachment behaviour (e.g. WHISPER_MODEL unset / binary missing / failure).
async function transcribeAudio(file_id: string): Promise<string | undefined> {
  const model = process.env.WHISPER_MODEL
  if (!model || !existsSync(model)) return undefined
  const whisperBin = process.env.WHISPER_CLI ?? 'whisper-cli'
  const ffmpegBin = process.env.FFMPEG ?? 'ffmpeg'
  const lang = process.env.WHISPER_LANG ?? 'auto'
  try {
    const file = await bot.api.getFile(file_id)
    if (!file.file_path) return undefined
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const uniq = (file.file_unique_id ?? 'dl').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    const base = join(INBOX_DIR, `${Date.now()}-${uniq}`)
    const ogg = `${base}.ogg`
    const wav = `${base}.wav`
    writeFileSync(ogg, buf)
    // whisper-cli wants 16 kHz mono WAV; Telegram sends OGG/Opus.
    await execFileP(ffmpegBin, ['-y', '-i', ogg, '-ar', '16000', '-ac', '1', wav])
    const { stdout } = await execFileP(
      whisperBin,
      ['-m', model, '-f', wav, '-l', lang, '-nt', '-np'],
      { maxBuffer: 10 * 1024 * 1024 },
    )
    // Privacy/disk: drop recordings once transcribed. WAV (derived temp) is
    // always removed; OGG is removed too unless TELEGRAM_VOICE_KEEP=1.
    try { unlinkSync(wav) } catch {}
    if (process.env.TELEGRAM_VOICE_KEEP !== '1') { try { unlinkSync(ogg) } catch {} }
    const txt = stdout
      .replace(/\r/g, '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .join(' ')
      .trim()
    return txt || undefined
  } catch (e) {
    // On failure leave the audio in the inbox for debugging.
    process.stderr.write(`telegram daemon: transcribe failed (audio kept in inbox): ${e}\n`)
    return undefined
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  if (mode === 'length') {
    const out: string[] = []
    for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit))
    return out
  }
  const out: string[] = []
  let buf = ''
  for (const para of text.split(/(?<=\n\n)/)) {
    if (buf.length + para.length > limit && buf) {
      out.push(buf)
      buf = ''
    }
    if (para.length > limit) {
      if (buf) { out.push(buf); buf = '' }
      for (let i = 0; i < para.length; i += limit) out.push(para.slice(i, i + limit))
      continue
    }
    buf += para
  }
  if (buf) out.push(buf)
  return out
}

function isMentioned(ctx: Context, patterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const at = text.slice(e.offset, e.offset + e.length).toLowerCase()
      if (at === `@${botUsername.toLowerCase()}`) return true
    }
    if (e.type === 'text_mention' && e.user?.username?.toLowerCase() === botUsername.toLowerCase()) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  if (patterns && text) {
    for (const p of patterns) {
      try { if (new RegExp(p, 'i').test(text)) return true } catch {}
    }
  }
  return false
}

// ---- Gate (access decision) ------------------------------------------------

type GateResult =
  | { action: 'drop' }
  | { action: 'deliver'; access: Access }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }

    const threadId = ctx.message?.message_thread_id
    const topic = threadId != null ? policy.topics?.[String(threadId)] : undefined
    if (topic?.enabled === false) return { action: 'drop' }

    const effectiveAllowFrom = topic?.allowFrom ?? policy.allowFrom ?? []
    const effectiveRequireMention = topic?.requireMention ?? policy.requireMention ?? true
    if (effectiveAllowFrom.length > 0 && !effectiveAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (effectiveRequireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

// ---- Client registry & IPC server ------------------------------------------

type Client = {
  id: string
  socket: Socket
  claim: Claim
  rxBuf: string
}

const clients = new Map<string, Client>()
let nextClientId = 1

function clientId(): string { return `c${nextClientId++}` }

function sendFrame(c: Client, frame: DaemonFrame): void {
  try {
    c.socket.write(JSON.stringify(frame) + '\n')
  } catch (err) {
    process.stderr.write(`telegram daemon: write to ${c.id} failed: ${err}\n`)
  }
}

/** Pick clients whose claim matches (chat_id, thread_id). Exact match wins;
 *  if none, fall back to clients with chat_id but no thread_id (catch-all in
 *  that chat); if none, fall back to clients with no claim (default). */
function routeClients(chat_id: string, thread_id: string | undefined): Client[] {
  const exact: Client[] = []
  const chatOnly: Client[] = []
  const fallback: Client[] = []
  for (const c of clients.values()) {
    if (!c.claim.chat_id && !c.claim.thread_id) {
      fallback.push(c)
    } else if (c.claim.chat_id === chat_id && c.claim.thread_id === thread_id) {
      exact.push(c)
    } else if (c.claim.chat_id === chat_id && !c.claim.thread_id) {
      chatOnly.push(c)
    }
  }
  if (exact.length) return exact
  if (chatOnly.length) return chatOnly
  return fallback
}

function broadcastNotification(method: string, params: unknown, route?: { chat_id: string; thread_id?: string }): void {
  const targets = route ? routeClients(route.chat_id, route.thread_id) : Array.from(clients.values())
  for (const c of targets) {
    sendFrame(c, { type: 'notification', method, params })
  }
}

/** Send an agent's reply back into a topic, chunked and threaded like the reply
 *  tool. Used by the multi-session path. */
/** Convert assistant Markdown to Telegram MarkdownV2 (escaped). null on failure. */
function tgMarkdown(text: string): string | null {
  try {
    const out = telegramify(text, 'escape')
    return typeof out === 'string' && out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Bot API 10.1 Rich Messages. OFF by default; enable with AGENT_RICH=1.
 *  Sends the assistant Markdown as a native rich message — tables, headings,
 *  code blocks, lists, quotes render client-side, up to 32768 chars (no
 *  chunking). grammy 1.41 has no typed method for this yet, so we go through
 *  the raw proxy (it forwards any method name to callApi). Returns true on a
 *  successful send; false (incl. when the flag is off or the API rejects it)
 *  means the caller should fall back to the existing MarkdownV2/plain path. */
const AGENT_RICH = process.env.AGENT_RICH === '1'
// Monotonic, non-zero draft id for sendRichMessageDraft. Reused within one
// streaming turn so Telegram animates the updates; new per turn.
let __draftSeq = 0
const nextDraftId = (): number => (__draftSeq = (__draftSeq + 1) % 2_000_000_000) + 1
async function sendRich(
  chat_id: string,
  tid: number | undefined,
  markdown: string,
  baseOpts: Record<string, unknown>,
): Promise<boolean> {
  if (!AGENT_RICH) return false
  try {
    await (bot.api.raw as any).sendRichMessage({
      chat_id,
      ...(tid != null ? { message_thread_id: tid } : {}),
      ...baseOpts,
      rich_message: { markdown },
    })
    return true
  } catch (e) {
    process.stderr.write(`telegram daemon: sendRichMessage failed, falling back: ${e}\n`)
    return false
  }
}

async function sendAgentReply(
  chat_id: string,
  threadId: number | undefined,
  text: string,
  replyTo: number | undefined,
): Promise<void> {
  const tid = effectiveSendThreadId(threadId)
  const baseOpts = {
    ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
    ...(tid != null ? { message_thread_id: tid } : {}),
  }
  // Native rich message first (flagged); falls through to MarkdownV2/plain.
  if (await sendRich(chat_id, tid, text, baseOpts)) return
  // Prefer a single MarkdownV2 message so formatting renders; fall back to plain.
  const md = tgMarkdown(text)
  if (md != null && md.length <= MAX_CHUNK_LIMIT) {
    const ok = await bot.api
      .sendMessage(chat_id, md, { ...baseOpts, parse_mode: 'MarkdownV2' })
      .then(() => true)
      .catch(() => false)
    if (ok) return
  }
  const access = loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  const chunks = chunk(text, limit, mode)
  for (let i = 0; i < chunks.length; i++) {
    await bot.api
      .sendMessage(chat_id, chunks[i], {
        ...(i === 0 && replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
        ...(tid != null ? { message_thread_id: tid } : {}),
      })
      .catch(e => process.stderr.write(`telegram daemon: agent reply send failed: ${e}\n`))
  }
}

/** Stream an agent's reply into a single Telegram message: send a ⌛ placeholder,
 *  edit it (throttled) as text streams in, then render the final result —
 *  chunking the overflow into follow-up messages. */
async function streamAgentReply(
  chat_id: string,
  threadId: number | undefined,
  tkey: string | undefined,
  prompt: string,
  replyTo: number | undefined,
): Promise<void> {
  const tid = effectiveSendThreadId(threadId)
  const baseOpts = {
    ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
    ...(tid != null ? { message_thread_id: tid } : {}),
  }
  let mid: number | undefined
  const stopKb = new InlineKeyboard().text('⏹ Стоп', `stop:${chat_id}:${tkey ?? ''}`)
  // Шаг B (flagged): live streaming via sendRichMessageDraft. Private chats only
  // (the method takes a numeric private chat_id; supergroup ids are negative).
  // The ⌛ placeholder + Stop button stay for control and graceful fallback; the
  // draft is the animated rich preview, and the final persist is sendRich() below.
  const useDraft = AGENT_RICH && !chat_id.startsWith('-')
  const draft_id = nextDraftId()
  const escHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  try {
    const ph = await bot.api.sendMessage(chat_id, '💭 Думаю…', { ...baseOpts, reply_markup: stopKb })
    mid = ph.message_id
  } catch (e) {
    process.stderr.write(`telegram daemon: placeholder send failed: ${e}\n`)
  }

  // Throttle live edits. ~1s is the safe floor for editing one message; below
  // that Telegram starts returning 429. Configurable via TELEGRAM_STREAM_EDIT_MS.
  const EDIT_MS = Math.max(500, Number(process.env.TELEGRAM_STREAM_EDIT_MS) || 1000)
  const STREAM_CAP = 4000 // stay under the 4096 editMessageText limit while live
  let lastEdit = 0
  let lastShown = ''
  let lastBar = ''  // last text on the status+Stop placeholder (draft mode)
  let acc = ''     // streamed answer text so far
  let status = ''  // current activity (💭 thinking / ⚙️ tool) during gaps
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    if (mid == null) return
    // Show the answer text; while a tool/think runs with no new text, show the
    // activity (appended after any text, or alone before the first token).
    const base = acc ? (status ? `${acc}\n\n${status}` : acc) : (status || '💭 Думаю…')
    const body = base.length > STREAM_CAP ? base.slice(0, STREAM_CAP) + ' …' : base
    if (body === lastShown) return
    lastEdit = Date.now()
    lastShown = body
    if (useDraft) {
      // Keep the placeholder as a compact status+Stop bar (not a bare ⌛): show
      // the current activity, or "answering" once text flows. The animated rich
      // answer itself streams via the draft below; Stop lives on this bar.
      const bar = status || (acc ? '✍️ Отвечаю…' : '💭 Думаю…')
      if (mid != null && bar !== lastBar) {
        lastBar = bar
        bot.api.editMessageText(chat_id, mid, bar, { reply_markup: stopKb }).catch(() => {})
      }
      // Activity-only (no answer text yet) → native <tg-thinking> block; once text
      // streams → markdown. Partial markdown can be rejected mid-stream → fall back
      // to a plain edit on the bar so the live view never stalls.
      const rich =
        status && !acc
          ? { html: `<tg-thinking>${escHtml(status)}</tg-thinking>` }
          : { markdown: body }
      ;(bot.api.raw as any)
        .sendRichMessageDraft({
          chat_id: Number(chat_id),
          ...(tid != null ? { message_thread_id: tid } : {}),
          draft_id,
          rich_message: rich,
        })
        .catch(() => {
          if (mid != null) bot.api.editMessageText(chat_id, mid, body, { reply_markup: stopKb }).catch(() => {})
        })
      return
    }
    bot.api.editMessageText(chat_id, mid, body, { reply_markup: stopKb }).catch((e: unknown) => {
      // Ignore "message is not modified" (400); back off on rate limit (429).
      const ra = e instanceof GrammyError ? e.parameters?.retry_after : undefined
      if (ra) {
        lastEdit = Date.now() + ra * 1000
        process.stderr.write(`telegram daemon: stream edit rate-limited, retry_after=${ra}s\n`)
      }
    })
  }
  const schedule = () => {
    if (timer) return // trailing-edge throttle: guarantees the latest state shows
    timer = setTimeout(flush, Math.max(0, EDIT_MS - (Date.now() - lastEdit)))
  }
  const onDelta = (a: string) => { acc = a; status = ''; schedule() }
  const onStatus = (s: string) => { status = s; schedule() }

  let finalText: string
  try {
    finalText = await runAgentTurn(chat_id, tkey, prompt, { onDelta, onStatus })
  } catch (err) {
    finalText = `⚠️ agent error: ${err instanceof Error ? err.message : String(err)}`
  }
  if (timer) clearTimeout(timer)

  const access = loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  const body = finalText || '(empty)'

  // Native rich message first (flagged): send it, then drop the ⌛ placeholder.
  if (await sendRich(chat_id, tid, body, baseOpts)) {
    if (mid != null) await bot.api.deleteMessage(chat_id, mid).catch(() => {})
    return
  }

  // Final render: prefer a single MarkdownV2 message so formatting renders;
  // fall back to plain, chunked, on conversion/length/API failure.
  const md = tgMarkdown(body)
  if (md != null && md.length <= MAX_CHUNK_LIMIT) {
    const ok = mid != null
      ? await bot.api.editMessageText(chat_id, mid, md, { parse_mode: 'MarkdownV2' }).then(() => true).catch(() => false)
      : await bot.api.sendMessage(chat_id, md, { ...baseOpts, parse_mode: 'MarkdownV2' }).then(() => true).catch(() => false)
    if (ok) return
  }
  const chunks = chunk(body, limit, mode)
  if (mid != null) {
    await bot.api.editMessageText(chat_id, mid, chunks[0]).catch(() => {})
  } else {
    await bot.api.sendMessage(chat_id, chunks[0], baseOpts).catch(() => {})
  }
  for (let i = 1; i < chunks.length; i++) {
    await bot.api
      .sendMessage(chat_id, chunks[i], tid != null ? { message_thread_id: tid } : {})
      .catch(e => process.stderr.write(`telegram daemon: agent reply send failed: ${e}\n`))
  }
}

// ---- Permission-request tracking ------------------------------------------

type PendingPerm = {
  client_id: string
  tool_name: string
  description: string
  input_preview: string
}
const pendingPermissions = new Map<string, PendingPerm>()

// ---- RPC dispatch ---------------------------------------------------------

async function handleRpc(c: Client, id: string, method: string, params: Record<string, unknown>): Promise<void> {
  try {
    const result = await dispatchRpc(method, params, c)
    sendFrame(c, { type: 'rpc_response', id, ok: true, result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendFrame(c, { type: 'rpc_response', id, ok: false, error: msg })
  }
}

async function dispatchRpc(method: string, params: Record<string, unknown>, _c: Client): Promise<unknown> {
  switch (method) {
    case 'sendMessage': {
      const chat_id = String(params.chat_id)
      const text = String(params.text)
      const reply_to = params.reply_to != null ? Number(params.reply_to) : undefined
      const thread_id = effectiveSendThreadId(params.thread_id as string | number | undefined)
      const parseMode = params.parse_mode as 'MarkdownV2' | undefined
      const sent = await bot.api.sendMessage(chat_id, text, {
        ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(thread_id != null ? { message_thread_id: thread_id } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      return { message_id: sent.message_id }
    }
    case 'sendRichMessage': {
      // Bot API 10.1 rich message; markdown rendered natively (no chunking).
      // grammy has no typed method yet → raw proxy. Caller (server.ts) falls
      // back to chunked sendMessage if this throws.
      const chat_id = String(params.chat_id)
      const text = String(params.text)
      const reply_to = params.reply_to != null ? Number(params.reply_to) : undefined
      const thread_id = effectiveSendThreadId(params.thread_id as string | number | undefined)
      const sent = await (bot.api.raw as any).sendRichMessage({
        chat_id,
        ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(thread_id != null ? { message_thread_id: thread_id } : {}),
        rich_message: { markdown: text },
      })
      return { message_id: sent.message_id }
    }
    case 'sendPhoto':
    case 'sendDocument': {
      const chat_id = String(params.chat_id)
      const path = String(params.path)
      const reply_to = params.reply_to != null ? Number(params.reply_to) : undefined
      const thread_id = effectiveSendThreadId(params.thread_id as string | number | undefined)
      const input = new InputFile(path)
      const opts = {
        ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(thread_id != null ? { message_thread_id: thread_id } : {}),
      }
      const sent = method === 'sendPhoto'
        ? await bot.api.sendPhoto(chat_id, input, opts)
        : await bot.api.sendDocument(chat_id, input, opts)
      return { message_id: sent.message_id }
    }
    case 'setMessageReaction': {
      const chat_id = String(params.chat_id)
      const message_id = Number(params.message_id)
      const emoji = String(params.emoji) as ReactionTypeEmoji['emoji']
      await bot.api.setMessageReaction(chat_id, message_id, [{ type: 'emoji', emoji }])
      return { ok: true }
    }
    case 'editMessageText': {
      const chat_id = String(params.chat_id)
      const message_id = Number(params.message_id)
      const text = String(params.text)
      if (params.rich) {
        // Bot API 10.1: replace message content with a native rich message.
        const edited = await (bot.api.raw as any).editMessageText({
          chat_id,
          message_id,
          rich_message: { markdown: text },
        })
        const mid = typeof edited === 'object' ? edited.message_id : message_id
        return { message_id: mid }
      }
      const parseMode = params.parse_mode as 'MarkdownV2' | undefined
      const edited = await bot.api.editMessageText(chat_id, message_id, text,
        ...(parseMode ? [{ parse_mode: parseMode }] : []),
      )
      const mid = typeof edited === 'object' ? edited.message_id : message_id
      return { message_id: mid }
    }
    case 'getFile': {
      const file_id = String(params.file_id)
      const file = await bot.api.getFile(file_id)
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      return { file_path: file.file_path, file_unique_id: file.file_unique_id ?? '' }
    }
    case 'sendChatAction': {
      const chat_id = String(params.chat_id)
      const action = String(params.action) as 'typing'
      const thread_id = params.thread_id != null ? Number(params.thread_id) : undefined
      const opts = thread_id != null ? { message_thread_id: thread_id } : {}
      await bot.api.sendChatAction(chat_id, action, opts)
      return { ok: true }
    }
    case 'sendPermissionRequest': {
      const request_id = String(params.request_id)
      const tool_name = String(params.tool_name)
      const description = String(params.description)
      const input_preview = String(params.input_preview)
      pendingPermissions.set(request_id, { client_id: _c.id, tool_name, description, input_preview })
      const access = loadAccess()
      const text = `🔐 Permission: ${tool_name}`
      const keyboard = new InlineKeyboard()
        .text('See more', `perm:more:${request_id}`)
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      for (const chat_id of access.allowFrom) {
        void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
          process.stderr.write(`permission_request send to ${chat_id} failed: ${e}\n`)
        })
      }
      return { ok: true }
    }
    default:
      throw new Error(`unknown RPC method: ${method}`)
  }
}

// ---- IPC server ------------------------------------------------------------

const ipcServer = createNetServer(socket => {
  const c: Client = { id: clientId(), socket, claim: {}, rxBuf: '' }
  clients.set(c.id, c)
  process.stderr.write(`telegram daemon: ${c.id} connected\n`)

  socket.on('data', chunk => {
    c.rxBuf += chunk.toString('utf8')
    let nl = c.rxBuf.indexOf('\n')
    while (nl !== -1) {
      const line = c.rxBuf.slice(0, nl).trim()
      c.rxBuf = c.rxBuf.slice(nl + 1)
      nl = c.rxBuf.indexOf('\n')
      if (!line) continue
      let frame: ClientFrame
      try {
        frame = JSON.parse(line) as ClientFrame
      } catch (err) {
        process.stderr.write(`telegram daemon: ${c.id} sent invalid JSON: ${err}\n`)
        continue
      }
      handleClientFrame(c, frame)
    }
  })

  socket.on('close', () => {
    clients.delete(c.id)
    process.stderr.write(`telegram daemon: ${c.id} disconnected\n`)
  })

  socket.on('error', err => {
    process.stderr.write(`telegram daemon: ${c.id} socket error: ${err}\n`)
  })
})

function handleClientFrame(c: Client, frame: ClientFrame): void {
  switch (frame.type) {
    case 'register': {
      c.claim = frame.claim ?? {}
      const sid = frame.session_id ?? c.id
      process.stderr.write(`telegram daemon: ${c.id} registered session=${sid} claim=${JSON.stringify(c.claim)}\n`)
      sendFrame(c, { type: 'registered', session_id: sid })
      break
    }
    case 'deregister': {
      c.claim = {}
      break
    }
    case 'rpc': {
      void handleRpc(c, frame.id, frame.method, frame.params)
      break
    }
    case 'permission_request': {
      // Convenience alias for sendPermissionRequest RPC. Tracks origin.
      void handleRpc(c, `perm-${frame.request_id}`, 'sendPermissionRequest', {
        request_id: frame.request_id,
        tool_name: frame.tool_name,
        description: frame.description,
        input_preview: frame.input_preview,
      })
      break
    }
    default: {
      process.stderr.write(`telegram daemon: ${c.id} unknown frame: ${JSON.stringify(frame)}\n`)
    }
  }
}

ipcServer.on('error', err => {
  process.stderr.write(`telegram daemon: ipc server error: ${err}\n`)
  shutdown(1)
})

ipcServer.listen(SOCKET_PATH, () => {
  try { chmodSync(SOCKET_PATH, 0o600) } catch {}
  process.stderr.write(`telegram daemon: listening on ${SOCKET_PATH} pid=${process.pid}\n`)
})

// ---- Bot construction & inbound flow --------------------------------------

const bot = new Bot(TOKEN)
let botUsername = ''

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
  transcribe?: () => Promise<string | undefined>,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id

  // Permission-reply intercept: "yes xxxxx" / "no xxxxx" → resolve and route
  // back to the originating client.
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    const pp = pendingPermissions.get(request_id)
    if (pp) {
      const target = clients.get(pp.client_id)
      if (target) {
        sendFrame(target, {
          type: 'notification',
          method: 'notifications/claude/channel/permission',
          params: { request_id, behavior },
        })
      }
      pendingPermissions.delete(request_id)
    }
    if (msgId != null) {
      const emoji = behavior === 'allow' ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
    return
  }

  const typingOpts = threadId != null ? { message_thread_id: threadId } : {}
  void bot.api.sendChatAction(chat_id, 'typing', typingOpts).catch(() => {})

  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  // Voice/audio: transcribe locally (whisper.cpp) so the recognized speech
  // becomes the message text for BOTH the agent path and the MCP broadcast.
  // Runs before the multi-session branch so the agent gets the transcript, not
  // the "(voice message)" placeholder. Echoes 🎤«…» so the user sees what was
  // recognized. Falls back to placeholder + attachment if transcription is off.
  let content = text
  let attach = attachment
  if (transcribe) {
    const t = await transcribe()
    if (t) {
      content = t
      attach = undefined
      const echoTid = effectiveSendThreadId(threadId)
      // Await so the 🎤 echo lands BEFORE the agent's reply/placeholder.
      await bot.api
        .sendMessage(chat_id, `🎤 «${content}»`, echoTid != null ? { message_thread_id: echoTid } : {})
        .catch(() => {})
    }
  }

  // Multi-session: hand the message to this topic's own Claude agent and reply
  // back into the same topic. (Phase 1 ignores images/attachments — text only.)
  if (MULTI_SESSION) {
    const tkey = threadId != null ? String(threadId) : undefined

    // Coexistence: if a human session (claude --channels) is bound to this topic
    // — i.e. a connected client whose claim chat_id matches — let it handle the
    // message via the normal MCP broadcast below instead of the auto-agent.
    const humanBound = Array.from(clients.values()).some(
      c => c.claim.chat_id === chat_id && (!c.claim.thread_id || c.claim.thread_id === tkey),
    )
    if (!humanBound) {
      // Per-topic working directory: /cd <path> binds this topic to a folder
      // (starts a fresh session there); /pwd shows it.
      const cd = content.match(/^\/cd\s+(.+)$/)
      if (cd) {
        let dir = cd[1].trim()
        if (dir === '~' || dir.startsWith('~/')) dir = join(homedir(), dir.slice(1))
        try {
          const real = realpathSync(dir)
          if (!statSync(real).isDirectory()) throw new Error('не папка')
          setTopicCwd(chat_id, tkey, real)
          void sendAgentReply(chat_id, threadId, `📂 Рабочая папка топика: ${real}\nНачал новую сессию здесь.`, msgId)
        } catch (e) {
          void sendAgentReply(chat_id, threadId, `⚠️ Не могу перейти в «${dir}»: ${e instanceof Error ? e.message : String(e)}`, msgId)
        }
        return
      }
      if (/^\/pwd\s*$/.test(content)) {
        void sendAgentReply(chat_id, threadId, `📂 ${getTopicCwd(chat_id, tkey)}`, msgId)
        return
      }

      if (AGENT_STREAM) {
        void streamAgentReply(chat_id, threadId, tkey, content, msgId).catch(err => {
          process.stderr.write(`telegram daemon: agent stream failed: ${err}\n`)
        })
      } else {
        void runAgentTurn(chat_id, tkey, content)
          .then(reply => sendAgentReply(chat_id, threadId, reply, msgId))
          .catch(err => {
            process.stderr.write(`telegram daemon: agent turn failed: ${err}\n`)
            return sendAgentReply(
              chat_id,
              threadId,
              `⚠️ agent error: ${err instanceof Error ? err.message : String(err)}`,
              msgId,
            )
          })
      }
      return
    }
    // human-bound topic → fall through to the MCP broadcast below
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  broadcastNotification(
    'notifications/claude/channel',
    {
      content,
      meta: {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        ...(threadId != null ? { thread_id: String(threadId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attach ? {
          attachment_kind: attach.kind,
          attachment_file_id: attach.file_id,
          ...(attach.size != null ? { attachment_size: String(attach.size) } : {}),
          ...(attach.mime ? { attachment_mime: attach.mime } : {}),
          ...(attach.name ? { attachment_name: attach.name } : {}),
        } : {}),
      },
    },
    { chat_id, thread_id: threadId != null ? String(threadId) : undefined },
  )
}

// ---- Bot commands & handlers ----------------------------------------------

function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  const chatType = ctx.chat?.type
  if (chatType !== 'private') return null
  const from = ctx.from
  if (!from) return null
  return { access: loadAccess(), senderId: String(from.id) }
}

bot.command('start', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  await ctx.reply(
    `Hi! I'm a bridge to a Claude Code session.\n\n` +
    `If you're not paired yet, send any message and I'll reply with a code. ` +
    `The owner approves it from their terminal with /telegram:access pair <code>.`,
  )
})

bot.command('help', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  await ctx.reply(
    `/start — pairing instructions\n` +
    `/status — check your pairing state`,
  )
})

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
})

// Permission-button handler. allowFrom-gated to prevent strangers clicking
// buttons we accidentally sent them. When approved, sends the structured
// resolution back to the originating client.
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  // ⏹ Stop button on a streaming agent message: kill that topic's agent turn.
  const stopM = /^stop:([^:]*):(.*)$/.exec(data)
  if (stopM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const ok = stopTopic(stopM[1], stopM[2] || undefined)
    await ctx.answerCallbackQuery({ text: ok ? '⏹ Останавливаю…' : 'Уже завершено' }).catch(() => {})
    return
  }
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(details.input_preview), null, 2) }
    catch { prettyInput = details.input_preview }
    const expanded =
      `🔐 Permission: ${details.tool_name}\n\n` +
      `tool_name: ${details.tool_name}\n` +
      `description: ${details.description}\n` +
      `input_preview:\n${prettyInput}`
    const kb = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: kb }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  const pp = pendingPermissions.get(request_id)
  if (pp) {
    const target = clients.get(pp.client_id)
    if (target) {
      sendFrame(target, {
        type: 'notification',
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
    }
    pendingPermissions.delete(request_id)
  }
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await bot.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) return undefined
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.includes('.') ? file.file_path.split('.').pop()!.replace(/[^a-zA-Z0-9]/g, '') : 'jpg'
      const uniq = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      mkdirSync(INBOX_DIR, { recursive: true })
      const path = join(INBOX_DIR, `${Date.now()}-${uniq}.${ext}`)
      writeFileSync(path, buf)
      return path
    } catch { return undefined }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
  }, () => transcribeAudio(voice.file_id))
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`, undefined, {
    kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
  }, () => transcribeAudio(audio.file_id))
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note', file_id: vn.file_id, size: vn.file_size,
  }, () => transcribeAudio(vn.file_id))
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size,
  })
})

// ---- Approved-dir watcher --------------------------------------------------
// /telegram:access pair drops a file in APPROVED_DIR/<senderId> with chatId
// as content. We send "you're in" and remove the marker.

function processApproved(): void {
  let entries: string[]
  try { entries = readdirSync(APPROVED_DIR) } catch { return }
  for (const senderId of entries) {
    const path = join(APPROVED_DIR, senderId)
    let chatId = ''
    try { chatId = readFileSync(path, 'utf8').trim() } catch { continue }
    if (!chatId) chatId = senderId
    void bot.api.sendMessage(chatId,
      'You are paired. Future messages will reach Claude Code.',
    ).catch(e => process.stderr.write(`approved notify ${senderId} failed: ${e}\n`))
    try { rmSync(path) } catch {}
  }
}

mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 })
processApproved()
try {
  watch(APPROVED_DIR, () => processApproved())
} catch (err) {
  process.stderr.write(`telegram daemon: APPROVED_DIR watch failed: ${err}\n`)
}

// ---- Polling loop ----------------------------------------------------------

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram daemon: polling as @${info.username}\n`)
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        process.stderr.write(
          `telegram daemon: 409 Conflict persists after ${attempt} attempts — ` +
          `another poller holds the bot token. Exiting.\n`,
        )
        shutdown(1)
      }
      const delay = Math.min(1000 * attempt, 15000)
      const detail = is409 ? `409 Conflict` : `polling error: ${err}`
      process.stderr.write(`telegram daemon: ${detail}, retrying in ${delay / 1000}s\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
