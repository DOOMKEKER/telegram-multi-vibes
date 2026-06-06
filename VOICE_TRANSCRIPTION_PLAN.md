# План: транскрипция голосовых сообщений Telegram → запрос Claude

## Context

Хочется отправлять боту **голосовое сообщение**, чтобы оно распознавалось в текст и
выполнялось Claude **как если бы это был напечатанный запрос**. Сейчас демон
(`daemon.ts:852`) при получении `voice` отдаёт Claude буквальный плейсхолдер
`(voice message)` + `attachment_file_id` — то есть голос игнорируется как запрос.

Решение: распознавать речь **внутри демона** локально через **whisper.cpp** (аудио не
покидает Mac, без API-ключей, бесплатно) и подставлять транскрипт в поле `content`
уведомления `notifications/claude/channel`. Поскольку Claude видит `content` как текст
сообщения внутри `<channel>`, транскрипт попадает в сессию ровно как обычный текстовый
запрос — тот же gate, та же маршрутизация. Дополнительно бот эхо-отправляет распознанный
текст (`🎤 «...»`), чтобы было видно, что именно распозналось.

Почему не DeepSeek/облако: у DeepSeek нет API распознавания речи; выбран локальный
приватный вариант.

## Архитектура (куда встраиваемся)

- `daemon.ts` владеет ботом и polling'ом; `handleInbound()` (daemon.ts:624) формирует
  `content`, который Claude видит как текст. Есть готовый паттерн **ленивой загрузки
  файла после прохождения gate** — callback `downloadImage` (вызывается на daemon.ts:683).
  Транскрипцию вешаем туда же: считаем её только для доставленных сообщений.
- Паттерн скачивания файла Telegram уже есть в обработчике фото (daemon.ts:826-838):
  `bot.api.getFile(file_id)` → `fetch(https://api.telegram.org/file/bot<TOKEN>/<file_path>)`
  → `Buffer` → запись в `INBOX_DIR`. Повторяем его для OGG.
- `.env` (`~/.claude/channels/telegram/.env`) автоматически грузится в `process.env`
  (daemon.ts:52-58) — новые настройки whisper кладём туда, новый механизм не нужен.
- `server.ts` **не меняется** (транскрипция целиком server-side в демоне).

## Внешние зависимости (ставит пользователь, разово)

```bash
brew install whisper-cpp ffmpeg          # whisper-cli + конвертер аудио
mkdir -p ~/.claude/channels/telegram/models
curl -L -o ~/.claude/channels/telegram/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

- `large-v3-turbo` (~1.6 ГБ): отличный русский + быстро на Apple Silicon. Альтернативы:
  `ggml-large-v3-turbo-q5_0.bin` (~574 МБ, чуть хуже) или `ggml-medium.bin`.
- `ffmpeg` нужен, т.к. `whisper-cli` принимает только 16 кГц mono WAV, а Telegram шлёт
  OGG/Opus — конвертируем `ogg → wav` перед распознаванием.

Добавить в `~/.claude/channels/telegram/.env`:
```
WHISPER_MODEL=/Users/mecha/.claude/channels/telegram/models/ggml-large-v3-turbo.bin
# опционально (значения по умолчанию):
# WHISPER_CLI=whisper-cli
# WHISPER_LANG=auto        # auto | ru | en ...
# FFMPEG=ffmpeg
```
Если `WHISPER_MODEL` не задан или бинарь не найден — поведение откатывается к текущему
(`(voice message)` + attachment), ничего не ломается.

## Изменения в коде (только `daemon.ts`)

### 1. Импорты для запуска подпроцессов
Добавить к существующим импортам:
```ts
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileP = promisify(execFile)
```

### 2. Хелпер транскрипции (рядом с другими helpers, ~daemon.ts:239+)
```ts
async function transcribeAudio(file_id: string): Promise<string | undefined> {
  const model = process.env.WHISPER_MODEL
  if (!model || !existsSync(model)) return undefined
  const whisperBin = process.env.WHISPER_CLI ?? 'whisper-cli'
  const ffmpegBin  = process.env.FFMPEG ?? 'ffmpeg'
  const lang       = process.env.WHISPER_LANG ?? 'auto'
  try {
    const file = await bot.api.getFile(file_id)
    if (!file.file_path) return undefined
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const uniq = (file.file_unique_id ?? 'dl').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    const base = join(INBOX_DIR, `${Date.now()}-${uniq}`)
    const ogg = `${base}.ogg`, wav = `${base}.wav`
    writeFileSync(ogg, buf)
    await execFileP(ffmpegBin, ['-y', '-i', ogg, '-ar', '16000', '-ac', '1', wav])
    const { stdout } = await execFileP(
      whisperBin, ['-m', model, '-f', wav, '-l', lang, '-nt', '-np'],
      { maxBuffer: 10 * 1024 * 1024 },
    )
    try { unlinkSync(wav) } catch {}            // ogg оставляем в inbox как артефакт
    const txt = stdout.replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean).join(' ').trim()
    return txt || undefined
  } catch (e) {
    process.stderr.write(`telegram daemon: transcribe failed: ${e}\n`)
    return undefined
  }
}
```
(`-nt` = без таймстампов, `-np` = без служебного вывода → в stdout чистый текст.)

### 3. `handleInbound`: добавить параметр `transcribe` + эхо (daemon.ts:624-708)
- Сигнатура: добавить `transcribe?: () => Promise<string | undefined>` (по аналогии с `downloadImage`).
- После строки `const imagePath = ... await downloadImage() ...` (daemon.ts:683) вставить:
```ts
let content = text
let attach = attachment
if (transcribe) {
  const t = await transcribe()
  if (t) {
    content = t
    attach = undefined                          // распознали → Claude не качает OGG
    const echoOpts = threadId != null ? { message_thread_id: threadId } : {}
    void bot.api.sendMessage(chat_id, `🎤 «${content}»`, echoOpts).catch(() => {})
  }
}
```
- В объекте broadcast (daemon.ts:687-704) заменить `content: text` → `content: content`
  и в блоке attachment использовать `attach` вместо `attachment`.

Гейт/typing/ack-реакция уже стоят **до** транскрипции (daemon.ts:672-681) — пользователь
видит «печатает…» и ack-реакцию, пока идёт распознавание. (Whisper на CPU/GPU может
занять несколько секунд — это ок.)

### 4. Подключить транскрипцию к обработчикам (daemon.ts:852-887)
Передать callback в `voice`, `video_note`, `audio` (все — записанная речь):
```ts
bot.on('message:voice', async ctx => {
  const v = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined,
    { kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type },
    () => transcribeAudio(v.file_id))
})
```
Аналогично для `message:video_note` (`vn.file_id`) и `message:audio` (`audio.file_id`).
`message:video` / фото / документы — без изменений.

## Заметки / краевые случаи
- **Группы с requireMention**: голосовое без подписи не «упоминает» бота → gate его
  отбросит (текущее поведение). В личке (основной сценарий) — доставляется всегда.
  Чтобы голос работал в группе — ответить на сообщение бота или добавить подпись с @упоминанием.
- **Подпись к голосовому** (редко): при успешной транскрипции заменяется транскриптом;
  при желании можно склеивать `caption + "\n\n" + transcript` — не критично для v1.
- **Fallback**: при любой ошибке (нет модели/ffmpeg, сбой) — старое поведение
  (`(voice message)` + `attachment_file_id`), Claude сможет скачать файл сам.

## Verification (end-to-end)

1. Установить зависимости и модель (см. выше), прописать `WHISPER_MODEL` в `.env`.
2. Проверить распознавание вручную:
   `ffmpeg -y -i sample.ogg -ar 16000 -ac 1 /tmp/s.wav && whisper-cli -m <model> -f /tmp/s.wav -nt -np`
   — должен вывести текст.
3. **Перезапустить демон**, чтобы подхватил новый код (демон долгоживущий, общий):
   `kill "$(cat ~/.claude/channels/telegram/daemon.pid)"` — следующая сессия `claude`
   (через `server.ts`) поднимет свежий демон из обновлённого `daemon.ts`.
4. В личке боту отправить **голосовое по-русски**. Ожидаемо: ack-реакция → «печатает…»
   → бот присылает `🎤 «<распознанный текст>»` → Claude выполняет это как обычный запрос.
5. Проверить `~/.claude/channels/telegram/daemon.log` на ошибки `transcribe failed`.
6. Тест fallback: временно убрать `WHISPER_MODEL` → голосовое всё ещё доставляется как
   `(voice message)` без падений.

## Затрагиваемые файлы
- `daemon.ts` — импорты подпроцессов; `transcribeAudio()`; параметр `transcribe` +
  эхо в `handleInbound`; подключение в обработчиках `voice`/`video_note`/`audio`.
- `~/.claude/channels/telegram/.env` — `WHISPER_MODEL` (+ опц. `WHISPER_CLI`/`WHISPER_LANG`/`FFMPEG`).
- `server.ts` — без изменений.
