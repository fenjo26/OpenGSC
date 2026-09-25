# T3 — Каналы уведомлений: Discord, Microsoft Teams, e-mail (SMTP), webhook

**Ветка:** `feat/wave-oct-t3` от `feat/wave-oct`, worktree `.worktrees/wave-t3`.
**Владение:** `README.md` §4, строка T3. `src/app/settings/page.tsx` — твой; строки
`<NotifyChannelsCard />` и `<UptimeSettingsCard />`, вставленные T0, должны остаться.

## Зачем

Сейчас всё — алерты, дайджесты, дропы, шторма SERP Monitor — уходит только в Telegram и Slack
(`src/lib/notify.ts`, `notifyUser`). Команда или клиент агентства часто живёт в Discord или
Teams. Руководитель хочет письмо. Для своей автоматики (n8n, Zapier, собственный бот) нужен
webhook. У All-In-One-Free-SEO-Tool это есть, у нас — нет.

**SMTP** — протокол отправки почты. Пользователь указывает почтовый сервер (например,
`smtp.gmail.com:465` с паролем приложения, Яндекс, Mailgun, свой Postfix), и OpenGSC шлёт
письма сам, без стороннего сервиса.

## Что сделать

### 1. Доставка — `src/lib/notify.ts` (фасад) + `src/lib/notify/`
- `notifyUser(userId, text, opts?)` — сигнатура из контракта. Без `opts` — событие `"alert"`,
  то есть все существующие вызовы продолжают работать без правок. Возвращает `true`, если
  доставил хотя бы один канал.
- `notifyUserDetailed` — то же, но возвращает `NotifyDelivery[]` по каждому каналу.
- Каналы опрашиваются **параллельно** (`Promise.allSettled`). Падение одного не мешает остальным.
- Фильтр событий: `eventAllowed(channel.events, event)` (пустой список = всё). Для Telegram и
  Slack фильтры лежат в `telegramEvents` / `slackEvents` (их реквизиты остаются в своих колонках
  `User`). Событие `"test"` проходит любой фильтр.
- После каждой доставки обновляется `lastOkAt` / `lastError` канала в `User.notifyChannels`.
  Пиши одним `UPDATE` на вызов, а не на каждый канал, и не затирай параллельные изменения
  настроек: перечитай JSON и обнови только эти два поля.
- `User.notifyChannels` читается raw SQL — так же, как `getSlackWebhook`: колонки может ещё не
  быть, и это не должно ронять уведомления. Нет колонки → только Telegram и Slack, как раньше.

### 2. Форматирование — `src/lib/notify/format.ts` (чистые функции)
Вход — текст в Telegram-markdown (как его пишут шаблоны `notifyI18n.ts`: `*жирный*`, `_курсив_`,
ссылки `[текст](url)`, переносы строк).
- **Discord** — `toDiscordChunks`: `*x*` → `**x**`, куски ≤ 2000 символов по границам абзацев
  (как делает `sendTelegram` для 4096), тело `{ content, allowed_mentions: { parse: [] } }` —
  чтобы текст со словом `@everyone` никого не пинговал.
- **Teams** — `toTeamsCard`: Adaptive Card 1.4 в конверте, который принимают вебхуки
  **Workflows** (Power Automate): `{ type: "message", attachments: [{ contentType:
  "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", version: "1.4",
  body: [{ type: "TextBlock", text: title, weight: "Bolder", wrap: true }, { type: "TextBlock",
  text, wrap: true }] } }] }`. Старые коннекторы Office 365 Microsoft закрыла — подсказка
  `notifyChTeamsHint`.
- **E-mail** — `toEmail`: `subject` = `title` без markdown и эмодзи в начале (≤ 120 символов);
  `text` — плоский; `html` — минимальный безопасный HTML: экранирование, `<b>`, `<i>`, `<a>`,
  `<br>`, без внешних картинок и стилей (почтовые клиенты режут и то, и другое).
- **Webhook** — `toWebhookBody`: JSON
  `{ "event", "title", "text", "markdown", "createdAt", "instance" }`, где `instance` —
  `NEXTAUTH_URL` или `APP_URL` (как их называет проект). Подпись `signWebhook` —
  `sha256=` + hex HMAC-SHA256 тела секретом, заголовок `X-OpenGSC-Signature`.

### 3. Транспорт — `src/lib/notify/channels.ts`
- Все URL проверяются `assertSafeTarget` (`src/lib/security/safeFetch.ts`) **до** запроса.
  `safeFetch` умеет только `GET`/`HEAD`, поэтому сама отправка — обычный `fetch` с
  `redirect: "manual"`, таймаутом 10 с и телом ≤ 64 КБ. Редирект считать ошибкой: иначе
  проверку адреса можно обойти через 302.
- Проверка домена при сохранении (`notifyChErr_invalid_url`):
  - Discord: `https://discord.com/api/webhooks/…` или `discordapp.com`;
  - Teams: хост оканчивается на `.logic.azure.com`, `.powerplatform.com` или `.powerautomate.com`
    (сверь с актуальным форматом URL Workflows; если он другой — напиши в отчёте и
    не ослабляй проверку до «любой https»);
  - webhook: любой `https`, прошедший `assertSafeTarget`.
- **SMTP** — `nodemailer` (T0 добавил зависимость): `createTransport({ host, port, secure,
  auth, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 })`. Хост
  SMTP тоже проходит `assertSafeTarget`, иначе SMTP-клиент становится сканером портов
  внутренней сети. Ошибки аутентификации → `smtp_auth`, сетевые → `smtp_connect`. Получатели —
  не больше 10.
- Ретраи: один повтор через 2 с при сетевой ошибке или 5xx. На 429 от Discord ждать
  `retry_after` (не больше 10 с), затем один повтор.

### 4. Секреты
- `channelViews` отдаёт `NotifyChannelView` без секретов: URL вебхука маскируется
  (`https://discord.com/api/webhooks/1234…/••••`), пароль SMTP и секрет вебхука не отдаются вовсе.
- `saveChannel`: пустая строка в `url`, `secret` или `pass` = «оставить как есть» (`notifyChKeep`).
- Менять каналы может право `act`. Посмотри, как `/api/settings/slack` проверяет права, и сделай
  так же. Если там только владелец — тоже только владелец (канал уведомлений владельца — это
  его почта и его сервер; участник не должен перенаправлять алерты себе).

### 5. UI — `src/components/NotifyChannelsCard.tsx`
- Под существующими блоками Telegram и Slack: четыре раскрывающиеся строки — Discord, Teams,
  E-mail, Webhook. В свёрнутом виде: имя, статус (настроен / выключен), `notifyChLastOk` или
  `notifyChLastError`.
- В развёрнутом: поля канала, мультивыбор событий (`notifyEv_*`; пусто = `notifyChEventsAll`),
  переключатель `on`, кнопки «Сохранить» и `notifyChTest`.
- Для Telegram и Slack — только мультивыбор событий (их реквизиты настраиваются как раньше).
  Эти строки добавь в существующие блоки на `settings/page.tsx`.
- Ошибки сохранения и теста — через `notifyChErr_*`.

### 6. API — `src/app/api/settings/notify-channels/**` по контракту §4.

### 7. Документация — `docs/NOTIFICATIONS.md`
Все шесть каналов: где взять URL (Discord → Server Settings → Integrations → Webhooks; Teams →
канал → Workflows → «Post to a channel when a webhook request is received»), настройки SMTP для
Gmail (пароль приложения, 465/TLS), формат webhook с примером проверки подписи на Node и
Python, таблица событий.

## Не делать
- Не переписывай вызовы `notifyUser` в других модулях — у них свои владельцы. Все старые
  вызовы без `opts` станут событием `alert`, в том числе дайджест. Найди вызовы в
  `digestScheduler.ts` и `/api/digest` и перечисли их в отчёте: R допишет туда
  `{ event: "digest" }` (по одной строке), иначе фильтр «только дайджесты» не сработает.
- Не добавляй входящую почту (IMAP) и планировщик рассылок: дайджест уже умеет расписание.

## Тесты — `src/lib/notify/*.test.ts`
- `toDiscordChunks`: 5000 символов → 3 куска ≤ 2000, разрез по абзацам; `*x*` → `**x**`.
- `toTeamsCard`: структура конверта, `wrap: true`.
- `toEmail`: `<script>` в тексте экранирован; ссылка стала `<a href>`; subject без markdown.
- `signWebhook`: известный вектор (секрет `s`, тело `{}`) → ожидаемый hex.
- `eventAllowed`: пустой список, совпадение, несовпадение, `"test"` проходит всегда.
- Проверка URL Discord и Teams: валидные, чужой хост, `http://`.

## Проверка
```bash
npx tsx --test src/lib/notify/*.test.ts
npm run check
npx eslint src/lib/notify.ts src/lib/notify src/components/NotifyChannelsCard.tsx src/app/api/settings/notify-channels src/app/settings/page.tsx
```
Ручная: Discord-вебхук и Gmail SMTP → «Отправить тест» приходит в оба; выключить Discord →
алерт уходит только в Telegram.
