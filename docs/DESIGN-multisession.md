# Multi-session: one Claude agent per Telegram topic

**Status:** Approved design — implementation in progress (Phase 1).
**Date:** 2026-06-06.
**Implements:** the README's stated next milestone — *"Multi-session support (one bot
driving several concurrent Claude Code sessions, each bound to a topic)."*

---

## 1. Goal

A **new Telegram topic = a new, independent Claude agent ("a new chat")** with its
own context. Messages in an existing topic continue that topic's agent (memory
preserved). The daemon auto-spawns and manages these agents and routes replies
back to the originating topic.

Constraints (from the owner):
- Runs on a **Claude subscription, no `ANTHROPIC_API_KEY`**.
- Agents are **coding-capable** (filesystem / bash) within a configured working dir.
- Behaviour the user cares about: *new topic → fresh chat; same topic → remembered chat.*

---

## 2. Current state and the gap

- `daemon.ts` owns the bot (polling), the access **gate**, **routing** by claim
  `(chat_id, thread_id)`, outbound **RPC**, and a Telegram **permission-approval
  relay** (inline keyboards).
- `server.ts` is a per-`claude`-session MCP client: it registers a claim and
  consumes inbound notifications.
- Today a single session registers `claim={}` (catch-all) → **all topics funnel
  into one context**. `thread_id` only routes the reply/typing; it does **not**
  isolate context.
- **Gap:** nothing auto-spawns a per-topic agent. The claim routing is the
  foundation; the *supervisor* is what's missing.

---

## 3. The finding that shapes the design

Claude Code **channels are interactive-only.** Headless `claude -p` (one-shot)
does **not** activate channel injection (confirmed empirically: three `-p`
probes showed no channel activation; only an interactive TTY session received an
injected Telegram message). A `--dangerously-load-development-channels` ref that
doesn't resolve is **silently ignored** (a bogus `@marketplace` produced no
error), so "no error" never meant "activated".

⇒ "Supervisor spawns headless channel sessions" stands on an unsupported pty
hack. The robust, subscription-compatible path is to **drive the `claude` CLI
directly** (prompt in → output out) with `--resume` for memory — **no channels**
for the auto-spawned agents.

---

## 4. Locked decisions

| Decision | Choice |
|---|---|
| Granularity | one session per `(chat_id, thread_id)`; DM/chat without a topic → keyed by `chat_id` (thread_id undefined) |
| Auth / billing | **subscription**, via the locally-authenticated `claude` CLI; no API key |
| Engine (v1) | **"cold":** per message run `claude -p --resume <sid>` (first run `--session-id <uuid>`). Same memory as warm (resume replays the full transcript); simplest, guaranteed subscription |
| Engine (later) | optional **"warm":** persistent process via `--input-format stream-json` (chadingTV model) if cold-start latency / cost on long topics hurts |
| Working dir | one configurable base dir per agent; agent may navigate within the chat. Future: **git-worktree per topic** (ccgram model) for parallel isolation |
| Concurrency | **serialize turns within a topic** (per-topic queue); parallel across topics |
| Persistence | durable map `(chat_id,thread_id) → session_id` on disk; reattach via `--resume` after daemon restart |
| Security | sandbox to the working dir, reuse the existing **Telegram permission relay** for dangerous tools, per-topic **auto-approve** toggle, sender-allowlist (already present), **fail-closed** defaults |
| Coexistence | if a **human** session has claimed a topic (`--channels`), route to the human; else the auto-agent handles it |

---

## 5. Chosen architecture

```
Telegram ──poll──> daemon.ts
                     ├── gate()                         (reuse: access control)
                     ├── coexistence check: human claim for this topic? → route to human
                     └── AgentRunner (multi-session)
                            ├── SessionStore: (chat,thread) → {sessionId, cwd}  [persisted]
                            ├── per-topic Queue (serialize turns)
                            └── spawn  claude -p --resume <sid>  (cwd=agent dir, subscription)
                                   prompt = inbound text
                                   stdout(JSON).result ──> sendReply ──> bot.api → same topic
```

**Message flow**
1. Inbound message → `gate()` (reuse). Drop / pair as today.
2. If multi-session mode is on and no human session claims this topic:
3. `key = (chat_id, thread_id)`. Look up `SessionStore`.
   - **new topic** → generate a UUID, run `claude -p --session-id <uuid>`.
   - **known topic** → run `claude -p --resume <uuid>`.
4. Feed the message as the prompt (via stdin), `--output-format json`, `cwd` =
   the topic's working dir, `--permission-mode <configured>`.
5. Parse `.result`, send it back to the **same topic** (reuse `chunk()` +
   `effectiveSendThreadId`). Errors → an error notice in the topic + daemon log.
6. Turns within one topic are **serialized** via a per-topic queue; topics run
   in parallel.

---

## 6. Options considered

| Option | What | Verdict |
|---|---|---|
| **A** — live `claude` per topic via **channel + pty** | persistent interactive session, channel injection | ❌ depends on unsupported pty/headless-channel; fragile |
| **A′** — `claude -p --resume` per message | cold spawn, memory via resume | ✅ **v1** — simple, subscription-guaranteed |
| **A″** — warm `claude --input-format stream-json` | live process, we push messages | ✅ **v2 upgrade** — warm context, no channels |
| **B** — Agent SDK in-daemon | `@anthropic-ai/claude-agent-sdk`, custom tools | ✅ viable on subscription (chadingTV proves it); cleaner code, revisit for warm |
| **tmux** — drive real `claude` in tmux windows | ccbot/ccgram model | ⚠️ works (owner already runs ccbot) but diverges from this fork's MCP/daemon architecture |

A and A″ differ in **process lifetime** (warm vs cold) and **whether channels are
used**; A′ avoids channels entirely. Memory is equivalent across A′/A″/B —
`--resume`/SDK replay the full saved transcript.

---

## 7. Prior art (researched analogues)

| Repo | Platform | Runtime | Per-topic session | Subscription | Safety |
|---|---|---|---|---|---|
| [six-ddc/ccbot](https://github.com/six-ddc/ccbot) | TG | tmux + real `claude`, `--resume` | topic→tmux window; JSON state + SessionStart hook | yes | Claude's own prompts → inline kb |
| [alexei-led/ccgram](https://github.com/alexei-led/ccgram) | TG | tmux, multi-agent | topic→window; **git-worktree per topic** | yes | inline-kb approvals + shell confirm |
| [fredchu/discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) | DC | **`claude -p --session-id/--resume`** | **SQLite** thread→UUID | yes | AskUserQuestion→buttons |
| [RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) | TG | **Agent SDK** (CLI fallback) | SQLite + in-mem; `ENABLE_PROJECT_THREADS` | key **or** CLI login | dir sandbox + tool allowlist + cost caps |
| [chadingTV/claudecode-discord](https://github.com/chadingTV/claudecode-discord) | DC | **daemon + Agent SDK** | SQLite; channel→folder; per-channel queue | **yes, no key** | per-action buttons + auto-approve; 0 ports |
| [avivsinai/telclaude](https://github.com/avivsinai/telclaude) | TG | CLI in OS/Docker sandbox | per-chat; relay-owned memory | key/CLI | **tiers + LLM pre-screen + nonce approval, fail-closed** |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) (telegram) | TG | MCP bridge to existing session | **none (the gap)** | yes (host session) | access.json pairing/allowlist |

**Closest to our goal:** chadingTV (daemon + subscription + per-thread isolation
+ approval relay — the direction our `daemon.ts`/`server.ts` split already heads)
and ccgram (worktree-per-topic). fredchu is the cleanest minimal `-p --resume`
reference.

**Lessons adopted:** durable topic→session map; spawn the locally-authenticated
`claude` (no API key); per-topic cwd/worktree; serialize per topic; relay
permission prompts as inline keyboards with a per-topic auto-approve toggle;
recovery UX; per-topic cost guards. **Avoid:** `--dangerously-skip-permissions`
to dodge headless approval; feeding all of a chat into one agent.

---

## 8. Phased plan

1. **v1 (cold, working):** `SessionStore` + spawn `claude -p --resume` from the
   daemon + reply to the topic, behind a `TELEGRAM_MULTI_SESSION` flag.
2. **Robustness:** per-topic queue hardening + crash recovery (agent died →
   recreate on next message) + coexistence with human `--channels` sessions.
3. **Security:** sandbox the working dir + per-topic `auto-approve` toggle layered
   over the existing permission relay; fail-closed defaults; cost/rate guards.
4. **(Optional) Warm + isolation:** persistent `stream-json` sessions with idle
   eviction; git-worktree per topic.

---

## 9. Risks & mitigations

- **Autonomous agent on untrusted chat input (prompt injection).** → sandboxed
  cwd, permission relay for dangerous tools, fail-closed, sender-allowlist.
- **Cold-start latency / token cost on long topics.** → warm upgrade (Phase 4);
  per-topic cost guards.
- **Concurrent turns corrupting a session.** → per-topic serialized queue;
  never run two `--resume <same sid>` at once.
- **`claude` not on the daemon's PATH** (daemon is spawned detached). → configurable
  `TELEGRAM_CLAUDE_BIN`, resolve absolute path.
- **Orphaned processes** (observed: `server.ts` spun at ~98% CPU after a `-p`
  parent exited). → ensure agent child processes are awaited/reaped; add timeouts.
- **Local-only persistence** has no backup; a corrupt map orphans topics → atomic
  writes + move-aside-on-corrupt (same pattern as `access.json`).

---

## 10. Configuration (proposed)

Env (or `access.json` keys later):
- `TELEGRAM_MULTI_SESSION=1` — enable the auto-agent mode.
- `TELEGRAM_AGENT_CWD=<dir>` — base working directory for agents. **Must be
  outside `~/.claude`** — Claude Code blocks writes to its own config dir as
  "sensitive", so an agent cwd inside it cannot create files. Default:
  `~/telegram-agent-workspace`. Point it at a real repo for coding work.
- `TELEGRAM_AGENT_PERMISSION_MODE=<mode>` — default `acceptEdits` (v1).
- `TELEGRAM_AGENT_MODEL=<model>` — optional model override.
- `TELEGRAM_CLAUDE_BIN=<path>` — path to the `claude` binary (default `claude`).
