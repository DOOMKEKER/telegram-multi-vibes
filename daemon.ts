#!/usr/bin/env bun
/**
 * Telegram channel daemon for Claude Code (Phase 2 scaffold).
 *
 * Long-running process that owns the Telegram bot's getUpdates slot. MCP
 * servers from individual `claude` sessions connect over a Unix socket as
 * clients, register a (chat_id, thread_id) claim, and exchange:
 *   - notifications: daemon → client when an inbound message matches the claim
 *   - RPC: client → daemon for outbound (sendMessage, react, edit, getFile)
 *
 * This file currently only implements the IPC layer + lifecycle. Bot
 * ownership and routing follow in subsequent commits.
 */

import { createServer, type Socket } from 'net'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')
const PID_FILE = join(STATE_DIR, 'daemon.pid')

// ---- Wire protocol shared with server.ts (the MCP client) ----------------

/** Claim describes which inbound messages a client wants to receive. */
export type Claim = {
  /** Telegram chat_id (numeric, but always serialized as string). Omit to
   *  match any chat. */
  chat_id?: string
  /** Telegram message_thread_id. Omit to match any thread. Combined with
   *  chat_id this identifies a specific forum topic in a DM (Threaded
   *  Mode) or supergroup. */
  thread_id?: string
}

export type ClientFrame =
  | { type: 'register'; claim: Claim; session_id?: string }
  | { type: 'deregister' }
  | { type: 'rpc'; id: string; method: string; params: unknown }

export type DaemonFrame =
  | { type: 'registered'; session_id: string }
  | { type: 'rpc_response'; id: string; ok: true; result: unknown }
  | { type: 'rpc_response'; id: string; ok: false; error: string }
  | { type: 'notification'; method: string; params: unknown }

// ---- Single-instance lifecycle ---------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// Replace any stale daemon (left over from a previous crash) so the new one
// can bind the socket cleanly. Never SIGKILL — give the existing daemon
// SIGTERM and trust it to exit; we'll fall through to socket bind below.
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    try {
      process.kill(stale, 0)
      process.stderr.write(`telegram daemon: replacing stale daemon pid=${stale}\n`)
      process.kill(stale, 'SIGTERM')
      // Give the stale daemon a moment to release the socket.
      await new Promise(r => setTimeout(r, 500))
    } catch { /* not running */ }
  }
} catch { /* no PID file */ }

// Stale socket file from an unclean shutdown blocks listen(). Remove it
// proactively — if a daemon was actually still listening we already
// SIGTERMed it above.
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH) } catch {}
}

writeFileSync(PID_FILE, String(process.pid))

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

function shutdown(code: number): never {
  try { server.close() } catch {}
  try { unlinkSync(SOCKET_PATH) } catch {}
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (pid === process.pid) unlinkSync(PID_FILE)
  } catch {}
  process.exit(code)
}

// ---- Client registry -------------------------------------------------------

type Client = {
  id: string
  socket: Socket
  claim: Claim
  /** Buffer for partial frames split across socket chunks. */
  rxBuf: string
}

const clients = new Map<string, Client>()
let nextClientId = 1

function clientId(): string {
  return `c${nextClientId++}`
}

function sendFrame(c: Client, frame: DaemonFrame): void {
  try {
    c.socket.write(JSON.stringify(frame) + '\n')
  } catch (err) {
    process.stderr.write(`telegram daemon: write to ${c.id} failed: ${err}\n`)
  }
}

function handleClientFrame(c: Client, frame: ClientFrame): void {
  switch (frame.type) {
    case 'register': {
      c.claim = frame.claim ?? {}
      const sid = frame.session_id ?? c.id
      process.stderr.write(
        `telegram daemon: ${c.id} registered session=${sid} claim=${JSON.stringify(c.claim)}\n`,
      )
      sendFrame(c, { type: 'registered', session_id: sid })
      break
    }
    case 'deregister': {
      // Wait for the socket to close naturally. Just clear the claim so the
      // daemon doesn't route to a client that's about to disappear.
      c.claim = {}
      break
    }
    case 'rpc': {
      // Bot wiring lands in a later commit. For now reject every RPC so the
      // client surfaces a clear error rather than hanging.
      sendFrame(c, {
        type: 'rpc_response',
        id: frame.id,
        ok: false,
        error: 'daemon RPC not implemented yet (Phase 2 scaffold)',
      })
      break
    }
    default: {
      // Unknown frame type — log and ignore. Don't disconnect.
      process.stderr.write(
        `telegram daemon: ${c.id} sent unknown frame type: ${JSON.stringify(frame)}\n`,
      )
    }
  }
}

// ---- Socket server ---------------------------------------------------------

const server = createServer(socket => {
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
        process.stderr.write(
          `telegram daemon: ${c.id} sent invalid JSON: ${err}; line=${line.slice(0, 200)}\n`,
        )
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

server.on('error', err => {
  process.stderr.write(`telegram daemon: server error: ${err}\n`)
  shutdown(1)
})

server.listen(SOCKET_PATH, () => {
  // Restrict access to the owner. Without this, any local user could connect
  // and impersonate a Claude session.
  try {
    require('fs').chmodSync(SOCKET_PATH, 0o600)
  } catch {}
  process.stderr.write(
    `telegram daemon: listening on ${SOCKET_PATH} pid=${process.pid}\n`,
  )
})
