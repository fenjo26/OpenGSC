# N8 — Отчёты для клиентов: white-label, PDF, рассылка, клиентский доступ

**Ветка:** `feat/wave-nov-n8`. **Владение:** `README.md` §4, строка N8 (включая `src/app/share/**`).
Дока — `docs/REPORTS.md`.

## Зачем
Агентству каждый месяц нужно отправить клиенту понятный отчёт со своим логотипом. Сейчас есть
только read-only ссылка на дашборд сайта (`/share/[siteId]/[token]`) — живая, без брендинга,
без «что мы сделали». Нужны: конструктор отчёта, замороженный снимок, PDF, рассылка по расписанию.

## 1. Брендинг — `User.reportBranding`, карточка `ReportBrandingCard` в Settings
`{ companyName, logoDataUrl (≤ 200 КБ, png/svg/jpg), accentColor, footer, website }`.
По умолчанию — нейтральный стиль без упоминания OpenGSC (white-label). Переключатель
«Показывать "Made with OpenGSC"» — по умолчанию выкл.

## 2. Отчёт — `ClientReport`, страница `/reports`
- Список отчётов, создание: сайт, название, шаблон, период (7/30/90), секции, получатели,
  расписание (`off` / `weekly` + день недели / `monthly` + число 1–28), заметки «что сделано».
- Шаблоны задают набор секций по умолчанию:
  - `executive` — сводка, трафик, лучшие запросы, позиции, заметки;
  - `detailed` — всё из executive + страницы, индексация, бэклинки, аптайм;
  - `technical` — аудит, индексация, аптайм, Core Web Vitals;
  - `local` — локальные позиции, отзывы GBP, NAP-статус.
- Секции (`ReportSectionId`, константа в `src/lib/reports/sections.ts`): `summary`, `traffic`
  (клики/показы/CTR/позиция, период против предыдущего, график), `queries` (топ-20 и главные
  изменения), `pages`, `positions` (Rank Tracker: рост/падение, топ-3/10), `local_positions`,
  `indexing` (покрытие из `IndexCoverageDaily`), `audit` (оценка и топ-проблемы последнего
  аудита), `uptime` (аптайм % и инциденты), `backlinks` (новые/потерянные, DR), `ai_visibility`
  (доля голоса), `reviews` (GBP), `work_done` (заметки оператора, markdown), `next_steps`.
- **Каждая секция читает данные через уже существующие модули** (store-функции uptime,
  indexing, visibility, backlinks, audit, rank; `DailyMetric` напрямую). Нет данных → секция
  не рендерится или показывает «нет данных», но **не** ноль.

## 3. Рендер — `src/lib/reports/render.ts`
- Серверный рендер в **самодостаточный HTML**: инлайн-CSS, графики — инлайн-SVG (без JS), логотип
  data-URL. Цвета — из брендинга. Печатный CSS (`@page A4`, разрывы страниц между секциями).
- «AI-сводка» (как в All-In-One: «направление + победа + приоритет») — **детерминированная**,
  из чисел: «Клики +18 % к прошлому периоду; лучший рост — «transfer halkidiki» (+240 кликов);
  приоритет — 6 страниц выпали из индекса». LLM не используется.
- **Никаких прогнозов** трафика и позиций.
- Снимок: `ClientReportRun.html` — готовый HTML, больше никогда не перерендеривается.

## 4. PDF
Через `playwright` (уже в зависимостях, динамический импорт, как в `src/lib/seo/richResults.ts`):
`page.setContent(html)` → `page.pdf({ format: "A4", printBackground: true })` → файл в
`data/reports/<runId>.pdf`, путь в `pdfPath`. Нет браузера Playwright на сервере → PDF не
создаётся, в UI — «PDF недоступен, установите `npx playwright install chromium`» и кнопка
«Скачать HTML» (он печатается в PDF из браузера).

## 5. Рассылка — `src/lib/reports/scheduler.ts`
Тик раз в час: отчёты с `nextSendAt ≤ now` → рендер → снимок → PDF (если можно) → письмо.
Письмо — через `sendEmail` из `src/lib/notify/channels.ts` (канал E-mail октябрьской волны,
SMTP владельца). Если `sendEmail` не умеет вложения, **не меняй** этот файл (он N10) — отправь
HTML-письмо со ссылкой на клиентский доступ и опиши в отчёте, какая правка нужна для вложений.
После отправки — `reportSentMsg` владельцу (событие `digest`). Без настроенного SMTP — отчёт
создаётся, письмо не уходит, в списке видно «SMTP не настроен».

## 6. Клиентский доступ
- У отчёта своя ссылка `/share/report/<token>`, токен — `ClientReport.shareToken`
  (32 случайных байта в base64url, создаётся кнопкой «Ссылка для клиента», пересоздаётся и
  отключается там же). Ссылка отчёта не даёт доступа к дашборду сайта и наоборот.
  Маршрут `GET /api/reports/share/[token]` сверяет токен за постоянное время
  (`timingSafeEqual`).
- Страница клиента: список снимков по датам, открыть HTML, скачать PDF. Никаких кнопок
  изменения, никаких данных вне отчётов.

## 7. MCP — `list_reports` (local): отчёты и последние снимки.

## Тесты — `src/lib/reports/*.test.ts`
Расписание (`nextSendAt` для weekly/monthly, 29–31 число не используются); детерминированная
сводка по числам; «нет данных» ≠ 0 в секции; экранирование заметок (markdown → безопасный HTML);
рендер без JS (в HTML нет `<script>`); логотип > 200 КБ отклоняется.

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `repNavTitle` | Reports | Отчёты |
| `repTitle` | Client reports | Отчёты для клиентов |
| `repNew` | New report | Новый отчёт |
| `repTemplate_executive` | Executive | Краткий |
| `repTemplate_detailed` | Detailed | Подробный |
| `repTemplate_technical` | Technical | Технический |
| `repTemplate_local` | Local | Локальный |
| `repSections` | Sections | Разделы |
| `repPeriod` | Period | Период |
| `repRecipients` | Recipients | Получатели |
| `repSchedule` | Schedule | Расписание |
| `repSchedule_off` | Manual only | Только вручную |
| `repSchedule_weekly` | Weekly | Еженедельно |
| `repSchedule_monthly` | Monthly | Ежемесячно |
| `repWorkDone` | What we did | Что сделано |
| `repNextSteps` | Next steps | Следующие шаги |
| `repPreview` | Preview | Предпросмотр |
| `repSendNow` | Send now | Отправить сейчас |
| `repDownloadPdf` | Download PDF | Скачать PDF |
| `repDownloadHtml` | Download HTML | Скачать HTML |
| `repPdfUnavailable` | PDF unavailable on this server — HTML can be printed to PDF from the browser | PDF на этом сервере недоступен — HTML можно распечатать в PDF из браузера |
| `repNoSmtp` | E-mail (SMTP) is not configured | E-mail (SMTP) не настроен |
| `repClientLink` | Client link | Ссылка для клиента |
| `repRuns` | Sent reports | Отправленные отчёты |
| `repBrandingTitle` | Report branding | Брендинг отчётов |
| `repBrandCompany` | Company name | Название компании |
| `repBrandLogo` | Logo | Логотип |
| `repBrandColor` | Accent colour | Цвет акцента |
| `repBrandFooter` | Footer | Подвал |
| `repBrandPoweredBy` | Show “Made with OpenGSC” | Показывать «Made with OpenGSC» |
| `repNoData` | No data for this period | Нет данных за период |
