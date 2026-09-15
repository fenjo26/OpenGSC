# T4 — Каталог доменов

**Ветка:** `feat/serpmon-t4` от `feat/serp-monitor`.
**Файлы:** `src/lib/serpmon/enrich.ts`, `domains.ts`, `domains.test.ts`,
`src/app/api/serp-monitor/projects/[id]/domains/**`, `src/app/api/serp-monitor/projects/[id]/export/**`,
`src/lib/drops/registries.ts` — **только** дописать суффиксы в `TWO_LABEL_SUFFIXES`.

Читать: `CONTRACT.md` §3.9, §4; `src/lib/drops/availability.ts` (`checkAvailabilityBatch` —
возвращает `createdAt` для зарегистрированных), `src/lib/drops/registries.ts` (`apexOf`,
`profileForDomain`, `registryAnswerable`), `src/lib/drops/drFree.ts` (`drForDomains`,
`keyFound`), `src/lib/seo/drHistory.ts` (`recordDrSnapshots`).

Смысл вкладки «Домены» — ответы из поста: кто из новорегов уже в топе, кто держит больше всего
запросов, кто растёт, кто прыгает туда-обратно.

## 1. Суффиксы
`apexOf` знает только перечисленные двухуровневые зоны. Для LatAm их нет, и
`pba.betsson.bet.ar` превратится в «регистрируемый» `bet.ar` — возраст будет чужой.
Допиши в `TWO_LABEL_SUFFIXES` (только то, что подтверждается списком NIC соответствующей
страны или Public Suffix List — сверь, не выдумывай):
`com.ar, net.ar, org.ar, gob.ar, tur.ar, bet.ar, com.co, net.co, org.co, gov.co, com.pe, net.pe,
org.pe, gob.pe, com.ec, com.uy, com.py, com.bo, com.ve, com.cy, com.sg, com.my, com.ph, com.vn,
co.id, co.th, com.eg, com.sa`.
Сомнительные (`bet.ar`, `tur.ar`) — отдельной строкой с комментарием источника. Существующие
тесты drops должны остаться зелёными.

## 2. domains.ts
- `domainTags` — чистая функция по правилам `CONTRACT.md` §3.9.
  `ageMonths` считает `domainRows`: полные месяцы между `registeredAt` и `now`.
- `rebuildProjectHosts(projectId, runId)`:
  1. последние ok|partial съёмы активных запросов (`SerpKeyword.lastSnapshotId`);
  2. распаковать `rows` → по хосту: множество запросов, лучшая позиция на запрос;
  3. `keywords`, `top10`, `top30`, `bestPos`, `avgPos` (среднее лучших позиций по запросам);
  4. `prevKeywords` ← текущее `keywords` записи до обновления;
  5. `firstSeenAt` — только при создании записи (`takenAt` съёма), `lastSeenAt` — `takenAt`;
     хосты, которых больше нет ни в одном последнем съёме, → `keywords = 0`, `top10 = top30 = 0`,
     `bestPos = avgPos = null` (запись не удалять — история «кто ушёл» ценна);
  6. `bounces` — число пар `enter` → `exit` одного хоста на одном запросе, где между ними
     не больше `BOUNCE_RUNS` прогонов (по `SerpChange` за последние `2 × BOUNCE_RUNS` прогонов).
  Пачки ≤ 400 параметров, одна транзакция на пачку. 944 запроса × 100 строк — в пределах
  нескольких секунд; если дольше — напиши в отчёте, сколько и почему.
- `domainRows(userId, projectId, q)`: проверка владельца, join `SerpProjectHost` + `SerpHost`,
  фильтр `preset` (для `new`/`young`/`rising`/`falling`/`bounced` — те же правила, что в
  `domainTags`, выраженные в `where`, а где нельзя — фильтровать после выборки, но тогда
  `total` должен быть честным), `q` — подстрока хоста, `includePlatforms` (по умолчанию
  `false`), сортировка, пагинация (≤ 200). По умолчанию скрыты хосты с `keywords = 0`,
  кроме пресета `falling`.

## 3. enrich.ts
`enrichPendingHosts({ limit, deadline, userId?, hostIds?, what? })`:
- **Возраст.** Кандидаты — `ageCheckedAt IS NULL` или (`ageError IS NOT NULL` и старше 7 дней);
  при `hostIds` — только они. Группировать по `registrable` (один запрос к реестру на
  регистрируемое имя, результат — всем его хостам). Пустой `registrable` или зона без
  `registryAnswerable` → `ageError = "no_registry"` без сетевого запроса.
  `checkAvailabilityBatch(names, { deadlineMs: deadline − now })` — троттлинг по реестрам уже
  внутри. `registered` + `createdAt` → `registeredAt`; `registered` без даты →
  `ageError = "no_date"`; `available` → `ageError = "not_registered"` (бывает у мусорных
  хостов); `rate_limited`/ошибка → `ageError` = статус, `ageCheckedAt` = сейчас (повтор через
  7 дней). Прокси-пул drops не использовать (это отдельная настройка того модуля).
- **DR.** Кандидаты — `drCheckedAt` пусто или старше 30 дней, только хосты, которые сейчас
  есть хотя бы в одном проекте (`SerpProjectHost.keywords > 0`), не платформы.
  `drForDomains(userId, registrables)` (его собственный лимит — не больше `FREE_CAP` за вызов).
  `keyFound: false` → ничего не писать и вернуть это наружу (роут скажет «нет ключа»).
  Записать `dr`, `drCheckedAt`, и `recordDrSnapshots` для истории, если сигнатура позволяет.
- Для планировщика (без `userId`) — только возраст: DR требует ключ конкретного пользователя.
  Порядок — сначала хосты с `SerpProjectHost.top30 > 0` (важнее), потом остальные.
- Никогда не бросает наружу; ошибки — в счётчик `errors`.

## 4. API
- `GET /projects/[id]/domains` — `DomainQuery` из query-строки → `domainRows`.
- `POST /projects/[id]/domains/enrich` — `act`; один шаг ≤ 45 с (`deadline`), `limit` 100;
  ответ `{ age, dr, errors, remaining, keyFound? }`, где `remaining` — сколько кандидатов этого
  проекта ещё ждут. Клиент зовёт повторно, пока `remaining > 0` и пользователь не нажал «стоп».
- `GET /projects/[id]/export?kind=keywords` — активные запросы, по одному на строку, без
  заголовка (для Ahrefs Keywords Explorer). `kind=domains` — те же фильтры, что у
  `domains`, все страницы, колонки: `domain, registrable, keywords, prev_keywords, top10, top30,
  best, avg, first_seen, registered, age_months, dr, tags`. UTF-8 с BOM, `;`-разделитель не
  нужен — запятая и кавычки по RFC 4180. Имя файла `serpmon-<project-slug>-<kind>-<YYYY-MM-DD>.csv`.

## 5. Тесты — `domains.test.ts`
Только чистое: `domainTags` (все теги; «на первом прогоне новых нет»; `ageMonths` на границе;
`own` по границе точки; `platform` для `m.facebook.com`), и вынеси в чистую функцию и
протестируй подсчёт `bounces` по списку изменений, и CSV-экранирование (запятая, кавычка,
перевод строки в значении).

## Проверка
`npm run check` (включая тесты drops — ты правил `registries.ts`), `eslint`, `tsc`.
