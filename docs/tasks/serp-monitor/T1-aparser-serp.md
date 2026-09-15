# T1 — A-Parser как SERP-провайдер

**Ветка:** `feat/serpmon-t1` от `feat/serp-monitor` (после T0).
**Файлы:** `src/lib/seo/serp.ts`, `src/lib/seo/aparserSerp.ts`, `src/lib/seo/aparserServerCreds.ts`,
`src/lib/seo/aparserCatalog.ts`, `src/lib/rank.ts`, `scripts/aparser-serp-probe.ts`,
`src/lib/serpmon/aparserSerp.test.ts`, `src/lib/serpmon/__fixtures__/**`.

Контекст: `src/lib/seo/aparser.ts` (транспорт — **читать, не править**), `docs/GEO-APARSER.md`,
`src/app/api/aparser/route.ts` (как сервер собирает креды), `src/lib/seo/geoAparser.ts`
(как уже сделан маппинг для другого парсера — повторяй подход).

## Зачем
В `runSerp` до сих пор нет ветки `aparser` (см. комментарий у `SELF_HOSTED_PROVIDERS` в
`serp.ts`). Без неё SERP Monitor не может снять выдачу. Заодно она закрывает остаток issue #5 —
A-Parser в Rank Tracker.

## Главный риск: id опций
Google убрал `num=100` (сентябрь 2025), поэтому топ-100 — это ~10 страниц, и глубина задаётся
опцией парсера «количество страниц». Документация называет опции словами, а `options`
требует внутренние id. **Id берутся только из пресета живого инстанса** (`getParserPreset`).
Поэтому сначала пробный скрипт, потом код.

### 1. `scripts/aparser-serp-probe.ts`
Запуск: `npx tsx scripts/aparser-serp-probe.ts "<запрос>" <gl> <hl> [depth=100]`.
Креды: `OPENGSC_APARSER_BASE_URL` / `OPENGSC_APARSER_PASSWORD`, иначе из настроек владельца
в базе (как `getAparserServerCreds`). Печатает:
1. `availableParsers` содержит `SE::Google` или нет;
2. `getParserPreset SE::Google default` — все id опций и значения (это главный вывод);
3. результат `oneRequest` с `aparserSerpOptions(...)`: число строк `serp`, первые 3 строки,
   `totalcount`, какие ещё ключи есть в `results[0]` (для `features`);
4. время запроса.
Пароль в вывод не попадает никогда. Скрипт — образец `scripts/easygr-probe.ts`.

Если у тебя нет доступа к живому A-Parser (песочница без сети) — напиши скрипт, оставь
`APARSER_SERP_OPTION_IDS` с id, которые считаешь верными по документации A-Parser, пометь
каждый комментарием `// UNVERIFIED — run scripts/aparser-serp-probe.ts` и вынеси это первым
пунктом отчёта. Руслан запустит скрипт, и R поправит id до сборки.

### 2. `src/lib/seo/aparserSerp.ts` (чистый, сигнатуры — `CONTRACT.md` §3.5)
- `aparserSerpOptions({ depth, gl, hl })` → `override`-опции: страниц = `ceil(depth / 10)`
  (не больше 10), страна, язык. Всё, что меняет ответ, — явным override, пресету не верим.
- `mapAparserSerp(row, want)`:
  - `problem = parserResultProblem(row, ["serp"])`; при `problem` — `results: []`;
  - берёт `row.serp[]`: URL из `link` (или того поля, что покажет проба), заголовок из
    `anchor`/`title`, сниппет из `snippet`;
  - отбрасывает строки без http(s) URL; дедуп по точному URL (первое вхождение);
  - `position` = порядковый номер после дедупа, 1-based; `domain` — как `domainOf` в `serp.ts`;
  - обрезка до `want`;
  - `totalCount` — `String(row.totalcount ?? "")`;
  - `features` — нормализованные id из того, что есть в `row` (`related` → `"related"`,
    блок вопросов → `"paa"`, …), неизвестное не выдумывать.
- Никогда не читать `resultString`.

### 3. `serp.ts`
- расширения `SerpOptions.configPreset`, `SerpResponse.totalCount`, `SerpResponse.features`
  (`CONTRACT.md` §3.5);
- `PROVIDER_ENGINES.aparser = ["google"]`;
- `aparserSearch(password, keyword, opts)`: `resolveBaseUrl(opts.baseUrl)` → при `problem`
  вернуть `error` с этим кодом; `aparserOneRequest(creds, "SE::Google", keyword, options,
  { timeoutMs: 180_000 })` (10 страниц дольше 2 минут на медленных прокси);
  ошибка транспорта → `error`; `mapAparserSerp(data.results?.[0], num)`; `problem` →
  `error: problem` **ровно кодом**;
- ветка в `runSerp` до `serper`.

### 4. `aparserServerCreds.ts`
`getAparserServerCreds(userId)`: `getUserSettings(userId)` (из `lib/mcp/shared`), URL через
`resolveBaseUrl(settings.seoBaseUrl_aparser)`, пароль `envPassword() || settings.seoKey_aparser`,
`configPreset` из `settings.seoAparserConfig`, `setAparserConcurrency(settings.seoAparserConcurrency)`
если число. Нет URL или пароля → `null`. Образец — `src/app/api/aparser/route.ts`.

### 5. `aparserCatalog.ts`
`SE::Google` → `wired: true`.

### 6. Rank Tracker — **отдельным коммитом**, чтобы R мог его не брать
В `rank.ts`: `MAX_DEPTH.aparser = 100`; `"aparser"` в списке запасных провайдеров
`getUserSerpCreds` (после `scrapingrobot`); `scan()` передаёт `baseUrl` (уже передаёт) —
проверь, что `configuredIn` для `aparser` учитывает env-переменные: сейчас он смотрит только
`seoBaseUrl_aparser` в настройках, и при конфигурации через env Rank Tracker A-Parser не
увидит. Почини через `resolveBaseUrl`/`envPassword`, не ломая остальные провайдеры.
`SE::Google::Position` не использовать (см. заметку в `aparser.ts`: его режимы сопоставления
не повторяют `matchesSite()`).

## Тесты — `src/lib/serpmon/aparserSerp.test.ts`
Фикстуры `src/lib/serpmon/__fixtures__/aparser-serp-*.json` (если есть живой вывод пробы —
возьми его, вычистив лишнее; если нет — собери по документированной форме и назови
`*-synthetic.json`). Минимум:
- 100 строк → 100 результатов, позиции 1…100;
- дубль URL на двух страницах → одна строка, позиции без дыр;
- строка без `link` / с `javascript:` → отброшена;
- `serp: []` + `totalcount: 0` → `problem: null`, пусто;
- `serp: []` без `totalcount` → `problem: "aparser_blocked_or_empty"`;
- `success: 0` → `"aparser_parser_failed"`;
- `want = 20` → 20;
- `aparserSerpOptions({ depth: 100 })` → страниц 10; `depth: 20` → 2; `depth: 15` → 2;
- `runSerp("aparser", "", …)` → `no_serp_key`; без `baseUrl` → `no_serp_base_url`;
  `engine: "bing"` → отказ с текстом про поддерживаемые движки.

## Проверка
`npm run check`, `eslint` по своим файлам, `tsc`. Если есть живой A-Parser — вывод пробы
целиком (без пароля) в отчёт.
