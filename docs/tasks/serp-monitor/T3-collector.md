# T3 — Сборщик, хранилище, планировщик, API

**Ветка:** `feat/serpmon-t3` от `feat/serp-monitor`.
**Файлы:** `src/lib/serpmon/store.ts`, `collector.ts`, `scheduler.ts`, `keywords.ts`,
`keywords.test.ts`, всё в `src/app/api/serp-monitor/**`, **кроме**
`projects/[id]/domains/**`, `projects/[id]/export/**`, `projects/[id]/test-alert/**`.

Читать перед началом: `CONTRACT.md` §3.6–3.8, §4, §5, §6; образцы —
`src/lib/drops/store.ts` (`schemaMissing`, чанки, раздел insert/update),
`src/lib/drops/scheduler.ts` (тик, бюджет, выключение без таблиц),
`src/lib/rankScheduler.ts` (`withCallContext`, `resolveCaptureBodies`),
`src/app/api/drops/runs/route.ts` (права, `notMigrated`).

Функции T1 (`runSerp` с веткой aparser, `getAparserServerCreds`), T2 (`hosts/noise/diff/volatility`),
T4 (`rebuildProjectHosts`, `enrichPendingHosts`), T6 (`serpmonRunAlerts`) до сборки — заглушки
T0. Пиши против сигнатур; логику, которую можно проверить без БД, выноси в чистые функции.

## keywords.ts (чистый) + тесты
`normaliseKeyword`, `parseKeywordImport` по контракту. Тесты: заголовок `keyword,group`
пропускается; `casino online;LatAm` → группа; табуляция приоритетнее запятой, если есть обе
(«первый найденный разделитель» считается слева направо — зафиксируй в тесте);
дубли с разным регистром/пробелами → один + `duplicates`; пустые строки и строки > 191 →
`skipped`; BOM в начале; `\r\n`.

## store.ts
- Все функции из контракта; проверка владельца в каждой.
- **Словари.** `ensureHosts(hosts: string[]): Map<string, number>` и
  `ensureUrls(rows: {url,host,title}[]): Map<string, number>` (ключ — sha1 URL через
  `node:crypto`): прочитать существующие пачками ≤ 400, вставить недостающие, обновить
  `lastSeenAt`/`title` одним `updateMany` там, где можно. При вставке хоста —
  `registrable = apexOf(host) ?? ""` (`lib/drops/registries.ts`). Гонка двух вставок одного
  хоста (два прогона параллельно) — поймать P2002 и перечитать.
- **Запись съёма** — `writeSnapshot(...)` одной транзакцией: `SerpSnapshot` (`rows` —
  `JSON.stringify([[pos, urlId], …])`), `SerpChange[]` (у `hostId` из словаря, `hidden` из
  diff), обновление `SerpKeyword` (`lastStatus`, `lastProblem`; для ok|partial — ещё
  `lastSnapshotId`, `lastOkAt`, `lastChangeCount`, `lastVolatility`).
- **`marketRows`** — пагинация по `SerpKeyword` проекта (активные), фильтры `q` (подстрока
  запроса), `group`, `changedOnly` (`lastChangeCount > 0`), `host` (есть в последнем съёме —
  через `SerpChange`/`rows`; проще всего: найти `hostId`, затем съёмы `lastSnapshotId`, где он
  есть в `rows` — делай двумя запросами, не LIKE по JSON). `leaders` — первые 3 разных хоста
  `lastSnapshotId`. `changes` — `SerpChange` этого съёма, в порядке контракта. `own` — лучшая
  позиция хоста из `ownDomains` (по границе точки). `all` — число активных запросов без фильтров.
- **`keywordHistory`** — последние `limit` съёмов (все статусы), `hosts` — до 10 хостов с
  наибольшим числом появлений в них; `series[i] = best` или `null`.
- **`snapshotView`** — развернуть `rows` через `SerpUrl`/`SerpHost`; `compare` — указанный
  или `prevId`; `diff` пересчитать `diffKeyword` на лету (дёшево, 100 строк).
- `ProjectSummary.volatilitySeries` — одним запросом по `SerpRun` для всех проектов пользователя.
- `RunSummary.calibrating` в базе не хранится: `true`, если у проекта до этого прогона меньше
  `STORM_MIN_BASELINE` прогонов `done` с ненулевой `volatility` (для списка — одним подсчётом
  на проект, не запросом на каждый прогон).
- Валидация `ProjectInput`: `country` — 2 буквы и есть в `lib/seo/regions.ts`; `lang` — пусто →
  `defaultLanguageFor(country)`; `depth ∈ SERPMON_DEPTHS`; `intervalHours ∈ SERPMON_INTERVALS`;
  `name` 1–120 символов; запросов после импорта ≤ `SERPMON_MAX_KEYWORDS`;
  `retentionDays` 30–3650. Ошибка — `throw` с кодом, роут переводит в 400.
- `nextRunAt` при создании — `now` (первая проверка в ближайший тик), если `intervalHours > 0`.
- Режим `replace` у запросов: отсутствующие в новом списке — `active = false` (история
  сохраняется), присутствующие — `active = true`, новые — создать.

## collector.ts
По алгоритму `CONTRACT.md` §5. Уточнения:
- `advanceRun` выбирает «ещё не снятые» как активные запросы проекта без `SerpSnapshot`
  с этим `runId` (уникальный ключ `[runId, keywordId]` защищает от двойной записи — ловить P2002
  и считать запрос снятым).
- Если креды пропали посреди прогона — оставшиеся запросы пишутся `failed / no_creds` без
  вызова провайдера, прогон завершается.
- Съём одного запроса в `try/catch`: исключение → `failed / provider_error`, прогон
  продолжается.
- `SerpRun.ok/partial/failed` — инкремент после каждой записи (прогресс для UI).
- `finalizeRun`: история для `shareAboveOwnP90` — `volatility` последних
  `KEYWORD_P90_WINDOW` сравнённых съёмов каждого запроса **до** текущего прогона;
  фон для `stormVerdict` — `volatility` последних `STORM_BASELINE_RUNS` прогонов `done`
  с ненулевой `volatility`. `rebuildProjectHosts` и `serpmonRunAlerts` — каждый в своём
  `try/catch`: их падение не должно оставить прогон в `running`.
- Прореживание — §6 контракта.

## scheduler.ts
§5 контракта, п.2. `kickSerpmonScheduler` — `setTimeout(tick, 0)`, если тик не идёт.
Логи — с префиксом `[serpmon-cron]`, без ключей и паролей.

## API
Таблица `CONTRACT.md` §4, строки с владельцем T3. Каждый handler: `workspaceUserId(<право>)`
→ 401; `schemaMissing` → `notMigrated`; валидация тела; ответы строго по типам из `types.ts`.
Параметры динамических сегментов — как в существующих `[id]`-роутах этого репо (Next 16).
`POST /projects/[id]/run` → `startRun(..., "manual", { force })` и статусы из контракта.
Тело `POST /projects` — не больше 8 МБ (как в drops).

## Проверка
- `npx tsx --test src/lib/serpmon/keywords.test.ts`;
- `npm run check`, `eslint` по своим файлам, `tsc`;
- если у тебя есть Мак с базой: на копии базы `db push`, создать проект через `curl`,
  запустить прогон с настоящим A-Parser **после** того, как T1 и T2 влиты в твою ветку
  локально (`git merge feat/serpmon-t1 feat/serpmon-t2` во временной ветке — не пушить),
  и приложить к отчёту: время прогона на N запросов, число ok/partial/failed, размер
  `SerpSnapshot.rows` в байтах.
