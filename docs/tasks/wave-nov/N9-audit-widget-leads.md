# N9 — Встраиваемый аудит, входящие лиды, коммерческое предложение

**Ветка:** `feat/wave-nov-n9`. **Владение:** `README.md` §4, строка N9. Дока — `docs/LEADS.md`.

## Зачем
Идея из All-In-One: агентство ставит на свой сайт виджет «проверьте свой сайт», посетитель
вводит домен, видит проблемы и оставляет e-mail. Агентство получает лида вместе с находками,
поэтому первое письмо пишется за минуту. Из аудита — черновик КП.

## Главное — безопасность публичного контура
Виджет открыт анониму в интернете. Требования, без которых задачу не принимают:
- Публичные маршруты (`/embed/audit`, `/api/public/audit`, `/api/public/lead`) **не читают**
  ничего, кроме `User.widgetSettings` владельца по `widgetKey`: ни сайтов, ни GSC, ни ключей,
  ни других лидов.
- Внешние запросы — `safeFetch(url, { allowPrivate: false })` **явно** (не наследовать
  настройку инстанса). Только `http(s)`, только публичные хосты, ≤ 5 страниц на аудит,
  ≤ 2 МБ на страницу, общий таймаут 25 с.
- **Rate limit** в памяти: по IP (соль + sha256, сырой IP нигде не хранится) — 5 аудитов в
  час и 20 в сутки; по `widgetKey` — 200 в сутки. Превышение → 429 с понятным текстом.
- **Turnstile** (Cloudflare), если заданы `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` в env:
  проверка токена на `/api/public/audit`. Без ключей виджет работает, а в настройках
  предупреждение «без капчи виджет можно заспамить».
- `Origin` / `Referer` сверяются с `allowedOrigins` из настроек (пусто = любые, с
  предупреждением). Ответы публичных маршрутов не содержат внутренних деталей ошибок.
- Результат аудита кэшируется в памяти на 15 минут по домену (как в Public Lite из roadmap §9).

## 1. Лайт-аудит — `src/lib/leads/liteAudit.ts`
Переиспользует разбор страницы из аудита (`src/lib/audit/pageSignals.ts`, `rules.ts` —
**только импорт**): главная + до 4 страниц из sitemap или главного меню. Проверки: HTTPS и
сертификат, код ответа и редиректы, title/description (длины из `metaLimits`), H1, canonical,
noindex, viewport, `lang`, JSON-LD, OG, заголовки безопасности, время ответа, битые ссылки на
главной (≤ 30 HEAD). Без GSC, без PSI (если у владельца нет ключа PSI; с ключом — 1 запрос
PSI для главной, это его квота). Оценка 0…100 и список находок
`LeadFinding = { code, severity, title, evidence, fix }` (тексты — на языке виджета, через
локали).

## 2. Виджет — `/embed/audit?key=<widgetKey>&lang=<xx>`
- Лёгкая страница без меню приложения: поле домена → прогресс → оценка (кольцо) + до 5 главных
  проблем (без деталей «как исправить» — они в полном отчёте) → форма: e-mail (обязателен),
  имя, сообщение, согласие на обработку данных (текст из настроек, по умолчанию стандартный).
- После отправки: «Полный отчёт отправлен на e-mail» — **только** если у владельца настроен
  SMTP (`sendEmail`, октябрь). Иначе «Мы свяжемся с вами».
- Цвет акцента и логотип — из `widgetSettings`. Тёмная/светлая тема по
  `prefers-color-scheme`. Ширина 320–720 px.
- Код для вставки (в настройках): `<iframe src="https://<instance>/embed/audit?key=…"
  style="width:100%;height:640px;border:0" loading="lazy"></iframe>` и вариант с авто-высотой
  через `postMessage` (скрипт-сниппет в доке).

## 3. Лиды — `/leads` и `/api/leads/**`
- Входящие: дата, домен, e-mail, оценка, 3 главные проблемы, источник (URL страницы с виджетом),
  статус (`new → contacted → won/lost`, `client`). Фильтры, поиск, экспорт CSV.
- Карточка лида: все находки с evidence, «Написать» (`mailto:` с черновиком письма из находок:
  приветствие, 3 проблемы простым языком, предложение созвониться — шаблон детерминированный,
  редактируется в настройках), «Сделать клиентом» — ставит статус `client` и открывает `/reports`.
  Сайт автоматически не создаётся: в OpenGSC сайты появляются только из Search Console.
- Новый лид → уведомление владельцу `leadNewTitle/Msg` (событие `lead`).

## 4. Коммерческое предложение
«Сделать КП» в карточке лида → markdown в `Lead.proposal`, редактируемый в UI, экспорт в
HTML (с брендингом `reportBranding` N8, если он задан — только чтение `User.reportBranding`)
и печать в PDF из браузера.
- Структура: о компании (из настроек) · что нашли (находки, сгруппированные по категориям,
  с объяснением последствий простым языком) · объём работ (пункты из находок; оператор
  отмечает, какие включить) · цены (оператор вводит сам, по пунктам или пакетом) · сроки ·
  следующий шаг.
- **Никаких прогнозов трафика, позиций и выручки** — краулинг их не обосновывает, а КП — документ,
  по которому клиент потом спрашивает. Это правило пишется в доке.
- LLM не используется: тексты последствий — из словаря по коду находки (локали).

## 5. Настройки — `WidgetSettingsCard`
Вкл/выкл, `widgetKey` (сгенерировать / перевыпустить — старый перестаёт работать),
`allowedOrigins`, цвет, логотип, текст согласия, e-mail для уведомлений, код вставки, статус
Turnstile, шаблон первого письма, «о компании» для КП.

## 6. MCP — `list_leads` (local).

## Тесты — `src/lib/leads/*.test.ts`
Rate limit (окна, соль, сырой IP не сохраняется); сверка origin; оценка из находок; `safeFetch`
вызывается с `allowPrivate: false` (мок); лайт-аудит на HTML-фикстурах; генерация КП без
прогнозов (в тексте нет слов «прогноз», «forecast», «увеличим трафик на» — проверка по словарю);
CSV-экспорт экранирует `=`, `+`, `-`, `@` в начале ячейки (CSV-инъекция).

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `leadNavTitle` | Leads | Лиды |
| `leadTitle` | Leads from the audit widget | Лиды из виджета аудита |
| `leadStatus_new` | New | Новый |
| `leadStatus_contacted` | Contacted | Связались |
| `leadStatus_won` | Won | Выигран |
| `leadStatus_lost` | Lost | Проигран |
| `leadStatus_client` | Client | Клиент |
| `leadScore` | Score | Оценка |
| `leadTopIssues` | Top issues | Главные проблемы |
| `leadWrite` | Write | Написать |
| `leadProposal` | Proposal | КП |
| `leadMakeProposal` | Create proposal | Сделать КП |
| `leadExportCsv` | Export CSV | Экспорт CSV |
| `leadNoForecasts` | Proposals contain no traffic, ranking or revenue forecasts — a crawl cannot support them. | В КП нет прогнозов трафика, позиций и выручки: краулинг их не обосновывает. |
| `leadWidgetTitle` | Audit widget | Виджет аудита |
| `leadWidgetKey` | Widget key | Ключ виджета |
| `leadWidgetRegen` | Regenerate key | Перевыпустить ключ |
| `leadWidgetOrigins` | Allowed sites (one per line) | Разрешённые сайты (по одному в строке) |
| `leadWidgetEmbed` | Embed code | Код для вставки |
| `leadWidgetNoCaptcha` | Turnstile keys are not set — the widget can be spammed | Ключи Turnstile не заданы — виджет можно заспамить |
| `leadWidgetConsent` | Consent text | Текст согласия |
| `leadWidgetAbout` | About your company (for proposals) | О компании (для КП) |
| `leadEmbedTitle` | Check your website | Проверьте свой сайт |
| `leadEmbedDomain` | Your domain | Ваш домен |
| `leadEmbedRun` | Check | Проверить |
| `leadEmbedScore` | Your score: {n}/100 | Ваша оценка: {n}/100 |
| `leadEmbedEmail` | E-mail for the full report | E-mail для полного отчёта |
| `leadEmbedSend` | Get the report | Получить отчёт |
| `leadEmbedSentMail` | The full report is on its way to your inbox | Полный отчёт отправлен вам на e-mail |
| `leadEmbedSentContact` | Thank you — we will contact you | Спасибо, мы свяжемся с вами |
| `leadEmbedRateLimit` | Too many checks — try again later | Слишком много проверок — попробуйте позже |
