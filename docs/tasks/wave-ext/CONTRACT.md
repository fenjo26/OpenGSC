# Волна «Расширение» — контракт

Единственный источник имён. Если бриф и контракт расходятся — прав контракт; расхождение
опиши в отчёте. Код ниже — литеральный: копируй, а не пересказывай.

---

## 1. Prisma (E0)

Одна новая модель. В `schema.prisma` — сразу после `SerpProjectHost`.

```prisma
// ─── Browser SERP captures (wave-ext E5) ─────────────────────────────────────
// One Google results page saved from the browser extension. Deliberately NOT a SerpSnapshot:
// it was taken from the user's own IP/account (personalised, usually one page deep), so it never
// enters diffs, storms, volatility baselines, SerpProjectHost or retention thinning. Rows reuse
// the SerpUrl/SerpHost dictionaries, so the domain catalogue (age/DR) and enrichment work on it.
model SerpCapture {
  id         String   @id @default(cuid())
  userId     String                          // workspace owner (extAuth → auth.userId)
  projectId  String?                         // SerpProject that tracks this keyword in the same country/lang; null = loose
  keywordId  String?                         // SerpKeyword in that project, when it exists
  keyword    String                          // normaliseKeyword(); ≤ 191
  engineHost String                          // "www.google.gr"
  country    String   @default("")           // gl as detected, 2 letters lower-case; "" = unknown
  lang       String   @default("")           // hl as detected; "" = unknown
  device     String   @default("desktop")    // desktop | mobile
  page       Int      @default(1)            // 1-based results page
  startPos   Int      @default(1)            // absolute position of the first organic row on the page
  got        Int      @default(0)            // organic rows stored
  // JSON: [position, urlId][] ordered by position — the same shape as SerpSnapshot.rows
  rows       String   @default("[]")
  // JSON: string[] — subset of CAPTURE_FEATURES (§3)
  features   String   @default("[]")
  // JSON: { position: number; title: string; snippet: string }[] — title ≤ 200, snippet ≤ 300 chars
  snippets   String   @default("[]")
  note       String   @default("")
  capturedAt DateTime @default(now())

  @@index([userId, capturedAt])
  @@index([projectId, keyword])
}
```

Для MySQL `keyword` в индексе объявить так же, как `SerpKeyword.keyword` (посмотри, как это
сделано там, и повтори; `schema.mysql.prisma` генерируется сам).

`extTablesMissing()` в `auth.ts` трогать нельзя. Отсутствие `SerpCapture` E5 ловит через
`schemaMissing()` из `src/lib/serpmon/store.ts`.

---

## 2. Серверные типы — `src/lib/ext/types.ts` (E0, дальше не меняется)

```ts
// wave-ext — wire shapes of the extension API. Pure types and constants; no imports from Prisma.
import type { DomainTag } from "@/lib/serpmon/types";
import type { MetaFitResult } from "@/lib/seo/metaLimits";

// ─── limits ──────────────────────────────────────────────────────────────────
export const EXT_HOSTS_MAX = 100;            // hosts per /api/ext/hosts call
export const EXT_CAPTURE_ROWS_MAX = 100;     // organic rows per capture
export const EXT_ENRICH_MAX = 20;            // hosts per /api/ext/hosts/enrich call
export const EXT_ENRICH_DEADLINE_MS = 20_000;
export const EXT_CLOAK_PER_MIN = 6;          // extra per-token limit on /api/ext/cloak
export const EXT_CAPTURE_DEDUPE_MS = 10 * 60_000; // same user+keyword+engineHost+page → update, not insert
export const EXT_QUERY_WINDOW_DAYS = 28;
export const EXT_SNIPPET_MAX = 300;
export const EXT_TITLE_MAX = 200;

// ─── /api/ext/lists (E0) ─────────────────────────────────────────────────────
export interface ListsResponse {
  sites: { id: string; label: string }[];
  projects: { id: string; name: string; country: string; lang: string }[];
}

// ─── /api/ext/hosts ──────────────────────────────────────────────────────────
export interface HostsRequest {
  hosts: string[];          // ≤ EXT_HOSTS_MAX; any form — server normalises with hostOfUrl()
  query?: string;           // the SERP query, when called from the overlay
  country?: string;         // gl, "" when unknown
  lang?: string;            // hl, "" when unknown
}

export interface HostSerpmon {
  projectId: string;
  projectName: string;
  keywords: number;         // SerpProjectHost.keywords
  top10: number;
  bestPos: number | null;
  firstSeenAt: string;      // ISO
  tags: DomainTag[];
}

export interface HostLinksToUs {
  siteId: string;           // Site.id
  label: string;            // host of the site, no scheme
  links: number;            // SiteBacklink rows with domainFrom = this host (apex match)
  live: number;             // of them not apiLost
}

export interface HostIntel {
  host: string;             // normalised (hostOfUrl)
  registrable: string;      // apexOf(host); "" when unknown
  own: { siteId: string; label: string; openPath: string } | null;     // a portfolio site
  ownPbn: { pbnSiteId: string; status: string } | null;                // PbnSite.domain = registrable
  dr: number | null;
  drSource: "serpmon" | "metric_cache" | "dr_cache" | null;            // where `dr` came from
  drCheckedAt: string | null;
  refdomains: number | null;
  ageMonths: number | null; // calcAgeMonths(SerpHost.registeredAt)
  serpmon: HostSerpmon[];   // ≤ 3, projects matching country/lang first (all projects when unknown)
  linksToUs: HostLinksToUs[];
  outreach: { prospectId: string; stage: string } | null;
  drops: { candidateId: string; stage: string; watched: boolean } | null;
  asset: { assetId: string; stage: string } | null;                    // DropAsset (bought drop)
}

export interface QueryOwnRow {
  siteId: string;
  label: string;
  url: string;
  clicks: number;
  impressions: number;
  position: number;         // impression-weighted over the window, 1 decimal
}

export interface QueryIntel {
  query: string;            // normaliseKeyword()
  windowDays: number;       // EXT_QUERY_WINDOW_DAYS
  own: QueryOwnRow[];       // QueryPageDaily rows of this exact query, any portfolio site
  tracked: { siteId: string; label: string; keywordId: string; lastPosition: number | null; lastUrl: string | null; lastCheckedAt: string | null }[];
  serpmon: { projectId: string; projectName: string; keywordId: string; lastStatus: string; lastOkAt: string | null; lastRunStorm: boolean }[];
  metrics: { volume: number | null; difficulty: number | null; cpc: number | null; checkedAt: string } | null; // KeywordMetricCache only — never fetched
}

export interface HostsResponse {
  hosts: HostIntel[];       // same order as the request, de-duplicated
  query: QueryIntel | null; // null when no `query` was sent
  missing: { age: number; dr: number };  // hosts whose age / DR are unknown — "fill in for free"
  notMigrated?: true;
}

// ─── /api/ext/hosts/enrich ───────────────────────────────────────────────────
export interface EnrichRequest { hosts: string[] }           // ≤ EXT_ENRICH_MAX
export interface EnrichResponse { age: number; dr: number; errors: number; remaining: number }

// ─── /api/ext/serp/capture ───────────────────────────────────────────────────
export const CAPTURE_FEATURES = ["ai_overview", "paa", "local_pack", "top_stories", "video", "images", "shopping", "knowledge_panel", "sitelinks"] as const;
export type CaptureFeature = (typeof CAPTURE_FEATURES)[number];

export interface CaptureResult {
  position: number;         // absolute (startPos-based)
  url: string;
  title: string;            // ≤ EXT_TITLE_MAX
  snippet: string;          // ≤ EXT_SNIPPET_MAX
}

export interface CaptureRequest {
  query: string;
  engineHost: string;
  country: string;
  lang: string;
  device: "desktop" | "mobile";
  page: number;
  startPos: number;
  results: CaptureResult[]; // ≤ EXT_CAPTURE_ROWS_MAX
  features: string[];       // unknown values are dropped server-side
  note?: string;
}

export interface CaptureResponse {
  ok: true;
  captureId: string;
  updated: boolean;         // true when an EXT_CAPTURE_DEDUPE_MS duplicate was overwritten
  projectId: string | null;
  keywordId: string | null;
  newHosts: number;         // SerpHost rows created by this capture
}

// ─── /api/ext/serp/action ────────────────────────────────────────────────────
export type SerpAction =
  | { kind: "rank_track"; query: string; siteId: string; country: string; lang: string; device: "desktop" | "mobile" }
  | { kind: "serpmon_keyword"; query: string; projectId: string }
  | { kind: "drops_watch"; host: string };

export type SerpActionResponse =
  | { ok: true; kind: "rank_track"; added: boolean; keywordId: string | null }
  | { ok: true; kind: "serpmon_keyword"; added: boolean }
  | { ok: true; kind: "drops_watch"; inserted: boolean; watched: boolean; domain: string };

// ─── /api/ext/cloak ──────────────────────────────────────────────────────────
export interface CloakRequest { url: string; title?: string; snippet?: string }
export type CloakVerdict = "same" | "differs" | "blocked" | "error";
export interface CloakView {
  status: number | null;
  finalUrl: string | null;
  title: string | null;
  snippetFound: boolean | null;   // null when no snippet was sent or the body is empty
}
export interface CloakResponse {
  verdict: CloakVerdict;
  reasons: string[];        // machine codes from diffViews + "snippet_only_bot" | "snippet_only_browser" | "anti_bot:<name>"
  bot: CloakView;           // Googlebot UA
  browser: CloakView;       // desktop browser UA
  checkedAt: string;
}

// ─── /api/ext/insights (E2) ──────────────────────────────────────────────────
export interface InsightsRequest {
  url: string;
  title: string;            // as on the live page
  description: string;
  h1: string;               // first H1 text
}

export interface FootprintHit {
  kind: "title" | "description" | "h1";
  skeleton: string;         // this page's skeleton, "{x}" for entities
  matches: { siteLabel: string; url: string; text: string; similarity: number }[]; // ≤ 5, other sites only
}

export interface InsightsResponse {
  inPortfolio: boolean;
  mainQuery: { query: string; clicks: number; impressions: number; position: number } | null; // top query by clicks over EXT_QUERY_WINDOW_DAYS
  titleMatchesMainQuery: boolean | null;  // pageMatchesQuery(title, h1, mainQuery.query); null without a main query
  inSitemap: boolean | null;              // active SitemapUrl row exists; null when the site has no sitemap inventory at all
  meta: { title: MetaFitResult | null; description: MetaFitResult | null }; // fitMetaLocal (free, code-only); null when the live value is already inBand or there is no main query
  footprint: FootprintHit[];              // only kinds that have matches
  notMigrated?: true;
}

// ─── /api/ext/meta-fit (E2) ──────────────────────────────────────────────────
export interface ExtMetaFitRequest {
  url: string;
  title: string;
  description: string;
  language?: string;        // page <html lang>, "" when unknown
  allowLlm?: boolean;       // false = pure string work ("act"); true = up to 2 repair calls ("spend")
  confirm?: boolean;        // required with allowLlm
}
export interface ExtMetaFitResponse { title: MetaFitResult | null; description: MetaFitResult | null; llmCalls: number }
```

`MetaFitResult` — из `src/lib/seo/metaLimits.ts` (поле, before/after, длина, метод, `inBand`).
Бесплатный путь — `fitMetaLocal()`, платный — `fitMeta()` из `src/lib/seo/metaFit.ts`.

---

## 3. API (E0 кладёт заглушки, владельцы — по таблице)

Все роуты: `extAuth(req, cap)` → тело → ответ с `headers: auth.auth.cors`; `OPTIONS` →
`extPreflight(req)`. Ошибки — `{ error: "<code>" }` с кодом статуса.

| Метод и путь | Право | Стоимость | Владелец | Тело → ответ |
|---|---|---|---|---|
| `GET /api/ext/lists` | read | local | **E0** (полностью) | → `ListsResponse` |
| `POST /api/ext/hosts` | read | local | E5 | `HostsRequest` → `HostsResponse` |
| `POST /api/ext/hosts/enrich` | act | net (RDAP/WHOIS, бесплатный DR) | E5 | `EnrichRequest` → `EnrichResponse` |
| `POST /api/ext/serp/capture` | write | local | E5 | `CaptureRequest` → `CaptureResponse` |
| `POST /api/ext/serp/action` | write | local | E5 | `SerpAction` → `SerpActionResponse` |
| `POST /api/ext/cloak` | act | net (2 запроса к странице) | E5 | `CloakRequest` → `CloakResponse` |
| `POST /api/ext/insights` | read | local | E2 | `InsightsRequest` → `InsightsResponse` |
| `POST /api/ext/meta-fit` | act / spend | local / paid | E2 | `ExtMetaFitRequest` → `ExtMetaFitResponse` |
| `GET /api/serpmon/captures?projectId=&keyword=&limit=` | read (сессия) | local | E5 | → `{ captures: CaptureListItem[] }` |
| `GET /api/serpmon/captures/[id]?compare=nearest\|<snapshotId>` | read (сессия) | local | E5 | → `CaptureView` |
| `DELETE /api/serpmon/captures/[id]` | write (сессия) | local | E5 | → `{ ok: true }` |

Существующие `GET /api/ext/page`, `POST /api/ext/index-queue`, `POST /api/ext/outreach`,
`/api/ext/token` не меняются.

`CaptureListItem` и `CaptureView` E5 объявляет в `src/lib/ext/serpCapture.ts` (это внутренние
формы UI приложения, расширение их не читает).

Коды ошибок, которые клиенты обязаны показать человеческим текстом: `invalid_url`,
`too_many_hosts`, `private_host`, `confirm_required`, `project_not_found`, `site_not_found`,
`rate_limited`, `forbidden`, `not_migrated`.

---

## 4. Расширение — файлы и порядок загрузки (E0)

```
extension/
  manifest.json            E0
  background.js            E0  importScripts: lib/api.js, lib/protocol.js, lib/settings.js,
                               lib/googleDomains.js, bg/menus.js, bg/panel.js, bg/serp.js
  bg/menus.js              E0  перенос текущего кода контекстного меню и sendUrl без изменений
  bg/panel.js              E1  setPanelBehavior, открытие панели, ext:open-panel
  bg/serp.js               E4  регистрация content-скрипта оверлея, кеш hosts
  lib/api.js               E0  + новые методы (ниже)
  lib/protocol.js          E0  имена сообщений и whitelist путей
  lib/settings.js          E0  чтение/запись настроек, разрешения, регистрация оверлея
  lib/googleDomains.js     E0  список доменов поиска Google
  lib/audit.js             E1  + facts.detail
  lib/csv.js               E1
  lib/vitals.js            E1
  lib/highlight.js         E1
  lib/export.js            E1
  lib/donor.js             E3
  lib/serpParse.js         E4
  content.js               E1  возвращает PageScan (§4.3)
  sidepanel.html/.css      E1  (E0 кладёт с готовыми <script> всех модулей панели)
  panel/core.js            E1  реестр вкладок, отслеживание активной вкладки, инъекция
  panel/tab-page.js        E1  вкладки разбора страницы
  panel/tab-opengsc.js     E2
  panel/tab-donor.js       E3
  serp/overlay.js          E4  content-скрипт выдачи
  popup.html/.js/.css      E1
  options.html/.js/.css    E0
```

### 4.1 `manifest.json` (E0)

Изменения относительно N11:

```json
{
  "version": "1.1.0",
  "permissions": ["activeTab", "contextMenus", "storage", "scripting", "sidePanel", "tabs"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "side_panel": { "default_path": "sidepanel.html" },
  "minimum_chrome_version": "116"
}
```

Из `action` убирается `default_popup`: клик по иконке открывает панель
(`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`, это делает `bg/panel.js`).
Если `chrome.sidePanel` нет (старый браузер), `bg/panel.js` возвращает попап через
`chrome.action.setPopup({ popup: "popup.html" })`. Попап остаётся как запасной вариант.

`tabs` нужен панели, чтобы видеть URL активной вкладки при переключении (без него `tab.url`
пустой). Статических `content_scripts` **нет**: оверлей регистрируется через
`chrome.scripting.registerContentScripts`, когда пользователь включил его и выдал разрешение на
домены Google. Ключ `key` в manifest не добавлять: ID распакованного расширения считается от
пути, и уже выданный токен с allowlist продолжит работать.

### 4.2 `lib/settings.js` (E0)

```js
// ExtSettings.get() → Promise<Settings>; ExtSettings.set(patch) → Promise<Settings>
// Settings (chrome.storage.local, key "extSettings"):
{
  panelAllSites: false,        // true only after chrome.permissions.request({origins:["http://*/*","https://*/*"]}) succeeded
  serpOverlay: false,          // on/off
  serpDomains: ["www.google.com"], // subset of GOOGLE_SEARCH_HOSTS the user enabled AND granted
  serpCompact: false,          // one-line chips only
  defaultSiteId: "",           // Site.id for "Track in Rank Tracker" when no own site is on the SERP
  defaultProjectId: ""         // SerpProject.id for "Add to SERP Monitor"
}
// ExtSettings.requestAllSites() / requestSerpDomains(hosts) — must be called from a click handler.
// ExtSettings.syncOverlayRegistration() — (un)registers content script id "opengsc-serp":
//   matches: serpDomains.map(h => "https://" + h + "/search*"),
//   js: ["lib/protocol.js", "lib/serpParse.js", "serp/overlay.js"], runAt: "document_idle", allFrames: false.
// Called by options on change and by background on startup/onInstalled.
```

`lib/googleDomains.js` экспортирует `GOOGLE_SEARCH_HOSTS` — массив `www.google.<tld>` для всех
доменов поиска Google (источник — https://www.google.com/supported_domains; список вшит, не
грузится). В настройках — поле с поиском и чекбоксами; по умолчанию предложены `com`, а также
домены по языку UI браузера.

### 4.3 Что возвращает инъекция (`content.js`, E1)

Панель вызывает `chrome.scripting.executeScript({ target: { tabId }, files: PANEL_INJECT })`,
где

```js
var PANEL_INJECT = ["lib/audit.js", "lib/csv.js", "lib/vitals.js", "lib/donor.js", "content.js"]; // panel/core.js
```

Результат последнего файла — `PageScan` (может быть Promise: Chrome ≥ 98 его дожидается):

```js
PageScan = {
  ok: true,
  url: string, host: string,
  facts: Facts,                 // текущая форма N11 БЕЗ изменений + новое поле facts.detail
  issues: Issue[],              // deriveIssues(facts) — N11 + новые id из брифа E1
  vitals: Vitals,               // ExtVitals.collect()
  donor: DonorFacts,            // ExtDonor.collect(document) — E3, §4.5
  selection: { text, inTable, csv }   // как в N11
}
```

`facts.detail` (E1 заполняет, E2 и E3 читают):

```js
detail = {
  lang: string, charset: string, viewport: string, robotsMeta: string, xRobots: null,
  canonical: string, title: string, description: string,
  headings: [{ level: 1..6, text: string /*≤200*/, hidden: boolean }],          // ≤ 500, порядок HTML
  links: [{ href: string, text: string /*≤120*/, rel: string[], internal: boolean,
            area: "content" | "nav" | "header" | "footer" | "aside" | "top" | "other",
            index: number }],                                                     // ≤ 2000
  images: [{ src: string, alt: string | null, width: number, height: number,
             hasDims: boolean, lazy: boolean, ext: string, area: string }],      // ≤ 1000
  jsonLd: [{ types: string[], valid: boolean, error: string }],
  microdataTypes: string[],
  og: { [prop: string]: string }, twitter: { [name: string]: string },
  hreflang: [{ lang: string, href: string }],
  counts: { words: number, linksInternal: number, linksExternal: number, linksNofollow: number,
            imagesNoAlt: number, h1: number }
}
```

`area` у ссылки: ближайший предок `<nav>/<header>/<footer>/<aside>` или ARIA-роль
`navigation/banner/contentinfo/complementary`; `"top"` — ссылка находится до первого блока с
текстом ≥ 150 символов и вне всех перечисленных областей (так выглядит инжект WayForge
«вверху body»); `"content"` — внутри `<main>/<article>` или блока с текстом ≥ 150 символов.

`Vitals`:

```js
{ ttfb: number|null, fcp: number|null, lcp: number|null, cls: number|null, inp: null,
  domNodes: number, transferKb: number|null, source: "buffered" }
```

### 4.4 Реестр вкладок панели (`panel/core.js`, E1)

```js
// Global Panel. Tab modules call Panel.register once at load.
Panel.register({
  id: "page" | "opengsc" | "donor",
  labelKey: string,                   // extension _locales key
  order: number,                      // page 10, opengsc 20, donor 30
  applies: function (ctx) { return boolean },  // opengsc: ctx.summary && ctx.summary.inPortfolio
                                               // donor:   ctx.summary && !ctx.summary.inPortfolio
  render: function (root /*HTMLElement*/, ctx) { /* may return a Promise */ },
  dispose: function () {}             // optional, called before the next render
});

ctx = {
  tabId: number, url: string,
  scan: PageScan | null,              // null while injecting or when injection is not allowed
  scanError: string | null,           // "no_permission" | "restricted_page" | "injection_failed"
  summary: object | null,             // GET /api/ext/page answer (N11 shape), null if not configured
  settings: Settings,
  api: ExtApi,
  msg: function (key, subs) {},       // chrome.i18n.getMessage with fallback to key
  refresh: function () {},            // re-inject + re-fetch
  cache: { get(key), set(key, value, ttlMs) }   // chrome.storage.session wrapper
};
```

Порядок загрузки скриптов в `sidepanel.html` (E0 кладёт, E1 владеет):
`lib/api.js, lib/protocol.js, lib/settings.js, lib/csv.js, lib/export.js, panel/core.js,
panel/tab-page.js, panel/tab-opengsc.js, panel/tab-donor.js`. Последней строкой `core.js`
вызывает `Panel.start()` на `DOMContentLoaded`.

### 4.5 `DonorFacts` (`lib/donor.js`, E3)

```js
ExtDonor.collect(document) → {
  host: string,
  outbound: [{ href, host, text /*≤120*/, rel: string[], area /* как в detail.links */, index }], // только внешние хосты, ≤ 500
  markers: [{ id: string, count: number, sample: string /*≤120*/ }],   // найденные маркеры, §4.6
  archiveRefs: number,          // src/href/srcset/style url(), указывающие на web.archive.org
  generator: string,            // <meta name=generator>
  firstTextBlockIndex: number   // индекс первого блока с текстом ≥ 150 символов среди потомков body; -1 если нет
}
ExtDonor.deriveSignals(donorFacts) → [{ id, severity: "hard" | "soft", evidence: string }]   // ЧИСТАЯ
ExtDonor.verdict(signals) → "restored_drop" | "suspicious" | "clean" | "unknown"            // ЧИСТАЯ
```

### 4.6 Маркеры восстановленных сайтов (E3)

`ExtDonor.MARKERS` — копия списка из `src/lib/pbn/clean.ts` (строка с
`data-wf-reconstructed …`) плюс `wm-ipp`, `__wm`, `wombat`, `archive.org/static/`. Тест
`src/lib/ext/donor.test.ts` сверяет, что все маркеры из `pbn/clean.ts` есть в копии (так же, как
`audit.test.ts` сверяет `META_LIMITS`): поменяли список там — тест упадёт здесь.

---

## 5. Сообщения (`lib/protocol.js`, E0)

```js
var ExtProtocol = {
  MSG_API: "ext:api",               // { type, method: "GET"|"POST", path, body? } → { status, data }
  MSG_OPEN_PANEL: "ext:open-panel", // { type } from popup/overlay → background opens the side panel for sender tab
  MSG_SEND: "opengsc-send",         // N11, unchanged
  MSG_SETTINGS_CHANGED: "ext:settings-changed",  // broadcast after ExtSettings.set
  MSG_SERP_HOSTS: "ext:serp-hosts",           // overlay → bg/serp.js: { type, body: HostsRequest } → { status, data } (cached 10 min)
  MSG_SERP_INVALIDATE: "ext:serp-invalidate", // overlay → bg/serp.js: { type, query } — drop cached answers of this query
  API_WHITELIST: [                  // the only paths ext:api will proxy; anything else → { status: 0, data: { error: "path_not_allowed" } }
    "/api/ext/hosts", "/api/ext/hosts/enrich", "/api/ext/serp/capture", "/api/ext/serp/action",
    "/api/ext/cloak", "/api/ext/outreach", "/api/ext/page", "/api/ext/lists"
  ]
};
```

Прокси `ext:api` реализует E0 в `background.js` (сверка пути с whitelist по префиксу до `?`,
вызов `ExtApi.request`). Отправитель — только content-скрипт нашего же расширения
(`sender.id === chrome.runtime.id`).

Новые методы `lib/api.js` (E0 пишет все восемь):

```js
ExtApi.lists()            // GET  /api/ext/lists
ExtApi.hosts(body)        // POST /api/ext/hosts
ExtApi.enrichHosts(hosts) // POST /api/ext/hosts/enrich { hosts }
ExtApi.capture(body)      // POST /api/ext/serp/capture
ExtApi.serpAction(body)   // POST /api/ext/serp/action
ExtApi.cloak(body)        // POST /api/ext/cloak
ExtApi.insights(body)     // POST /api/ext/insights
ExtApi.metaFit(body)      // POST /api/ext/meta-fit
```

---

## 6. MCP (E5)

`src/lib/mcp/toolsSerpCaptures.ts` экспортирует `SERP_CAPTURE_TOOLS` с одним инструментом:

```ts
{
  name: "serpmon_captures",
  cost: "local",
  idempotent: true,
  description: "List SERP pages saved from the browser extension (personalised, user's own IP — never part of diffs or storms). Filter by projectId or keyword; with captureId returns the rows and, with compare: \"nearest\", the host-level diff against the nearest automated snapshot of the same keyword.",
  inputSchema: { type: "object", properties: {
    projectId: { type: "string" }, keyword: { type: "string" }, captureId: { type: "string" },
    compare: { type: "string", description: "\"nearest\" or a snapshot id" },
    limit: { type: "number", description: "default 20, max 100" },
  } },
}
```

E0 добавляет `import { SERP_CAPTURE_TOOLS } from "./toolsSerpCaptures";` и
`...SERP_CAPTURE_TOOLS` в `MCP_TOOLS` рядом с `SERPMON_TOOLS`.

---

## 7. i18n

Ключи каждой задачи перечислены **в конце её брифа** (для приложения — en и ru, для
расширения — en и ru). E0 собирает их все:

- в 7 локалей приложения (`en ru uk fr es de zh`; uk/fr/es/de/zh — перевод E0);
- в `extension/_locales/{en,ru}/messages.json` в формате `{ "key": { "message": "…" } }`;
  плейсхолдеры — `$1`, `$2` через `substitutions` (как сделано в N11).

Префиксы: приложение — `serpmonCapture*`; расширение — `panel*`, `page*`, `og*` (вкладка
OpenGSC), `donor*`, `serp*`, `opt*`. Существующие 95 ключей расширения не переименовывать.

---

## 8. Заглушки, которые кладёт E0

Каждый роут из §3 — рабочий каркас: `extAuth` + `OPTIONS` + ответ
`501 { error: "not_implemented" }`. `src/lib/ext/{hostIntel,hostIntelPure,serpCapture,snippet,insights}.ts` —
экспорт функций из брифов с `throw new Error("not_implemented")`. JS-модули расширения —
пустые объекты с нужными именами (`var ExtDonor = { collect: function () { return {...пустой DonorFacts} }, … }`),
`Panel.register` вкладок с `render` → «скоро». `CapturesTab.tsx` — компонент «скоро».
Тест-файлы не создаются — их создают владельцы.
