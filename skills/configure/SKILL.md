---
name: configure
description: Set up the Telegram channel — save the bot token, choose the voice-transcription (Whisper) model, and review access policy. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up" / "who can reach me", wants to pick or download a Whisper model for voice messages, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(curl *)
  - Bash(test *)
  - Bash(which *)
---

# /telegram:configure — Telegram Channel Setup

Writes the bot token to `~/.claude/channels/telegram/.env` and orients the
user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/telegram/.env` for
   `TELEGRAM_BOT_TOKEN`. Show set/not-set; if set, show first 10 chars masked
   (`123456789:...`).

2. **Access** — read `~/.claude/channels/telegram/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes and display names if any

3. **Voice** — report whether voice transcription is enabled: check `WHISPER_MODEL`
   in `.env`, and whether `whisper-cli` and `ffmpeg` are on PATH (`which`). Show
   on/off and which model. If off, mention `/telegram:configure model <name>` to
   pick and download a model.

4. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/telegram:configure <token>` with the token from
     BotFather."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Telegram. It replies with a code; approve with `/telegram:access pair
     <code>`."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture Telegram user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/telegram:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them DM the bot; you'll approve
   each with `/telegram:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to give you their numeric ID
   (have them message @userinfobot), or you can briefly flip to pairing:
   `/telegram:access policy pairing` → they DM → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string.
2. `mkdir -p ~/.claude/channels/telegram`
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 ~/.claude/channels/telegram/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.

### `model [name]` — choose / download the voice-transcription model

Voice messages are transcribed locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
(audio never leaves the machine, no API key). This picks the model and writes
`WHISPER_MODEL` to `.env`.

**Curated models** (whisper.cpp GGUF, from `huggingface.co/ggerganov/whisper.cpp`):

| name | file | size | notes |
| --- | --- | --- | --- |
| `turbo` | `ggml-large-v3-turbo.bin` | ~1.6 GB | best quality, fast on Apple Silicon (**recommended**) |
| `turbo-q5` | `ggml-large-v3-turbo-q5_0.bin` | ~574 MB | smaller, slightly lower quality |
| `medium` | `ggml-medium.bin` | ~1.5 GB | older multilingual |
| `small` | `ggml-small.bin` | ~488 MB | faster, lower quality |
| `base` | `ggml-base.bin` | ~148 MB | fastest, basic quality |

Base URL: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`

**No name** — list the table above and show the current `WHISPER_MODEL` (if set).

**`<name>`** — set it up:

1. Map `<name>` to its file via the table. If unknown, show the table and stop.
2. Check deps: `which whisper-cli` and `which ffmpeg`. If either is missing, tell
   the user to run `brew install whisper-cpp ffmpeg` first, then re-run this.
3. `mkdir -p ~/.claude/channels/telegram/models`.
4. If the file already exists (`test -f`), skip the download. Otherwise download
   it (warn it's a large file): `curl -fL -o ~/.claude/channels/telegram/models/<file> <url>`.
5. Read existing `.env`; set/replace `WHISPER_MODEL=` with the absolute path
   `~/.claude/channels/telegram/models/<file>` (preserve other keys, no quotes).
   `chmod 600` the file.
6. Optional: mention `WHISPER_LANG` (default `auto`; e.g. `ru` to force Russian)
   and `TELEGRAM_VOICE_KEEP=1` (keep the OGG recordings instead of deleting them).
7. Say the daemon must be restarted to pick up the new model.

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/telegram:access` take effect immediately, no restart.
