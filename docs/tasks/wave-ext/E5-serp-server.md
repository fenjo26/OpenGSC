# E5 — серверная часть оверлея и донора

Всё, что расширение спрашивает про хосты и выдачу, и всё, что оно может сделать с выдачей:
сохранить её, добавить запрос в трекеры, поставить домен на наблюдение, проверить клоакинг.
Плюс вкладка «Снимки из браузера» в SERP Monitor и инструмент MCP.

Владеешь: `src/app/api/ext/hosts/**`, `src/app/api/ext/serp/**`,
`src/app/api/ext/cloak/route.ts`, `src/lib/ext/hostIntel.ts`, `src/lib/ext/hostIntelPure.ts`,
`src/lib/ext/serpCapture.ts`, `src/lib/ext/snippet.ts`, тесты
`src/lib/ext/{hostIntel,serpCapture,snippet}.test.ts`, `src/app/api/serpmon/captures/**`,
`src/components/serpmon/CapturesTab.tsx`, `src/lib/mcp/toolsSerpCaptures.ts`.

Модули `serpmon/**`, `drops/**`, `footprint/**`, `seo/googlebot.ts` — только импортировать.
Не хватает экспорта — опиши в отчёте, R решит.

## 1. Сигнатуры

```ts
// src/lib/ext/hostIntelPure.ts — pure, tested
export function normaliseHosts(raw: unknown[], max: number): string[];            // hostOfUrl (bare host → prefix "https://" first: hostOfUrl needs a URL), dedupe, keep order, cap
export function pickDr(c: {
  serpmon?: { dr: number | null; at: Date | null } | null;
  metric?: { dr: number | null; at: Date | null } | null;
  drCache?: { dr: number | null; at: Date | null } | null;
}): { dr: number | null; source: "serpmon" | "metric_cache" | "dr_cache" | null; at: Date | null }; // freshest non-null; tie → serpmon > metric > dr_cache
export function rankProjects<T extends { country: string; lang: string; keywords: number }>(rows: T[], country: string, lang: string, max: number): T[];
export function weightedPosition(rows: { impressions: number; position: number }[]): number | null;
export function sameApex(a: string, b: string): boolean;                          // apexOf(a) === apexOf(b), null-safe

// src/lib/ext/hostIntel.ts — DB
export async function hostIntel(userId: string, req: HostsRequest): Promise<HostsResponse>;
export async function enrichHosts(userId: string, hosts: string[]): Promise<EnrichResponse>;

// src/lib/ext/serpCapture.ts
export function validateCapture(body: unknown):
  { ok: true; value: CaptureRequest & { keyword: string } } | { ok: false; error: string };     // pure
export async function saveCapture(userId: string, input: CaptureRequest & { keyword: string }): Promise<CaptureResponse>;
export interface CaptureListItem { id: string; keyword: string; engineHost: string; country: string; lang: string; page: number; got: number; capturedAt: string; projectId: string | null; keywordId: string | null; features: string[] }
export interface CaptureView extends CaptureListItem {
  rows: { position: number; url: string; host: string; title: string; snippet: string }[];
  compare: null | { snapshotId: string; takenAt: string; depth: number; changes: HostChange[] };
}
export async function listCaptures(userId: string, q: { projectId?: string; keyword?: string; limit: number }): Promise<CaptureListItem[]>;
export async function captureView(userId: string, id: string, compare?: "nearest" | string): Promise<CaptureView | null>;
export async function deleteCapture(userId: string, id: string): Promise<boolean>;

// src/lib/ext/snippet.ts — pure, tested
export function snippetFragments(snippet: string): string[];
export function snippetFound(snippet: string, pageText: string): boolean | null;
```

## 2. `hostIntel` — один вызов, фиксированное число запросов

Хостов до 100. Число SQL-запросов **не должно зависеть от числа хостов**: каждый источник —
один `findMany` с `in` (пачки ≤ 400 параметров). Ниже — источники; для каждого хоста ищем и по
самому хосту, и по его registrable (`apexOf`).

| Поле | Источник |
|---|---|
| `own` | `Site` владельца; совпадение по `matchPortfolioSite` (`urlMatch.ts`), передавая `https://<host>/` |
| `ownPbn` | `PbnSite` (`userId`, `domain in registrables`) |
| `dr`, `drSource`, `drCheckedAt` | `SerpHost` (`host in`), `DomainMetricCache` (`domain in registrables`, самая свежая строка любого провайдера), `DrCache` (`domain in registrables`) → `pickDr` |
| `refdomains` | `SerpHost.refdomains`, иначе `DomainMetricCache.refDomains` |
| `ageMonths` | `calcAgeMonths(SerpHost.registeredAt, now)` из `serpmon/domains.ts` |
| `serpmon` | проекты владельца — прямой `serpProject.findMany` (нужны `ownDomains`, `ignoreHosts`, `firstRunAt`, которых нет в `listProjects`), `SerpProjectHost` (`projectId in`, `hostId in`) → `rankProjects(…, 3)`; теги — `domainTags(row, ctx)` из `serpmon/domains.ts` (собери `row` так же, как это делает `domainRows`: прочитай его и повтори нужные поля; `isPlatform` — `ignorePredicate` из `serpmon/hosts.ts` с `ignoreHosts` проекта, `maxAgeMonths` — `YOUNG_HOST_MONTHS`) |
| `linksToUs` | `SiteBacklink` по сайтам владельца, `domainFrom in (hosts ∪ registrables ∪ www-варианты)` → группировка по сайту; `live` — строки без `apiLost` |
| `outreach` | `OutreachProspect` (`userId`, `domain in`) |
| `drops`, `asset` | `DropCandidate` / `DropAsset` (`userId`, `domain in registrables`) |

**`query`** (только если прислан):
- `own` — `QueryPageDaily` (`siteId in` сайты владельца, `query = q`, `date ≥ now − 28 д`),
  сгруппировать по сайту и URL, позиция — `weightedPosition`. Сначала проверь на инстансе
  Руслана через MCP `execute_sql_query`, что `QueryPageDaily` заполняется (`SELECT COUNT(*)`
  за последние 7 дней). Если пусто — используй `DailyMetric` с `query = q`, как в `page/route.ts`,
  и напиши это в отчёте;
- `tracked` — `TrackedKeyword` (`siteId in`, `keyword = q`);
- `serpmon` — `SerpKeyword` (`projectId in` проекты владельца, `keyword = normaliseKeyword(q)`)
  + `storm` последнего done-прогона проекта (`SerpRun`, `status: "done"`, последний по `startedAt`);
- `metrics` — `KeywordMetricCache` (`keyword = q`, `country = gl || "us"`), самая свежая.
  **Никогда не ходить к провайдеру.**

`missing` — сколько хостов без `registeredAt` и без DR из всех трёх источников.

Нет таблиц → `{ notMigrated: true, hosts: [], query: null, missing: {age:0, dr:0} }` (поймать
`schemaMissing`, `extTablesMissing`, `footprintSchemaMissing` — какие нужны). Частично
отсутствующие таблицы (например, нет `PbnSite`) — не повод падать целиком: соответствующее
поле `null`/`[]`, ошибка в `console.warn` один раз.

Цель по скорости: ≤ 300 мс на 100 хостов на SQLite Руслана. Замерь и напиши в отчёте.

## 3. Роуты

**`POST /api/ext/hosts`** — `extAuth(req, "read")`; хостов больше `EXT_HOSTS_MAX` →
`400 too_many_hosts`; иначе `hostIntel`.

**`POST /api/ext/hosts/enrich`** — `extAuth(req, "act")`; ≤ `EXT_ENRICH_MAX` хостов.
`ensureHosts(hosts)` → id → `enrichPendingHosts({ userId, hostIds, limit: EXT_ENRICH_MAX, deadline: Date.now() + EXT_ENRICH_DEADLINE_MS, what: "both" })`
внутри `withCallContext` (как в `serpmon/scheduler.ts`), `remaining` — сколько из присланных
всё ещё без возраста или DR. Возраст (RDAP/WHOIS) и DR через бесплатный эндпоинт — это сеть,
но не деньги. Рефдомены (платные) здесь **не** запрашиваются.

**`POST /api/ext/serp/capture`** — `extAuth(req, "write")` → `validateCapture` → `saveCapture`.

`validateCapture`: `query` → `normaliseKeyword` (иначе `400 invalid_query`); `engineHost`
должен соответствовать `/^www\.google\.[a-z]{2,3}(\.[a-z]{2})?$/` (иначе `400 invalid_engine`);
URL — `http(s)` и не частный (`hostOfUrl` даёт хост), дубликаты URL убрать (первая позиция
побеждает), позиции — строго возрастающие (иначе пересчитать от `startPos` по порядку);
обрезать title/snippet; неизвестные `features` выбросить; ≤ `EXT_CAPTURE_ROWS_MAX` строк;
`page` 1…10, `startPos` 1…100.

`saveCapture`:
1. `ensureUrls(rows.map(r => ({ url, host, title })))` из `serpmon/store.ts` — тот же словарь,
   что у снимков. Посчитай `newHosts` (какие хосты не существовали до вызова: один `findMany`
   до `ensureUrls`).
2. Проект: `SerpProject` владельца с `country === gl && lang === hl` (оба известны), у которого
   есть `SerpKeyword` с этим `keyword` → `projectId`, `keywordId`. Таких несколько — тот, где
   ключевое слово активно, затем самый свежий `lastRunAt`. Не нашли — оба `null`.
3. Дубликат: такая же запись (`userId`, `keyword`, `engineHost`, `page`) моложе
   `EXT_CAPTURE_DEDUPE_MS` → обновить её (`updated: true`), иначе создать.
4. Новые хосты → `enrichPendingHosts({ hostIds: новые, limit: 20, deadline: +15 c, what: "both" })`
   **без await** (fire-and-forget с `.catch(() => {})`, внутри `withCallContext`): каталог доменов
   наполняется сам, пользователь не ждёт.

Снимок из браузера **никогда** не пишется в `SerpSnapshot`, не трогает `SerpKeyword.last*`,
`SerpProjectHost`, `SerpChange`. Это зафиксировано в комментарии модели — не нарушай.

**`POST /api/ext/serp/action`** — `extAuth(req, "write")`, разбор по `kind`:

- `rank_track`: сайт владельца (`Site.id`, `userId`) → иначе `404 site_not_found`. Нормализация
  ключа — как в `POST /api/rank/keywords` (нижний регистр, схлопнуть пробелы, ≤ 200),
  `location` — `validateLocation(undefined)` из `seo/localPack.ts` (так получится то же значение
  по умолчанию, что у роута). `country` 2 буквы (`""` → `"us"`, как в роуте), `lang`, `device`.
  `prisma.trackedKeyword.create`; уникальное нарушение → `added: false` и id существующей
  строки (найти по `@@unique`).
- `serpmon_keyword`: `addKeywords(userId, projectId, query, "add")` из `serpmon/store.ts`;
  `null` → `404 project_not_found`; `added: result.added > 0`.
- `drops_watch`: `apexOf(host)` → `null` → `400 invalid_host`. Нет `DropCandidate` с этим
  доменом → `createRun(userId, { raw: domain, label: "extension", source: "csv" })` из
  `drops/store.ts` (`inserted: true`). Затем `setWatchedByDomains(userId, [domain], true)`.

**`POST /api/ext/cloak`** — `extAuth(req, "act")` + свой лимитер
`new SlidingWindowRateLimiter(EXT_CLOAK_PER_MIN, 60_000)` по `auth.userId` → `429 rate_limited`.
`assertSafeTarget(url)` (как в `/api/seo/googlebot`: `private_address` → `400 private_host`).
`analyzeUrl(url, { samples: 1, referer: true, wayback: false })` — `referer: true` важен: в
гемблинге клоакинг обычно по Referer с выдачи, а не по User-Agent.

Сборка `CloakResponse`:
- `bot` — первая view с UA Googlebot, `browser` — desktop-браузер (ищи по `ua` и ключам `UA` в
  `googlebot.ts`); `status` = `finalStatus`, `title` = `signals.title`, `snippetFound` =
  `snippetFound(snippet, view.bodyText)`;
- `verdict`: `antiBot.blocked && !antiBot.bypassed` или `blocked` у bot-view → `"blocked"`; худший
  из `diff.verdict` и `refererDiff?.verdict`: `cloaking`/`suspicious` → `"differs"`,
  `clean` → `"same"`, `unknown` → `"error"`; исключение при запросе → `"error"`;
- `reasons` — `diff.flags` + `refererDiff.flags` (без дублей) + `snippet_only_bot` /
  `snippet_only_browser`, если сниппет найден только с одной стороны, + `anti_bot:<provider>`.

Если сниппет есть у бота и нет у браузера, а `diff` говорит clean, итог — `"differs"`.
Именно так выглядит клоакинг, при котором выдача показывает одно, а человеку — другое.

## 4. `snippet.ts`

`snippetFragments`: убрать дату в начале («12 мар. 2025 г. —», «Mar 12, 2025 —» — регуляркой
по шаблону «число месяц число — »), разрезать по `...`/`…`, нормализовать (нижний регистр,
NFKC, пунктуация → пробел, схлопнуть), оставить куски ≥ 4 слов.
`snippetFound`: пустой snippet или пустой текст страницы → `null`; иначе `true`, если хотя бы
половина кусков (округление вверх) — подстроки нормализованного текста.

## 5. SERP Monitor — «Снимки из браузера»

**API** (`workspaceUserId()` для GET, `workspaceUserId("write")` для DELETE):
- `GET /api/serpmon/captures?projectId=&keyword=&limit=` → `{ captures }` (по `capturedAt`
  desc; `projectId` — снимки с этим проектом **плюс** «свободные» (`projectId null`) с
  совпадающими `country/lang` проекта — их помечаем `loose`);
- `GET /api/serpmon/captures/[id]?compare=nearest|<snapshotId>` → `CaptureView`. `nearest` —
  `SerpSnapshot` того же `keywordId` со статусом `ok|partial`, ближайший по `takenAt` (до или
  после). Сравнение — `diffKeyword(snapshotRows, captureRows, { depth, ignore })` из
  `serpmon/diff.ts`, где `depth` = последняя позиция снимка из браузера (обычно 10), `ignore` —
  `ignorePredicate` проекта. Это только просмотр: ничего не сохраняется.
- `DELETE /api/serpmon/captures/[id]`.

**`CapturesTab.tsx`**: таблица снимков (запрос, домен Google, регион, стр., строк, когда,
фичи-пилюли, пометка «свободный»). Клик → панель снимка: позиции с хостом, title и сниппетом.
Переключатель «Сравнить с ближайшим автоматическим снимком» → рядом позиции снимка и чипы
изменений (`ChangeChip` из `components/serpmon`). Вверху подпись: «Снято из вашего браузера:
персонализированная выдача с вашего IP. В диффы и штормы не входит». Пусто → инструкция: «Включите
оверлей в расширении и нажмите “Сохранить выдачу”». Нет таблицы → «выполните `npx prisma db push`».
Стиль — как у `DomainsTab`/`StormsTab` (токены, `.card`, `.pill`), 360 px, privacy blur на
хостах.

**MCP** — `serpmon_captures` (контракт §6): без `captureId` → `listCaptures`; с ним →
`captureView`.

## 6. Тесты

- `hostIntel.test.ts` — чистые функции `hostIntelPure.ts`: `normaliseHosts` (URL, `www.`,
  регистр, мусор, дубликаты, лимит), `pickDr` (свежесть, null, ничья), `rankProjects` (совпадение
  региона первым, неизвестный регион → все по `keywords`), `weightedPosition`, `sameApex`
  (двухуровневые суффиксы).
- `serpCapture.test.ts` — `validateCapture`: каждый код ошибки, дедуп URL, пересчёт позиций,
  обрезка, фичи.
- `snippet.test.ts` — даты в начале на en/ru/el/it, многоточия, `null`-случаи, порог «половина
  кусков».

Руками: через расширение (E4) или `curl` с заголовком `Origin: chrome-extension://<id>` и
токеном — по одному запросу на каждый роут; результат в отчёт.

## 7. Ключи приложения (en · ru; остальные 5 языков переводит E0)

| ключ | en | ru |
|---|---|---|
| `serpmonCaptureTitle` | Browser captures | Снимки из браузера |
| `serpmonCaptureNote` | Taken from your browser: personalised results from your IP. Not part of diffs or storms. | Снято из вашего браузера: персонализированная выдача с вашего IP. В диффы и штормы не входит. |
| `serpmonCaptureEmpty` | No captures yet. Turn on the overlay in the extension and press “Save these results”. | Снимков пока нет. Включите оверлей в расширении и нажмите «Сохранить выдачу». |
| `serpmonCaptureQuery` | Query | Запрос |
| `serpmonCaptureEngine` | Google domain | Домен Google |
| `serpmonCaptureRegion` | Region | Регион |
| `serpmonCapturePage` | Page | Стр. |
| `serpmonCaptureRows` | Results | Результатов |
| `serpmonCaptureWhen` | Captured | Снято |
| `serpmonCaptureLoose` | not linked | без проекта |
| `serpmonCaptureCompare` | Compare with the nearest automated snapshot | Сравнить с ближайшим автоматическим снимком |
| `serpmonCaptureNoSnapshot` | No automated snapshot of this keyword to compare with | Нет автоматического снимка этого запроса для сравнения |
| `serpmonCaptureDelete` | Delete | Удалить |
| `serpmonCaptureDeleteConfirm` | Delete this capture? | Удалить снимок? |
