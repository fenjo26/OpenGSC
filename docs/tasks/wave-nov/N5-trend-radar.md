# N5 — Trend radar: растущие запросы и подсказки Google

**Ветка:** `feat/wave-nov-n5`. **Владение:** `README.md` §4, строка N5 (включая `src/app/demand/**`
и `src/lib/digest.ts`). Дока — `docs/TRENDS.md`.

## Зачем
В гемблинге трафик приходит волнами: вышел новый слот, у провайдера вышел релиз, в Греции
изменился закон. Кто первым написал страницу — тот и собрал. TrendWatch и DispatchSEO решают это
платным API трендов. У нас бесплатные источники лучше: собственный GSC (реальные показы) и
подсказки Google (что начинают искать).

## Источники
1. **`gsc_rising`** — запросы сайта, у которых показы за последние 7 дней выросли против
   среднего за 7 дней в предыдущих 28 (`DailyMetric`, `query ≠ ''`, `searchType = "web"`).
   Условие: ≥ 30 показов за 7 дней и рост ≥ ×2 (константы). `score = log2(рост) × log10(показы)`.
   Учти задержку данных GSC (2–3 дня): окно «последние 7 дней» заканчивается на последней
   дате с данными, а не на сегодня.
2. **`gsc_new`** — запросы, которых не было за 60 дней, а за последние 7 дней ≥ 10 показов.
3. **`suggest`** — подсказки Google по сидам (`TrendSeed`, пользователь вводит «slot»,
   «pragmatic play», «taxi thessaloniki»). Эндпоинт
   `https://suggestqueries.google.com/complete/search?client=firefox&hl=<lang>&gl=<gl>&q=<seed>`
   плюс алфавитное расширение (`seed a`, `seed b`… — 26 + цифры, только по кнопке «глубоко»).
   Через `safeFetch`, пауза ≥ 1 с, ≤ 50 запросов на сайт за прогон. **Новое** в подсказках
   (не было в прошлом прогоне) → `score = 1`, повторяется — `score` растёт на 0,5 за прогон до 3.
   Если Google отдал не-200 или капчу — прогон этого источника пропускается, в UI «недоступно
   сегодня», без ретраев-молотилки.

Хранение — `TrendItem` (upsert по `siteId, source, query`), `lastSeenAt`; пропавшие из
источника 14 дней — скрываются.

## Планировщик — `src/lib/trends/scheduler.ts`
Раз в сутки на сайт (для сайтов с хотя бы одним сидом или с GSC-данными): все три источника.
Уведомление `trendsTitle/Msg` (событие `trend`), если есть новые позиции со score выше порога
(≤ 8 строк), раз в сутки, дедуп через `AlertEvent`.

## Дайджест — `src/lib/digest.ts`
Секция `digestTrends` с 5 лучшими трендами по портфелю за период дайджеста (если есть).
Только добавление секции — остальной дайджест не менять.

## UI — `TrendRadar.tsx` на странице `/demand`
Блок над существующим содержимым (или вкладкой — посмотри, как устроена страница):
селектор сайта, сиды (чипы, добавить/удалить), три колонки/фильтра по источнику, строка —
запрос, источник, рост (`×3.2`, показы 7д / до), впервые замечен, кнопки «Скрыть», «Отслеживать
позицию» (добавить в Rank Tracker через существующий API), «Сделать аутлайн» (открыть
`/seo-tools/outline` с ключом). Подпись «бесплатно · GSC и подсказки Google».

## MCP — `get_trends` (local).

## Тесты — `src/lib/trends/*.test.ts`
Расчёт роста и окна с учётом задержки данных; `gsc_new` против 60-дневной истории; разбор ответа
suggest (`["seed", ["a","b"]]`); «новое против прошлого прогона»; порог и лимит запросов.

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `trTitle` | Trend radar | Trend radar |
| `trHint` | Rising queries from your Search Console and new Google suggestions. Free. | Растущие запросы из вашего Search Console и новые подсказки Google. Бесплатно. |
| `trSeeds` | Seed words | Сиды |
| `trSeedAdd` | Add seed | Добавить сид |
| `trSource_gsc_rising` | Rising in GSC | Растёт в GSC |
| `trSource_gsc_new` | New in GSC | Новое в GSC |
| `trSource_suggest` | Google suggest | Подсказки Google |
| `trGrowth` | ×{x} | ×{x} |
| `trImpr` | {now} / {before} impressions | {now} / {before} показов |
| `trFirstSeen` | First seen | Впервые замечен |
| `trTrack` | Track position | Отслеживать позицию |
| `trOutline` | Create outline | Сделать аутлайн |
| `trHide` | Hide | Скрыть |
| `trDeep` | Deep (a–z) | Глубоко (a–z) |
| `trUnavailable` | Google suggest unavailable today | Подсказки Google сегодня недоступны |
| `trRunNow` | Refresh | Обновить |
| `trEmpty` | Nothing rising yet | Пока ничего не растёт |
