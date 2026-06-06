# Deploy: always-on multi-session daemon

Run the Telegram daemon as a background service so it survives reboots and
crashes, with one Claude agent per topic.

## Prerequisites

- [Bun](https://bun.sh) — the daemon runs on Bun.
- A bot token from @BotFather (see [README](../README.md)).
- For voice transcription (optional): `brew install whisper-cpp ffmpeg` and a
  model — see `/telegram:configure model` or [README](../README.md).
- The `claude` CLI logged in (the agents run on your Claude subscription).

## 1. Configure `~/.claude/channels/telegram/.env`

```sh
TELEGRAM_BOT_TOKEN=123456789:AAH...           # from BotFather (required)

# Multi-session agents (one Claude agent per topic):
TELEGRAM_MULTI_SESSION=1
TELEGRAM_CLAUDE_BIN=/Users/you/.local/bin/claude   # absolute path to claude
TELEGRAM_AGENT_PERMISSION_MODE=auto           # auto classifier (needs Opus/Sonnet 4.6+)
TELEGRAM_AGENT_MODEL=opus                      # auto mode requires a capable model
TELEGRAM_AGENT_CWD=/Users/you/agent-workspace # default working dir (NOT under ~/.claude)
TELEGRAM_STREAM_EDIT_MS=600                    # live-edit throttle (~1s floor vs 429)

# Voice (optional):
WHISPER_MODEL=/Users/you/.claude/channels/telegram/models/ggml-large-v3-turbo-q5_0.bin
# WHISPER_LANG=ru          # default: auto
# TELEGRAM_VOICE_KEEP=1    # keep the OGG recordings (default: delete after transcribe)
```

All `TELEGRAM_AGENT_*` knobs are optional except the token; defaults are sane.
**`TELEGRAM_AGENT_CWD` must be outside `~/.claude`** (Claude Code blocks writes
to its own config dir).

## 2. Install the launchd service (macOS)

Copy [`deploy/telegram-daemon.plist.template`](../deploy/telegram-daemon.plist.template)
to `~/Library/LaunchAgents/com.<you>.telegram-daemon.plist`, replacing the
`__PLACEHOLDERS__` (your home, the repo path, the absolute `bun` path, and a
PATH that includes Homebrew + bun + the claude bin dir). Then:

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

- Open a **new topic** → a fresh Claude agent with its own context. Same topic →
  resumed memory.
- **`/cd <path>`** in a topic binds that topic to a working directory (starts a
  fresh session there) — point it at a repo to code on it. **`/pwd`** shows it.
- Send a **voice message** → it's transcribed locally and handled as text.
- The agent runs in **auto mode**: it does routine work autonomously and refuses
  genuinely dangerous actions (explaining why); re-authorize explicitly if needed.

## Coexistence with a live session

If you attach a human session bound to a topic
(`TELEGRAM_CHAT_ID=… TELEGRAM_TOPIC=… claude --channels plugin:telegram@…`), the
daemon routes that topic to your live session instead of the auto-agent.
