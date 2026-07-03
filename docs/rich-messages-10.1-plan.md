# План: перевод плагина на Telegram Rich Messages (Bot API 10.1)

> Цель: использовать новую разметку Bot API 10.1 (вышла 2026-06-11) в плагине
> `telegram-multi-vibes` (`claude-channel-telegram`) — нативный стриминг,
> блок «thinking», таблицы/код/заголовки, сообщения до 32 768 символов.
> Составлено: 2026-06-12. Исполняет Claude, надзирает пользователь.

## Как плагин устроен сейчас (база)

- Стек: **Bun + grammY ^1.21 + telegramify-markdown ^1.3.3**. Claude-Code-плагин (`.claude-plugin/`, MCP via `@modelcontextprotocol/sdk`).
- `agent-runner.ts`: гоняет Claude через `--output-format stream-json --verbose --include-partial-messages` (стр. 214–216); парсит NDJSON, **отделяет** текст ответа от thinking/tools (`stream_event` / `content_block_start`, стр. 391–399); отдаёт дельты через `onDelta`.
- `daemon.ts`:
  - `streamAgentReply()` (стр. 562): плейсхолдер `⌛` → **throttled `editMessageText`** по мере стрима, кап `STREAM_CAP=4000` (стр. 586); rate-limit-обработка (стр. 602–607); финал — MarkdownV2 через `telegramify(text,'escape')` (стр. 518) или fallback на plain + чанки.
  - `sendAgentReply()` (стр. 513–559): MD→MarkdownV2, чанки по `MAX_CHUNK_LIMIT=4096`.
- `server.ts`: MCP-инструменты `sendMessage`/`editMessageText` для агентов (`format: text|markdownv2`, чанки 4096, стр. 377/419/439/513).

Узкие места, которые 10.1 снимает: стриминг = хак через edit; формат = плоский MarkdownV2; всё режется на 4096.

## Что даёт 10.1 и куда ложится

| Фича 10.1 | Куда в плагине |
|-----------|----------------|
| `sendRichMessageDraft` (нативный стрим) | заменяет edit-хак в `streamAgentReply()` |
| `RichBlockThinking` | thinking/tools, которые runner УЖЕ отделяет → нативный блок вместо `⌛` |
| лимит 32 768 + «show more» ~8000 | убирает почти весь `chunk()`/follow-up |
| `RichBlockPreformatted/Table/SectionHeading/BlockQuotation/List/Divider/MathematicalExpression/Details` | нативный рендер кода/таблиц/заголовков |
| `editMessageText(rich_message)` | финализация черновика |
| `sendRichMessage` | финальный рендер ответа |

**Ключевое:** rich-сообщение — структура объектов (`RichBlock`-дерево), НЕ markdown. Ядро работы — новый конвертер `markdown → RichBlock`.

## План (за фича-флагом `AGENT_RICH=1`, telegramify — fallback)

### Фаза 0 — спайк / разведка (БЛОКЕР)
- [ ] Достать реальную JSON-схему `InputRichMessageContent` / `RichMessage` / `RichBlock*` (dev-дока 10.1 / демо-бот).
- [ ] Проверить вызов через grammY (`bot.api.raw.*` или прямой `fetch` на `api.telegram.org/bot<token>/sendRichMessage`).
- [ ] Поведение на старых клиентах: есть ли plain-text fallback-поле? авто-деградация?
- [ ] Rate-limit/флуд у `sendRichMessageDraft`.
- _Результаты вписывать в раздел «Фаза 0 — находки» ниже._

### Фаза 1 — ~~конвертер `md → RichBlock`~~ ОТМЕНЕНА (см. находки)
- **Конвертер НЕ нужен.** `InputRichMessage` принимает строку `markdown` или `html` напрямую — Telegram парсит блоки сам. Отдаём markdown Claude как есть.
- Остаётся лишь тонкая адаптация диалекта (spoiler `||..||`, marked `==..==`, таблицы) — мелочь, не отдельный модуль.

### Фаза 2 — финальный рендер (полдня)
- Финал в `sendAgentReply`/`streamAgentReply` → `sendRichMessage` (cap 32k).
- Любая ошибка / старый клиент → текущий MarkdownV2-путь (не удалять telegramify).

### Фаза 3 — стриминг (1 день)
- edit-throttle → `sendRichMessageDraft`: текст-дельты → параграфы, thinking-дельты → `RichBlockThinking`.
- Финал — `editMessageText(rich_message)` либо итоговый `sendRichMessage`. Сохранить Stop-кнопку (`stopKb`).

### Фаза 4 — MCP `server.ts` (полдня)
- Добавить `format: 'rich'` в инструменты sendMessage/editMessageText.

### Фаза 5 — раскатка (полдня)
- Env-флаг, обкатка на одном топике, мониторинг, fallback наготове.

## Риски / открытые вопросы
- API 1 день: grammY-типов нет → дёргаем метод «сырьём».
- Точная JSON-схема пока не подтверждена — блокер Фазы 0.
- Старые клиенты → нужен гарантированный plain-fallback.
- Rate-limit `sendRichMessageDraft` неизвестен.
- Не сломать MCP-путь (`server.ts`).

**Оценка:** ~3–5 дней; темп упирается в зрелость grammY/клиентов.

---

## Фаза 0 — находки (2026-06-12, ✅ закрыта)

### 1. Отправка — это строка markdown/html, НЕ дерево объектов (главное)
`InputRichMessage` (поле `rich_message`):
- `html: String` (opt) — содержимое в HTML-разметке
- `markdown: String` (opt) — содержимое в Markdown-разметке
- **«Exactly one of the fields html or markdown must be used.»**
- `is_rtl: Boolean` (opt), `skip_entity_detection: Boolean` (opt)

→ **Конвертер `md→RichBlock` не нужен.** Дерево `RichBlock*` — это то, что *получаешь*; для *отправки* отдаёшь строку. Telegram сам парсит.

### 2. `sendRichMessage` (финал, персистится)
Параметры: `chat_id` (Integer|String, Yes), `message_thread_id` (Integer, opt — форум-топик в супергруппе ИЛИ приватном чате с forum topic mode), `direct_messages_topic_id` (opt), **`rich_message: InputRichMessage` (Yes)**, `disable_notification`, `protect_content`, `business_connection_id`, `allow_paid_broadcast`. Возвращает `Message`.

### 3. `sendRichMessageDraft` (стриминг) — ограничения!
- `chat_id` (Integer, Yes) — **«target private chat»**, ТОЛЬКО приват, не группа.
- `message_thread_id` (opt), **`draft_id` (Integer, Yes, non-zero)** — апдейты с одним id анимируются.
- `rich_message: InputRichMessage` (Yes). Возвращает `True`.
- **Черновик эфемерный — превью ~30 сек.** По завершении ОБЯЗАТЕЛЬНО вызвать `sendRichMessage`, иначе ничего не сохранится.

### 4. `RichBlockThinking` — только в драфте
Тег `<tg-thinking>` (HTML). «may be used only in sendRichMessageDraft, can't be received in messages». Рекоменд. кастом-эмодзи t.me/addemoji/AIActions. → мысли показываем в стриме, в финале их нет. Идеально под Claude.

### 5. Rich Markdown диалект ≈ то, что Claude уже пишет
`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `||spoiler||`, `==marked==`, `[t](url)`, `# …###### H1–H6`, ```` ```lang ```` блоки, `---`, списки `- * + / 1. / - [ ] / - [x]`, `>` цитаты, `![](url)` медиа, `$x^2$` формулы. Стандартный GFM Claude мапится почти 1:1 (адаптировать только spoiler/marked/таблицы).

### 6. Лимиты
32 768 символов · 500 блоков (вкл. вложенные/строки таблиц/пункты) · 16 уровней вложенности · 50 медиа · 20 колонок в таблице.

### 7. grammY — вызов подтверждён
Установлена **1.41.1**. `bot.api.raw` — это `Proxy`, форвардит любое имя метода в `callApi` (`node_modules/grammy/out/core/client.js`). → `(bot.api.raw as any).sendRichMessage(payload)` уйдёт на сервер БЕЗ обновления библиотеки и типов. Запасной путь — прямой `fetch` на `api.telegram.org/bot<TOKEN>/...` (в коде уже используется для файлов).

### 8. Модель чатов плагина (важно для стриминга)
`daemon.ts` обрабатывает И приват (`chatType==='private'`, Threaded Mode DM, стр. 413), И супергруппы (стр. 440). Комментарий стр. 121–123: топик «in a DM (Threaded Mode) or supergroup».
→ **Стриминг-драфт доступен только в приватных Threaded-Mode чатах.** В супергруппах — финальный `sendRichMessage` (либо текущий edit-хак для «живости»).

### Открыто (нужен живой тест, gated):
- Поведение на старых клиентах: авто-fallback в plain или нужно слать дубль? 
- Rate-limit/флуд у `sendRichMessageDraft` при частом стриме.

---

## Ревизия плана (после Фазы 0)

Объём упал: конвертер не нужен. Реальная работа:
- **Шаг A (маленький).** В `sendAgentReply` + финал `streamAgentReply`: `(bot.api.raw as any).sendRichMessage({chat_id, message_thread_id, rich_message:{markdown:text}})`, try/catch → fallback на текущий MarkdownV2/plain. Снимает чанки (cap 32k), даёт нативные таблицы/код/заголовки.
- **Шаг B (стриминг, только приват).** Если `chatType==='private'`: `⌛`+editMessageText → `sendRichMessageDraft({draft_id, rich_message:{html: '<tg-thinking>…</tg-thinking>' + ответ}})` throttled; thinking-дельты из runner'а → в `<tg-thinking>`; финал → `sendRichMessage`. Супергруппы — без драфта.
- **Шаг C.** MCP `server.ts`: `format:'rich'`.
- **Шаг D.** Флаг `AGENT_RICH=1`, обкатка, fallback для старых клиентов.

Оценка после ревизии: **~1–1.5 дня** (вместо 3–5). Узкое место — живой тест ради пунктов «открыто».

⚠️ **Осторожно:** `daemon.ts` — это ЖИВОЙ мост, через который идёт текущий диалог. Правки — только за флагом (default OFF) и в окно, когда пользователь может перезапустить/мониторить. Не хот-патчить вслепую.

---

## Статус реализации

### ✅ Шаг A — сделано (код-комплит за флагом, 2026-06-12)
Правки в `daemon.ts`:
- Добавлен флаг `const AGENT_RICH = process.env.AGENT_RICH === '1'` + хелпер `sendRich()` (вызывает `sendRichMessage` через `bot.api.raw`, markdown как есть, try/catch → false).
- `sendAgentReply()`: `if (await sendRich(...)) return` первой попыткой, иначе старый MarkdownV2/plain путь.
- `streamAgentReply()` финал: `sendRich(...)` → при успехе удаляет `⌛`-плейсхолдер и выходит; иначе старый путь.
- Проверка: `bun build ./daemon.ts` → 195 модулей, exit 0. Демон НЕ перезапускался, отправок НЕ было.

**Чтобы попробовать вживую** (требует твоего участия): выставить `AGENT_RICH=1` в env демона → рестарт → отправить сообщение с таблицей/кодом/заголовком и посмотреть рендер + поведение fallback. Откат — убрать флаг (правка инертна при OFF).

### ✅ Шаг B — сделано (код-комплит за флагом, 2026-06-12)
Правки в `streamAgentReply()` (всё под тем же `AGENT_RICH`):
- `useDraft = AGENT_RICH && !chat_id.startsWith('-')` — драфт только в приватных чатах (метод берёт числовой private chat_id; id супергрупп отрицательные).
- `nextDraftId()` — монотонный non-zero id, стабильный в рамках одного стрим-хода (Telegram анимирует апдейты).
- `flush()`: при `useDraft` шлёт `sendRichMessageDraft`. Пока есть только активность без текста → нативный `<tg-thinking>`; как пошёл текст → `markdown`. Кривой частичный markdown в середине стрима → `.catch` откатывается на plain-edit `⌛`-плейсхолдера, живой вид не застывает.
- `⌛`-плейсхолдер + кнопка Стоп остаются (управление + fallback). Финальная фиксация — `sendRich()` из Шага A (он же удаляет плейсхолдер).
- Проверка: `bun build` → 195 модулей, exit 0. Рестарта/отправок не было.

**Открытые UX-вопросы (решать на живом тесте):**
- Дублирование: `⌛`-плейсхолдер + анимированный драфт-превью одновременно — не мешает ли визуально.
- Эфемерность: после финала драфт-превью живёт ещё ~30 сек — перекрывается ли реальным сообщением чисто.
- HTML-диалект rich: подтвердить, что `<tg-thinking>` и переносы строк рендерятся как ожидаем.
- Частичный markdown в драфте: насколько часто 400 → как часто срабатывает fallback.

### ✅ Шаг C — сделано (код-комплит, 2026-06-12)
- `server.ts`: в инструменты `reply` и `edit_message` добавлен `format: 'rich'` (enum + описание). При `rich` зовётся новый RPC; при любой ошибке — откат на чанковый `sendMessage`/markdownv2 (try/catch).
- `daemon.ts` `dispatchRpc`: новый `case 'sendRichMessage'` (markdown как есть, через `bot.api.raw`); в `case 'editMessageText'` — ветка `params.rich` → `editMessageText({rich_message})`.
- В отличие от A/B, тут **флаг не нужен**: rich срабатывает только когда агент сам передал `format:'rich'`; иначе путь прежний. Недоступность API → fallback.
- Проверка: `bun build daemon.ts` и `server.ts` → exit 0. Рестарта/отправок не было.

### 🟡 Шаг D — раскатка (частично; требует тебя)

**Живой тест 2026-06-12:** standalone `sendRichMessage` (через токен, chat 426335838/thread 532252) →
- ✅ **Метод работает на боевом Bot API** — сообщение отправилось (не 404).
- ❌ Клиент пользователя (Telegram **Desktop**) слишком старый → показал стандартную заглушку Telegram *«This message is not supported by your version… please update»*. НЕ контент, НЕ сырой markdown.

**⚠️ Важный вывод про fallback (gate на раскатку):** при старом клиенте API-вызов **успешен**, а не рендерит уже клиент. Значит наш `try/catch` в `sendRich`/`server.ts` **НЕ срабатывает** (он ловит только ошибку API). → Если включить `AGENT_RICH=1` при старом клиенте, **ВСЕ ответы бота станут заглушкой «обновите Telegram»** без текста. Нельзя включать флаг, пока целевые клиенты не обновлены.

**Что осталось:**
1. Обновить Telegram до последней версии (Desktop может отставать с поддержкой 10.1 — возможно, сначала заработает на мобильном/beta).
2. Перезапустить тест → убедиться, что рендерится красиво.
3. Только потом: `AGENT_RICH=1` + рестарт демона.

**TODO (улучшение кода):** добавить определение версии клиента / опцию принудительного MarkdownV2-фоллбэка, раз API-успех ≠ «клиент показал». Иначе раскатка хрупкая.

---

## Сводка: весь код-сайд готов
A (финал) + B (стриминг, приват) под флагом `AGENT_RICH` (OFF = прежнее поведение). C (MCP `format:'rich'`) — без флага, с fallback. Транспиляция зелёная по всем файлам. Осталось одно: **живой тест с рестартом демона в окне** (Шаг D).
