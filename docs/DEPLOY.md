# Deploy: always-on multi-session daemon

Run the Telegram daemon as a background service so it survives reboots and
crashes, with one Claude or Codex agent per topic.

## Prerequisites

- [Bun](https://bun.sh) — the daemon runs on Bun.
- A bot token from @BotFather (see [README](../README.md)).
- For voice transcription (optional): `brew install whisper-cpp ffmpeg` and a
  model — see `/telegram:configure model` or [README](../README.md).
- The `claude` or `codex` CLI logged in, depending on `TELEGRAM_AGENT_PROVIDER`.

## 1. Configure `~/.claude/channels/telegram/.env`

```sh
TELEGRAM_BOT_TOKEN=123456789:AAH...           # from BotFather (required)

# Multi-session agents (one CLI agent per topic):
TELEGRAM_MULTI_SESSION=1

# Claude mode (default):
# TELEGRAM_AGENT_PROVIDER=claude
TELEGRAM_CLAUDE_BIN=/Users/you/.local/bin/claude   # absolute path to claude
TELEGRAM_AGENT_PERMISSION_MODE=auto           # auto classifier (needs Opus/Sonnet 4.6+)
TELEGRAM_AGENT_MODEL=opus                      # auto mode requires a capable model

# Codex mode:
# TELEGRAM_AGENT_PROVIDER=codex
# TELEGRAM_CODEX_BIN=/Users/you/.local/bin/codex
# TELEGRAM_AGENT_MODEL=gpt-5.5                  # optional
# TELEGRAM_CODEX_PROFILE=<profile>              # optional, first turn only
# TELEGRAM_CODEX_DANGEROUS_BYPASS=1             # default in Codex mode

TELEGRAM_AGENT_CWD=/Users/you/agent-workspace # default working dir (NOT under ~/.claude)
TELEGRAM_STREAM_EDIT_MS=600                    # live-edit throttle (~1s floor vs 429)
# TELEGRAM_AGENT_BATCH_MS=1500                 # debounce quick text bursts into one agent turn
# TELEGRAM_AGENT_FILE_BATCH_MS=6000            # wait for file batches/albums before replying
# TELEGRAM_AGENT_INBOX_DIR=/Users/you/inbox    # optional; default is <topic cwd>/.telegram-inbox

# TELEGRAM_AGENT_SANDBOX=1   # optional: macOS sandbox-exec, confine writes to the
                            # topic's cwd (+ ~/.claude, ~/.codex, temp).
                            # Defense-in-depth on top of CLI policy. Experimental.

# Voice (optional):
WHISPER_MODEL=/Users/you/.claude/channels/telegram/models/ggml-large-v3-turbo-q5_0.bin
# WHISPER_LANG=ru          # default: auto
# TELEGRAM_VOICE_KEEP=1    # keep the OGG recordings (default: delete after transcribe)
```

All `TELEGRAM_AGENT_*` knobs are optional except the token; defaults are sane for
Claude mode. In Codex mode, dangerous approval+sandbox bypass is enabled by
default; set `TELEGRAM_CODEX_DANGEROUS_BYPASS=0` to use Codex's normal sandbox
on newly-created topic sessions.
**`TELEGRAM_AGENT_CWD` must be outside `~/.claude`** (Claude Code blocks writes
to its own config dir).

## 2. Install the launchd service (macOS)

Copy [`deploy/telegram-daemon.plist.template`](../deploy/telegram-daemon.plist.template)
to `~/Library/LaunchAgents/com.<you>.telegram-daemon.plist`, replacing the
`__PLACEHOLDERS__` (your home, the repo path, the absolute `bun` path, and a
PATH that includes Homebrew + bun + the selected agent CLI dir). Then:

```sh
launchctl load -w ~/Library/LaunchAgents/com.<you>.telegram-daemon.plist
```

`RunAtLoad` starts it now and at login; `KeepAlive` restarts it on crash.

## 3. Manage it

```sh
# status (PID + last exit code)
launchctl list | grep telegram-daemon
# follow logs
tail -f ~/.claude/channels/telegram/daemon.log
# restart to pick up new code (NOT pkill — launchd would just respawn it)
launchctl kickstart -k gui/$(id -u)/com.<you>.telegram-daemon
# stop and disable autostart
launchctl unload ~/Library/LaunchAgents/com.<you>.telegram-daemon.plist
```

## Using it from Telegram

- Open a **new topic** → a fresh Claude/Codex agent with its own context. Same topic →
  resumed memory.
- **`/cd <path>`** in a topic binds that topic to a working directory (starts a
  fresh session there) — point it at a repo to code on it. **`/pwd`** shows it.
- Send a **voice message** → it's transcribed locally and handled as text.
- Claude mode can run in **auto mode** via `TELEGRAM_AGENT_PERMISSION_MODE`.
  Codex mode defaults to `--dangerously-bypass-approvals-and-sandbox`, so only
  enable it for chats/users you trust and preferably point topics at disposable
  worktrees.

## Coexistence with a live session

If you attach a human session bound to a topic
(`TELEGRAM_CHAT_ID=… TELEGRAM_TOPIC=… claude --channels plugin:telegram@…`), the
daemon routes that topic to your live session instead of the auto-agent.
