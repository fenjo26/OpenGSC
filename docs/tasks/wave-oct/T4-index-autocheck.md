# T4 — Автопроверка индексации через бесплатную квоту Google

**Ветка:** `feat/wave-oct-t4` от `feat/wave-oct`, worktree `.worktrees/wave-t4`.
**Владение:** `README.md` §4, строка T4. В `src/lib/mcp/tools.ts` — только тело обработчика
`inspect_url` (учёт квоты), больше ничего.

## Зачем

Сейчас индексацию на вкладке `/site/<id>?tab=indexing` проверяют платные сервисы (XMLRiver и
подобные, `/api/indexing/xmlriver`). Бесплатный Google URL Inspection API уже подключён
(`/api/indexing/sitemap/check-google`), но запускается только кнопкой по выделенным URL.

Руслан прислал `oussch702/google-index-checker`. Внутри — тот же URL Inspection API:
квота 2000 проверок в день и 600 в минуту на ресурс, только чтение. Нового API у нас не
появится. Экономия получится из **автоматизации**: планировщик каждый день тратит бесплатную
квоту по умной очереди. Тогда платные проверки нужны только для сайтов, которых нет в Search
Console, и для объёмов сверх 2000 в день.

## Факты об API, на которых всё держится
- `searchconsole.urlInspection.index.inspect({ inspectionUrl, siteUrl })` работает только для
  подтверждённого ресурса (`Site.siteId`) и только от аккаунта, у которого к нему есть доступ.
  Как перебирать аккаунты — смотри обработчик `inspect_url` в `src/lib/mcp/tools.ts`
  (`getUserGoogleAccounts`, `makeOAuth2` из `src/lib/gscQuery.ts`).
- Квота: **2000/день и 600/мин на ресурс**. День считается по `America/Los_Angeles`: в
  полночь по Тихоокеанскому времени квота сбрасывается. В Салониках это 10:00 летом.
- Ответ: `inspectionResult.indexStatusResult` → `verdict`, `coverageState`, `lastCrawlTime`,
  `googleCanonical`, `userCanonical`, `robotsTxtState`, `indexingState`, `pageFetchState`.
- Ошибка квоты — 429 или сообщение с `quota`. Эвристика уже есть в `gscSync.ts`
  (`isQuotaError`, строка ~64): переиспользуй импортом, если она экспортирована; если нет —
  продублируй в своём модуле и напиши об этом в отчёте.

## Что сделать

### 1. Чистая логика — `src/lib/indexing/queue.ts`
- `pacificDay(d)` через `Intl.DateTimeFormat("en-CA", { timeZone: INSPECTION_TZ })`.
  Тесты на переход через полночь PT и на смену летнего времени.
- `isIndexedCoverage(coverageState, verdict)`: `verdict === "PASS"` → `true`;
  `coverageState` из «Submitted and indexed», «Indexed, not submitted in sitemap» → `true`;
  «Crawled - currently not indexed», «Discovered - currently not indexed», «URL is unknown to
  Google», «Excluded by 'noindex' tag», «Duplicate…», «Page with redirect», «Not found (404)»,
  «Soft 404», «Blocked by robots.txt», «Alternate page with proper canonical tag» → `false`;
  всё остальное → `null`. Сравнение без регистра; английские строки — единственные, которые
  отдаёт API.
- `pickInspectBatch(rows, now, limit)` — порядок приоритетов:
  1. `new` — `googleChecked == null`, свежие `firstSeenAt` первыми;
  2. `changed` — `changeStatus ∈ {added, changed, restored}` и `googleChecked` старше `lastSeenAt`
     (контент поменялся после прошлой проверки);
  3. `not_indexed` — `googleNextCheck ≤ now` и прошлый статус «не в индексе»;
  4. `stale_indexed` — `googleNextCheck ≤ now` и прошлый статус «в индексе».
  URL с `inventoryStatus ≠ "active"` не берутся. Внутри одного приоритета — стабильный порядок.
- `nextCheckAt(outcome, settings, now)`: в индексе → `+recheckIndexedDays`; не в индексе →
  `+recheckNotIndexedDays`; ошибка API → `+1 день`; к каждому сроку — детерминированный
  джиттер ±10 % по хешу URL, чтобы 1000 URL, проверенных в один день, не вернулись в очередь
  тоже в один день.

### 2. Квота — `src/lib/indexing/quota.ts`
- Строка `InspectionQuota` на `(property, pacificDay(now))`. Инкремент — атомарный `upsert`
  с `increment`.
- `remainingToday(property, autoBudget)` = `max(0, min(INSPECTION_DAILY_LIMIT − used, autoBudget − auto))`,
  а при `exhaustedAt` за сегодня — 0.
- **Все три пути пишут в ledger:**
  - автопроверка → `recordInspections(p, n, { auto: true })`;
  - ручная кнопка → правка в `src/app/api/indexing/sitemap/check-google/route.ts` (файл твой);
  - MCP `inspect_url` → строка в обработчике в `tools.ts`.
  Ручные проверки **не** ограничиваются бюджетом автопроверки, но при `exhaustedAt` за сегодня
  ручной путь сразу отвечает понятной ошибкой вместо 2000 запросов, каждый из которых вернёт 429.

### 3. Проверка — `src/lib/indexing/inspect.ts`
`inspectUrls(userId, siteDbId, urls, { auto })`:
- последовательно, не больше `INSPECTION_PER_MINUTE` в минуту (пауза ≥ 1 с между запросами);
- на ошибке квоты — `recordInspections(…, { exhausted: true })` и немедленный выход с
  `quotaExhausted: true` у оставшихся;
- запись в `SitemapUrl`: существующие `googleStatus` (= `coverageState ?? verdict`),
  `googleCoverage`, `googleReason`, `googleChecked` плюс новые `googleVerdict`,
  `googleLastCrawl`, `googleCanonical` (только если отличается от URL), `googleNextCheck`;
- `PageInspectionHistory` — строка **только при смене статуса** (unique `[siteId, url, date]`,
  `date` = начало дня UTC). Так же пиши `PageInspection` (последний статус), если его читает UI
  вкладки (проверь использование в `src/app/api/gsc/inspect/route.ts`);
- каждый вызов Google — через журнал провайдеров (`loggedFetch` или обёртку, которой
  пользуется `gscSync.ts`), с провайдером `google_url_inspection` и стоимостью 0.

### 4. Планировщик — `src/lib/indexing/scheduler.ts`
- Тик раз в **10 минут**. Для каждого сайта с `indexInspect.on`: порция = `ceil(remaining /
  оставшиеся до полуночи PT 10-минутные слоты)`, но не больше 100 за тик. Квота размазывается
  по суткам, а выпавшая страница находится в течение дня, а не через сутки.
- Сайты одного владельца — по очереди (round-robin), чтобы один сайт на 5000 URL не съедал весь
  тик.
- **Покрытие за день:** раз в сутки (первый тик после 00:00 UTC) для каждого сайта с `on`
  пересчитать `IndexCoverageDaily` из `SitemapUrl` (`active`): `indexed`, `notIndexed`,
  `unknown`, `reasons` по `googleCoverage`.
- **Алерт о выпадении** (`alertOnLoss`): URL сменил статус «в индексе» → «не в индексе» и у него
  есть клики за 28 дней в `DailyMetric` (`url = <URL>`, `query` любой, `searchType = "web"`).
  Одно сообщение на сайт в сутки: `indexLossTitle` / `indexLossMsg` из `notifyI18n.ts`,
  до 10 строк «URL — coverageState — N кликов», остальное — «и ещё N». Отправка
  `notifyUser(owner, text, { event: "index" })`, дедупликация через `AlertEvent`
  (`type: "index_loss"`, `dedupeKey: index_loss:<siteId>:<utcDay>`).
- Всё внутри `withCallContext`.

### 5. API — `src/app/api/indexing/auto/**` (контракт §4)
`POST …/run` — ручной запуск пачки: бесплатно, тратит квоту, право `act`. Лимит — 200.

### 6. UI — `src/components/IndexAutoPanel.tsx` (T0 вставил его в начало вкладки Indexing)
- Шапка: `idxAutoTitle`, подпись `idxAutoFree`, текст `idxAutoHint`.
- Переключатель `idxAutoOn`, поле `idxAutoBudget` (0…1800), два поля перепроверки,
  `idxAutoAlertLoss`.
- Строка квоты: `idxAutoQuota` + полоса прогресса; при исчерпании — `idxAutoExhausted`.
- Очередь: четыре числа по `idxAutoPri_*`.
- График покрытия за 90 дней: stacked area из трёх рядов (в индексе / не в индексе /
  неизвестно). Перед графиком прочитай skill `dataviz` (есть в окружении агента) или повтори
  стиль существующих графиков сайта.
- `idxAutoReasons`: таблица «причина → количество». Клик фильтрует существующую таблицу URL
  вкладки. Если для этого нужна правка `page.tsx`, **не делай** — опиши в отчёте.
- `idxAutoLosses`: последние выпадения с кликами.
- Кнопка `idxAutoRunNow` → `POST …/run`, результат — `idxAutoRunDone`.
- Нет Google-аккаунта с доступом к ресурсу → `idxAutoNoGoogle` вместо формы.

### 7. MCP — `toolsIndex.ts`
`get_index_coverage` (`local`): `site` → `IndexAutoStatus`.

### 8. Документация — `docs/INDEX-AUTOCHECK.md`
Как устроена квота (2000 в день на ресурс, полночь PT), очередь приоритетов, почему это
заменяет платные проверки для своих сайтов, когда платные всё ещё нужны (сайт не в GSC,
больше 2000 URL в день, чужие сайты), как читать причины. **Честно:** URL Inspection
сообщает, что знает Google, но индексацию не запрашивает. Для отправки на индексацию остаются
IndexNow и индексаторы.

## Не делать
- Не запрашивать индексацию через Indexing API: официально он только для JobPosting и
  BroadcastEvent.
- Не парсить выдачу `site:` через A-Parser как «бесплатный» путь: у Руслана Google-прокси
  сейчас ловят капчу (см. историю SERP Monitor). Это в бэклоге.
- Не трогать платные маршруты (`xmlriver`, `neural`, `2index`).

## Тесты — `src/lib/indexing/*.test.ts`
- `pacificDay`: 2026-10-01T06:59Z → «2026-09-30», 07:00Z → «2026-10-01» (PDT, UTC−7); зимой
  граница в 08:00Z.
- `pickInspectBatch`: порядок приоритетов; неактивные пропущены; `limit` соблюдён.
- `nextCheckAt`: три ветки и джиттер в пределах ±10 %, детерминированный для одного URL.
- `isIndexedCoverage`: таблица строк.
- `remainingToday` — арифметика на чистой функции (вынеси её отдельно от Prisma).

## Проверка
```bash
npx tsx --test src/lib/indexing/*.test.ts
npm run check
npx eslint src/lib/indexing src/components/IndexAutoPanel.tsx src/app/api/indexing/auto src/app/api/indexing/sitemap/check-google src/lib/mcp/toolsIndex.ts
```
Ручная — пункт 4 чеклиста `README.md` §8.
