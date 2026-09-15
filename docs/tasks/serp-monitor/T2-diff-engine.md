# T2 — Движок сравнения (чистая логика)

**Ветка:** `feat/serpmon-t2` от `feat/serp-monitor`.
**Файлы:** `src/lib/serpmon/hosts.ts`, `noise.ts`, `diff.ts`, `volatility.ts` и
`hosts.test.ts`, `noise.test.ts`, `diff.test.ts`, `volatility.test.ts` в той же папке.

**Никаких импортов** из `@/lib/prisma`, `next/*`, `fs`, `net`. Только `./types`. Эти модули
импортирует и сервер, и (частично) клиент. Сигнатуры и правила — `CONTRACT.md` §0, §3.1–3.4.
Это ядро модуля: если здесь ошибка, врут все три вкладки, поэтому тестов много.

## hosts.ts
- `hostOfUrl`: `new URL()`, только `http:`/`https:`, `hostname` в нижнем регистре, без
  завершающей точки, без `www.` (только одного ведущего), IDN оставить как отдаёт `URL`
  (punycode), длина > 191 → `null`. IP-адреса — допустимые хосты.
- `hostMatches(host, entries)`: `host === e || host.endsWith("." + e)`.
- `parseHostList`: принимает и URL, и голые хосты (`https://www.site.com/x` → `site.com`).

Тесты: `m.facebook.com` — платформа; `netflix.com`, `vox.com`, `1xbet.com` — **не** `x.com`;
`es.wikipedia.org` — платформа; `apps.apple.com` — платформа, `apple.com` — нет;
`WWW.Site.COM.` → `site.com`; `ftp://…`, `javascript:…`, мусор → `null`;
`www.www.site.com` → `www.site.com`.

## noise.ts
Правила `classifySnapshot` — по порядку из контракта. Детали:
- `providerError` может быть одним из кодов `SnapshotProblem` (T1 отдаёт их без префикса) —
  тогда `problem` = этот код; `"timeout"` распознаётся и в тексте вида `…: timeout`; иное —
  `"provider_error"`;
- `totalCount` числом считается только после удаления пробелов/разделителей тысяч
  (`"1 230 000"`, `"1,230,000"`, `"1.230.000"`); не распарсился — «неизвестно»;
- `expected = depth`, если `totalCount` неизвестен; иначе `min(depth, totalCount)`;
- `rows.length ≥ ceil(SHORT_RESULT_RATIO × expected)` → `ok`.

Тесты: 100/100 → ok; 85/100 → ok; 79/100 → partial `short_result`; 12 из 100 при
`totalCount "12"` → ok; 0 при `"0"` → ok; 0 без `totalCount` → failed
`aparser_blocked_or_empty`; `providerError "aparser_parser_failed"` → failed с этим кодом;
`"сеть A-Parser (host:9091): timeout"` → failed `timeout`; `comparableDepth` для всех
сочетаний статусов.

## diff.ts
- `hostPositions`: строки с `position > depth` не учитываются; хост → `best` (минимум),
  `urls` (число строк); порядок — по `best`.
- `diffKeyword`: вход — строки, `depth` — уже согласованная глубина (`comparableDepth`).
  Порог движения — по полосе `min(from, to)` из `MOVE_THRESHOLDS`.
  `urls` у изменения — из текущего списка (для `exit` — из прошлого).
  Сортировка — как в контракте, при равенстве — по имени хоста (детерминизм для тестов).
  `volatility = 1 − rboExt(prevHosts, curHosts, RBO_P_FULL)`, списки хостов обрезаны до
  одинаковой длины `min(len)`; `volTop10` — то же на первых 10 хостах с `RBO_P_TOP10`.
  Округлять до 4 знаков.

Тесты (минимум):
- одинаковые списки → нет изменений, `volatility 0`;
- **девять URL одного хоста выпали** → одно изменение `exit`, `urls: 9` (регрессия из поста);
- хост сменил URL, позиция та же → нет изменений;
- хост на 95 → 99 при depth 100 → нет изменения (порог 15);
- 2 → 6 → `down` (порог 3); 25 → 31 → нет (полоса по min=25, порог 7); 25 → 33 → `down`;
- прошлый 100 строк, нынешний 60, хост был на 80 → при `depth = 60` **не** `exit`;
- facebook вошёл → изменение есть, `hidden: true`, `visibleCount` его не считает,
  `volatility > 0`;
- полная замена списка → `volatility 1`;
- перестановка двух соседей в топ-3 даёт `volTop10` больше, чем такая же перестановка на 90-м
  месте даёт `volatility` (проверка, что RBO весит верх).

## volatility.ts
- `rboExt` — формула из контракта, O(k) с инкрементальным пересечением (множества).
  Списки разной длины — обрезать до меньшей. Дубли внутри списка — считать первое вхождение.
- `median`, `mad`, `quantile` (линейная интерполяция, `q` в [0,1]) — без мутации входа.
- `stormVerdict` и `shareAboveOwnP90` — по контракту.

Тесты:
- `rboExt(A, A) = 1`; `rboExt(A, disjoint) = 0`; `rboExt([], []) = 1`;
- ручной пример: `A = [a,b,c]`, `B = [b,a,c]`, `p = 0.9` → **0.9**
  (X₁=0, X₂=2, X₃=3; Σ = 0 + 0.81 + 0.729 = 1.539; (0.1/0.9)·1.539 = 0.171; + 1·0.729 = 0.9);
- симметричность `rboExt(A,B) = rboExt(B,A)`;
- `stormVerdict`: 6 точек фона → `calibrating`, `storm false`; фон `[0.10 × 20]` с шумом ±0.01
  и `current 0.30`, `shareHigh 0.5` → шторм; тот же `current`, `shareHigh 0.1` → не шторм;
  `current = median` → `score ≈ 0`; нулевой MAD не даёт деления на ноль;
  `compared 5 из 944` → `score null`;
- `shareAboveOwnP90`: у запросов меньше 5 точек истории — не считаются; все такие → `null`.

## Проверка
`npx tsx --test src/lib/serpmon/{hosts,noise,diff,volatility}.test.ts`, затем `npm run check`,
`eslint`, `tsc`. В отчёт — число тестов.
