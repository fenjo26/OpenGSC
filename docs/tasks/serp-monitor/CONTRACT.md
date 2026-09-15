# CONTRACT — SERP Monitor, задачи T0…T6

Единственный источник правды по именам моделей, полей, типов, сигнатур, маршрутов и i18n-ключей.
Копировать буквально. Нашёл ошибку — не исправляй молча, напиши в отчёте: остальные задачи
уже пишут код против этих имён.

---

## 0. Смысловое ядро — семь ловушек, ради которых этот контракт написан

1. **Неудачный съём ≠ пустая выдача.** Сгоревший прокси отдаёт `success: 1` и пустой `serp`.
   Если записать это как «результатов нет», на следующем прогоне весь топ-100 «вылетит» по
   каждому запросу, и модуль покажет фальшивый шторм. Поэтому у съёма три статуса:
   `ok | partial | failed`, и **`failed` никогда не участвует в сравнении**. Сравнение всегда
   идёт с последним съёмом этого запроса в статусе `ok` или `partial`.
2. **Изменения считаются по хосту, а не по URL.** На скриншоте из поста `−pba.betsson.bet.ar`
   стоит девять раз в одной строке: сравнивались URL, а показывался домен. Здесь у хоста одна
   «лучшая позиция» и одно изменение; число его URL — справочное поле `urls`.
3. **Сравнение — только в пределах общей глубины.** Прошлый съём 100 строк, нынешний 60
   (`partial`) → сравниваем первые 60. Хост, который был на 80-м месте, **не** «вылетел».
4. **Хвост шумит сам по себе.** Порог движения растёт с позицией (`MOVE_THRESHOLDS`):
   ±3 в топ-10 — это событие, ±3 на 70-м месте — нет.
5. **Шторм — относительно фона самого проекта**, а не абсолютное число. У гемблинга в LatAm
   дневная волатильность выше, чем у «email template builder». Пока прогонов меньше
   `STORM_MIN_BASELINE`, ответ — «калибровка», а не «штормов нет».
6. **Платформы — не конкуренты.** facebook, instagram, apps.apple.com, wikipedia в изменениях
   скрыты по умолчанию (`DEFAULT_PLATFORM_HOSTS` + свой список проекта), но в волатильность
   входят: выдача действительно поменялась.
7. **Сопоставление хоста — по границе точки.** `x.com` — платформа, `netflix.com` — нет.
   Подстрочное `includes("x.com")` (так сделано в `Naz95852/serp-monitor`) запрещено.

---

## 1. Prisma-модели (T0 вставляет в `prisma/schema.prisma` целиком, в конец файла)

У `SerpProject.userId` **нет** relation на `User` — так же, как у `DropRun`. На MySQL любой
`String` — `VARCHAR(191)`; длинные URL там упадут при записи. Это общее ограничение проекта
(у `RankCheck.url` оно такое же), в этой волне **не чинится** — целевая база SQLite.

```prisma
// ─── SERP Monitor (full top-N snapshots per market) ──────────────────────────
// A project is a market (engine · country · language · device) plus a keyword set. Every run
// stores the whole top-N per keyword; diffs are host-level and computed once, at write time.
// See docs/SERP-MONITOR.md.

model SerpProject {
  id            String    @id @default(cuid())
  userId        String                          // workspace owner, from workspaceUserId()
  name          String
  engine        String    @default("google")    // v1: "google" only
  device        String    @default("desktop")   // v1: "desktop" only; "mobile" reserved
  country       String                          // gl, 2 letters, lower-case
  lang          String                          // hl
  provider      String    @default("aparser")   // v1: "aparser" only
  depth         Int       @default(100)         // one of SERPMON_DEPTHS
  intervalHours Int       @default(24)          // one of SERPMON_INTERVALS; 0 = manual only
  ownDomains    String    @default("")          // newline-separated hosts, highlighted in UI
  ignoreHosts   String    @default("")          // newline-separated, added to DEFAULT_PLATFORM_HOSTS
  retentionDays Int       @default(180)         // full snapshots older than this are thinned to one per ISO week
  alertStorm    Boolean   @default(true)
  paused        Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  firstRunAt    DateTime?                       // finishedAt of the first done run — "new domain" starts after it
  lastRunAt     DateTime?
  nextRunAt     DateTime?

  keywords SerpKeyword[]
  runs     SerpRun[]

  @@index([userId])
  @@index([paused, nextRunAt])
}

model SerpKeyword {
  id              String    @id @default(cuid())
  projectId       String
  keyword         String                   // normaliseKeyword(); ≤ 191 chars
  groupName       String    @default("")   // cluster label from the import
  active          Boolean   @default(true)
  createdAt       DateTime  @default(now())
  lastOkAt        DateTime?
  lastSnapshotId  String?                  // last snapshot with status ok|partial
  lastStatus      String    @default("")   // status of the most recent snapshot, any status
  lastProblem     String?
  lastChangeCount Int       @default(0)    // visible host changes in the last comparison
  lastVolatility  Float?

  project   SerpProject    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  snapshots SerpSnapshot[]

  @@unique([projectId, keyword])
  @@index([projectId, active])
}

model SerpRun {
  id         String    @id @default(cuid())
  projectId  String
  trigger    String                        // "schedule" | "manual"
  status     String    @default("running") // running | done | aborted
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  planned    Int       @default(0)
  ok         Int       @default(0)
  partial    Int       @default(0)
  failed     Int       @default(0)
  compared   Int       @default(0)         // keywords that had a comparable previous snapshot
  volatility Float?                        // median keyword volatility over compared keywords
  volTop10   Float?
  shareHigh  Float?                        // share of compared keywords above their own p90
  stormScore Float?                        // robust z vs baseline; null while calibrating
  storm      Boolean   @default(false)
  error      String?

  project   SerpProject    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  snapshots SerpSnapshot[]

  @@index([projectId, startedAt])
  @@index([status])
}

model SerpSnapshot {
  id           String   @id @default(cuid())
  projectId    String
  keywordId    String
  runId        String
  takenAt      DateTime @default(now())
  status       String                    // ok | partial | failed
  problem      String?                   // SnapshotProblem
  depth        Int                       // requested
  got          Int      @default(0)      // organic rows returned (after dedupe)
  totalCount   String   @default("")     // engine-reported count, as text
  // JSON: [position, urlId][] ordered by position. "[]" for failed.
  rows         String   @default("[]")
  // JSON: string[] — SERP features seen (e.g. "paa", "related"), "" when the provider does not say
  features     String   @default("")
  prevId       String?                   // the snapshot this one was compared with
  comparedDepth Int?
  volatility   Float?
  volTop10     Float?
  changeCount  Int      @default(0)      // visible (non-ignored) host changes

  keyword SerpKeyword  @relation(fields: [keywordId], references: [id], onDelete: Cascade)
  run     SerpRun      @relation(fields: [runId], references: [id], onDelete: Cascade)
  changes SerpChange[]

  @@unique([runId, keywordId])
  @@index([keywordId, takenAt])
}

model SerpUrl {
  id          Int      @id @default(autoincrement())
  urlHash     String   @unique            // sha1(url) hex — the dedupe key; url itself can exceed 191
  url         String
  hostId      Int
  title       String   @default("")       // last seen
  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())

  @@index([hostId])
}

model SerpHost {
  id                 Int       @id @default(autoincrement())
  host               String    @unique    // hostOfUrl(): lower-case, no "www.", ≤ 191
  registrable        String    @default("") // apexOf(host) from lib/drops/registries; "" when unknown
  firstSeenAt        DateTime  @default(now())
  registeredAt       DateTime?            // creation date of `registrable` (RDAP/WHOIS)
  ageCheckedAt       DateTime?
  ageError           String?
  dr                 Float?
  drCheckedAt        DateTime?

  @@index([registrable])
  @@index([ageCheckedAt])
  @@index([drCheckedAt])
}

model SerpChange {
  id         String   @id @default(cuid())
  projectId  String
  keywordId  String
  snapshotId String
  hostId     Int
  kind       String                       // enter | exit | up | down
  fromPos    Int?
  toPos      Int?
  urls       Int      @default(1)
  hidden     Boolean  @default(false)     // platform/ignored host — stored, not shown by default
  takenAt    DateTime

  snapshot SerpSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@index([projectId, takenAt])
  @@index([projectId, hostId, takenAt])
  @@index([snapshotId])
}

model SerpProjectHost {
  projectId    String
  hostId       Int
  firstSeenAt  DateTime                   // first snapshot of this project the host appeared in
  lastSeenAt   DateTime
  keywords     Int      @default(0)       // active keywords whose latest ok|partial snapshot contains the host
  prevKeywords Int      @default(0)       // the same number one run earlier — trend arrow
  top10        Int      @default(0)
  top30        Int      @default(0)
  bestPos      Int?
  avgPos       Float?
  bounces      Int      @default(0)       // enter→exit on the same keyword within BOUNCE_RUNS runs

  @@id([projectId, hostId])
  @@index([projectId, keywords])
}
```

Объём на ориентир из поста (944 запроса × 100, раз в сутки): `rows` ≈ 1,3 КБ на съём →
≈ 1,2 МБ в день без индексов, ≈ 450 МБ в год до прореживания.

---

## 2. Общие типы и константы — `src/lib/serpmon/types.ts` (T0)

```ts
export const SERPMON_DEPTHS = [10, 20, 50, 100] as const;
export type SerpmonDepth = typeof SERPMON_DEPTHS[number];

/** 0 = manual only. */
export const SERPMON_INTERVALS = [0, 6, 12, 24, 72, 168] as const;

export const SERPMON_MAX_KEYWORDS = 5000;          // per project
export const SERPMON_MANUAL_COOLDOWN_MS = 10 * 60_000;

export type SnapshotStatus = "ok" | "partial" | "failed";

export type SnapshotProblem =
  | "aparser_no_result"          // from parserResultProblem
  | "aparser_parser_failed"      // from parserResultProblem
  | "aparser_blocked_or_empty"   // from parserResultProblem
  | "short_result"               // fewer rows than SHORT_RESULT_RATIO × expected, engine did not say why
  | "provider_error"             // runSerp returned `error`
  | "no_creds"
  | "timeout";

export interface SerpRow {
  position: number;   // 1-based, organic only, as mapped by the provider
  url: string;
  host: string;       // hostOfUrl(url)
  title: string;
}

export interface HostPos {
  host: string;
  best: number;       // best (lowest) position of any URL of this host
  urls: number;       // how many URLs of this host are in the list
}

export type ChangeKind = "enter" | "exit" | "up" | "down";

export interface HostChange {
  host: string;
  kind: ChangeKind;
  from: number | null;   // null for enter
  to: number | null;     // null for exit
  urls: number;
  hidden: boolean;       // platform or project-ignored
}

export interface KeywordDiff {
  comparedDepth: number;
  changes: HostChange[];   // sorted: enter (by `to`), then up/down (by |delta| desc), then exit (by `from`)
  volatility: number;      // 0..1, 1 − RBO_ext over host lists, p = RBO_P_FULL
  volTop10: number;        // 0..1, 1 − RBO_ext over the first 10 hosts, p = RBO_P_TOP10
  visibleCount: number;    // changes.filter(c => !c.hidden).length
}

export interface StormVerdict {
  calibrating: boolean;    // baseline shorter than STORM_MIN_BASELINE
  score: number | null;    // robust z; null when calibrating or not enough compared keywords
  storm: boolean;
  baselineRuns: number;
}

/** Position bands and the |delta| that counts as a move inside each. Last band must reach 100. */
export const MOVE_THRESHOLDS: readonly { upTo: number; delta: number }[] = [
  { upTo: 10, delta: 3 },
  { upTo: 30, delta: 7 },
  { upTo: 100, delta: 15 },
];

export const SHORT_RESULT_RATIO = 0.8;
export const RBO_P_FULL = 0.95;
export const RBO_P_TOP10 = 0.8;

export const STORM_MIN_BASELINE = 7;       // done runs with a volatility before a verdict is given
export const STORM_BASELINE_RUNS = 20;     // how many previous runs form the baseline
export const STORM_Z = 3;
export const STORM_SHARE_HIGH = 0.3;
export const STORM_MIN_COMPARED_ABS = 10;  // and at least 30% of planned
export const STORM_MIN_COMPARED_SHARE = 0.3;
export const KEYWORD_P90_WINDOW = 20;      // snapshots per keyword for its own p90
export const BOUNCE_RUNS = 7;

export const NEW_HOST_DAYS = 7;
export const YOUNG_HOST_MONTHS = 6;

/** Matched by host or dot-bounded suffix: "m.facebook.com" is facebook.com, "netflix.com" is not x.com. */
export const DEFAULT_PLATFORM_HOSTS: readonly string[] = [
  "facebook.com", "instagram.com", "youtube.com", "twitter.com", "x.com", "tiktok.com",
  "linkedin.com", "reddit.com", "quora.com", "pinterest.com", "threads.net", "t.me",
  "wikipedia.org", "apps.apple.com", "play.google.com", "google.com", "medium.com",
  "trustpilot.com", "vk.com", "amazon.com",
];

// ─── API shapes (T3/T4 return them, T5/T6 consume them) ───

export interface ProjectSummary {
  id: string; name: string; engine: string; device: string; country: string; lang: string;
  depth: number; intervalHours: number; paused: boolean;
  keywords: number; lastRunAt: string | null; nextRunAt: string | null;
  lastRun: RunSummary | null;
  volatilitySeries: (number | null)[];   // last 30 done runs, oldest first
}

export interface ProjectDetail extends ProjectSummary {
  ownDomains: string[]; ignoreHosts: string[]; retentionDays: number; alertStorm: boolean;
  groups: { name: string; count: number }[];
  firstRunAt: string | null;
}

export interface RunSummary {
  id: string; trigger: "schedule" | "manual"; status: "running" | "done" | "aborted";
  startedAt: string; finishedAt: string | null;
  planned: number; ok: number; partial: number; failed: number; compared: number;
  volatility: number | null; volTop10: number | null; shareHigh: number | null;
  stormScore: number | null; storm: boolean; calibrating: boolean; error: string | null;
}

export interface MarketRow {
  keywordId: string; keyword: string; group: string;
  status: SnapshotStatus | ""; problem: string | null;
  lastOkAt: string | null;
  leaders: string[];                     // first 3 hosts of the latest ok|partial snapshot, platforms included
  changes: HostChange[];                 // from the latest comparison; hidden ones included, UI filters
  volatility: number | null;
  own: { host: string; position: number } | null;
}

export interface MarketQuery {
  q?: string; host?: string; group?: string; changedOnly?: boolean;
  sort?: "keyword" | "volatility" | "changes"; page?: number; pageSize?: number;   // pageSize ≤ 200
}

export type DomainTag = "new" | "young" | "rising" | "falling" | "bounced" | "platform" | "own";

export interface DomainRow {
  hostId: number; host: string; registrable: string;
  firstSeenAt: string; lastSeenAt: string;
  registeredAt: string | null; ageMonths: number | null; ageError: string | null;
  dr: number | null;
  keywords: number; prevKeywords: number; top10: number; top30: number;
  bestPos: number | null; avgPos: number | null; bounces: number;
  tags: DomainTag[];
}

export interface DomainQuery {
  preset?: "all" | "new" | "young" | "rising" | "falling" | "bounced";
  q?: string; maxAgeMonths?: number; includePlatforms?: boolean;
  sort?: "keywords" | "top10" | "bestPos" | "firstSeen" | "age" | "dr";
  page?: number; pageSize?: number;
}

export interface KeywordHistory {
  snapshots: { id: string; takenAt: string; status: SnapshotStatus; problem: string | null;
               depth: number; got: number; volatility: number | null; changeCount: number }[];
  hosts: { host: string; series: (number | null)[] }[];   // ≤ 10 hosts with most presence; series aligned to snapshots
}

export interface SnapshotView {
  id: string; takenAt: string; status: SnapshotStatus; problem: string | null; depth: number; got: number;
  rows: SerpRow[];
  compare: { id: string; takenAt: string; rows: SerpRow[]; diff: KeywordDiff } | null;
}
```

---

## 3. Сигнатуры модулей

T0 создаёт **каждый** из этих файлов заглушкой: те же экспорты, тела —
`throw new Error("serpmon: <имя> not implemented (Tn)")`, у асинхронных — `Promise.reject(...)`
не нужен, достаточно `throw` внутри `async`. Задача-владелец переписывает файл целиком.

### 3.1 `src/lib/serpmon/hosts.ts` — T2 (чистый, без импортов сервера)

```ts
/** Lower-case host without "www." and trailing dot; null for non-http(s) or unparsable. ≤ 191 chars else null. */
export function hostOfUrl(url: string): string | null;
/** true when host equals an entry or ends with "." + entry. */
export function hostMatches(host: string, entries: readonly string[]): boolean;
/** DEFAULT_PLATFORM_HOSTS ∪ project list, as one predicate. */
export function ignorePredicate(projectIgnore: readonly string[]): (host: string) => boolean;
/** Split the textarea value: newline/comma separated, trimmed, lower-cased, www. stripped, deduped. */
export function parseHostList(raw: string): string[];
```

### 3.2 `src/lib/serpmon/noise.ts` — T2

```ts
export function classifySnapshot(input: {
  rows: SerpRow[];
  depth: number;
  totalCount: string | null;            // engine-reported; "" / null = unknown
  providerError: string | null;         // SerpResponse.error
}): { status: SnapshotStatus; problem: SnapshotProblem | null };
// Rules, in order:
//  providerError                               → failed, problem = known code if the error IS one, else "provider_error"
//  rows.length === 0 && totalCount === "0"     → ok (a real empty SERP)
//  rows.length === 0                           → failed, "aparser_blocked_or_empty"
//  expected = min(depth, totalCount if numeric) ; rows.length ≥ SHORT_RESULT_RATIO × expected → ok
//  otherwise                                   → partial, "short_result"

/** The depth two snapshots can be compared at. 0 = not comparable. */
export function comparableDepth(
  prev: { status: SnapshotStatus; got: number } | null,
  cur: { status: SnapshotStatus; got: number },
): number;
// failed on either side → 0; otherwise min(prev.got, cur.got).
```

### 3.3 `src/lib/serpmon/diff.ts` — T2

```ts
/** Host list in order of best position, rows beyond `depth` ignored. */
export function hostPositions(rows: SerpRow[], depth: number): HostPos[];

export function diffKeyword(
  prev: SerpRow[], cur: SerpRow[],
  opts: { depth: number; ignore: (host: string) => boolean },
): KeywordDiff;
// enter : host in cur(depth), not in prev(depth)
// exit  : host in prev(depth), not in cur(depth)
// up/down: in both, |from − to| ≥ threshold for the band of min(from, to)
// hidden = ignore(host); hidden changes are returned, never dropped
// volatility/volTop10 computed over ALL hosts (hidden included)
```

### 3.4 `src/lib/serpmon/volatility.ts` — T2

```ts
/**
 * Extrapolated rank-biased overlap (Webber, Moffat, Zobel 2010, eq. 32) for two lists cut to the
 * same length k:
 *   RBO_ext = (X_k / k)·p^k + ((1 − p) / p) · Σ_{d=1..k} (X_d / d)·p^d
 * where X_d = |A[0..d) ∩ B[0..d)|. Identical lists → 1, disjoint → 0. k = 0 → 1.
 */
export function rboExt(a: readonly string[], b: readonly string[], p: number): number;
export function median(xs: readonly number[]): number;          // NaN for []
export function mad(xs: readonly number[]): number;             // median absolute deviation, unscaled
export function quantile(xs: readonly number[], q: number): number;

export function stormVerdict(input: {
  current: number | null;               // this run's median volatility
  baseline: readonly number[];          // previous done runs' volatility, newest first, ≤ STORM_BASELINE_RUNS
  compared: number; planned: number;
  shareHigh: number | null;
}): StormVerdict;
// calibrating = baseline.length < STORM_MIN_BASELINE
// not enough compared (compared < max(STORM_MIN_COMPARED_ABS, STORM_MIN_COMPARED_SHARE × planned)) → score null, storm false
// score = (current − median(B)) / (1.4826 · mad(B) + 0.005)
// storm = score ≥ STORM_Z && (shareHigh ?? 0) ≥ STORM_SHARE_HIGH

/** Share of keywords whose current volatility is above their own KEYWORD_P90_WINDOW-snapshot p90 (needs ≥ 5 points each). */
export function shareAboveOwnP90(items: readonly { current: number; history: readonly number[] }[]): number | null;
```

### 3.5 `src/lib/seo/serp.ts` и `aparserSerp.ts` — T1

Расширения существующих типов в `serp.ts` (добавляются, ничего не ломают):

```ts
export interface SerpOptions {
  // …существующие поля…
  /** A-Parser thread config ("default" when absent). Ignored by metered providers. */
  configPreset?: string;
}
export interface SerpResponse {
  // …существующие поля…
  /** Engine-reported total, as text. Present only when the provider says it. */
  totalCount?: string;
  /** SERP features the provider reported, normalised ids: "paa" | "related" | "ads" | "video" | "local" | "images" | "news". */
  features?: string[];
}
```

`PROVIDER_ENGINES.aparser = ["google"]`. `runSerp("aparser", password, keyword, { gl, hl, num, baseUrl, configPreset })`
→ `aparserSearch()`. Ошибка `parserResultProblem` уходит в `SerpResponse.error` **ровно кодом**
(`"aparser_blocked_or_empty"` и т.д.), без префиксов — `classifySnapshot` сверяет строку.

```ts
// src/lib/seo/aparserSerp.ts — pure mapping, no transport
export const APARSER_SERP_PARSERS: Record<"google", string> = { google: "SE::Google" };
export interface AparserSerpOptionIds {
  pagecount: string;      // pages to fetch
  country?: string;       // search country (gl)
  language?: string;      // results / interface language (hl)
}
/** Verified against a live SE::Google preset by scripts/aparser-serp-probe.ts — see T1. */
export const APARSER_SERP_OPTION_IDS: AparserSerpOptionIds;
export function aparserSerpOptions(o: { depth: number; gl: string; hl: string }, ids?: AparserSerpOptionIds): AparserOption[];
export function mapAparserSerp(row: unknown, want: number): {
  results: SerpResultItem[];   // position = 1-based order after dedupe by exact url, cut to `want`
  totalCount: string;          // "" when absent
  features: string[];
  problem: string | null;      // parserResultProblem(row, ["serp"])
};
```

```ts
// src/lib/seo/aparserServerCreds.ts — T1
/** Owner's A-Parser connection for server-side use: env wins over settings, like /api/aparser. Applies seoAparserConcurrency. null = not configured. */
export async function getAparserServerCreds(userId: string): Promise<AparserCreds | null>;
```

### 3.6 `src/lib/serpmon/keywords.ts` — T3 (чистый)

```ts
export function normaliseKeyword(raw: string): string | null;   // trim, collapse spaces, lower-case (locale-free), 1..191 chars else null
export interface KeywordImport { rows: { keyword: string; group: string }[]; skipped: number; duplicates: number }
/** One keyword per line; optional group after TAB, ";" or "," (first separator found). Header line "keyword" is skipped. */
export function parseKeywordImport(raw: string): KeywordImport;
```

### 3.7 `src/lib/serpmon/store.ts` — T3

```ts
export function schemaMissing(e: unknown): boolean;
export async function listProjects(userId: string): Promise<ProjectSummary[]>;
export async function getProject(userId: string, id: string): Promise<ProjectDetail | null>;
export async function createProject(userId: string, input: ProjectInput): Promise<{ project: ProjectDetail; import: KeywordImport & { added: number } }>;
export async function updateProject(userId: string, id: string, patch: Partial<ProjectInput>): Promise<ProjectDetail | null>;
export async function deleteProject(userId: string, id: string): Promise<boolean>;
export async function addKeywords(userId: string, projectId: string, raw: string, mode: "add" | "replace"): Promise<KeywordImport & { added: number; deactivated: number } | null>;
export async function removeKeywords(userId: string, projectId: string, ids: string[]): Promise<number>;
export async function listRuns(userId: string, projectId: string, limit: number): Promise<RunSummary[]>;
export async function marketRows(userId: string, projectId: string, q: MarketQuery): Promise<{ rows: MarketRow[]; total: number; all: number } | null>;
export async function keywordHistory(userId: string, keywordId: string, limit: number): Promise<KeywordHistory | null>;
export async function snapshotView(userId: string, snapshotId: string, compareId?: string): Promise<SnapshotView | null>;

export interface ProjectInput {
  name: string; country: string; lang: string; depth: number; intervalHours: number;
  keywords?: string;          // raw import text
  ownDomains?: string; ignoreHosts?: string; retentionDays?: number; alertStorm?: boolean; paused?: boolean;
}
```

Каждая функция с `userId` проверяет, что проект принадлежит этому `userId`; чужой → `null`/`false`.

### 3.8 `src/lib/serpmon/collector.ts` и `scheduler.ts` — T3

```ts
// collector.ts
export async function startRun(userId: string, projectId: string, trigger: "schedule" | "manual", opts?: { force?: boolean }):
  Promise<{ runId: string } | { error: "not_found" | "already_running" | "cooldown" | "no_creds" | "no_keywords" }>;
/** Advance one running run until `deadline` (epoch ms). Resumable: keywords that already have a snapshot for this run are skipped. */
export async function advanceRun(runId: string, deadline: number): Promise<{ done: boolean; processed: number }>;
export async function finalizeRun(runId: string): Promise<RunSummary>;

// scheduler.ts
export function startSerpmonScheduler(): void;
/** Wake the loop now (after a manual start) instead of waiting for the next tick. */
export function kickSerpmonScheduler(): void;
```

### 3.9 `src/lib/serpmon/enrich.ts` и `domains.ts` — T4

```ts
// enrich.ts
/** Age (RDAP/WHOIS) for hosts never checked or failed > 7 days ago, then DR (free endpoint) older than 30 days. Bounded by `limit` and `deadline`. */
export async function enrichPendingHosts(opts: { limit: number; deadline: number; userId?: string; hostIds?: number[]; what?: "age" | "dr" | "both" }):
  Promise<{ age: number; dr: number; errors: number }>;

// domains.ts
export function domainTags(row: Omit<DomainRow, "tags">, ctx: {
  now: Date; firstRunAt: Date | null; ownDomains: readonly string[]; isPlatform: (h: string) => boolean; maxAgeMonths: number;
}): DomainTag[];   // pure
export async function domainRows(userId: string, projectId: string, q: DomainQuery): Promise<{ rows: DomainRow[]; total: number } | null>;
export async function rebuildProjectHosts(projectId: string, runId: string): Promise<void>;
```

`rebuildProjectHosts` пишет `SerpProjectHost` и вызывается из `finalizeRun` (T3). Живёт у T4,
потому что это его таблица и его смысл «растёт/падает/отскочил».

Правила тегов (`domainTags`):
- `new` — `firstRunAt` есть, `firstSeenAt > firstRunAt` и `firstSeenAt` не старше `NEW_HOST_DAYS`.
  На первом прогоне новых нет — там все «впервые».
- `young` — `ageMonths !== null && ageMonths < maxAgeMonths` (по умолчанию `YOUNG_HOST_MONTHS`).
- `rising` — `keywords − prevKeywords ≥ 2`; `falling` — `≤ −2`.
- `bounced` — `bounces > 0`.
- `platform` — `isPlatform(host)`; `own` — хост совпадает с `ownDomains` (по границе точки).

### 3.10 `src/lib/serpmon/alerts.ts` — T6

```ts
/** Called by finalizeRun once per done run. Never throws: logs and returns. */
export async function serpmonRunAlerts(userId: string, project: { id: string; name: string; alertStorm: boolean }, run: RunSummary): Promise<void>;
export async function sendSerpmonTestAlert(userId: string, projectId: string): Promise<{ ok: boolean; error?: string }>;
/** Pure: the message text. */
export function stormAlertText(lang: string, input: { project: string; run: RunSummary; topKeywords: string[]; topHosts: { host: string; enters: number; exits: number }[] }): string;
```

---

## 4. API (Next route handlers)

Все под `/api/serp-monitor`. Ошибки — `{ error: string }` со статусом 400/401/404/409/500.
Не мигрированная база → `200 { notMigrated: true, … пустые данные }`.

| Метод и путь | Право | Тело / query | Ответ | Владелец |
|---|---|---|---|---|
| `GET /projects` | read | — | `{ projects: ProjectSummary[] }` | T3 |
| `POST /projects` | act | `ProjectInput` | `{ project: ProjectDetail, import: {...} }` | T3 |
| `GET /projects/[id]` | read | — | `{ project: ProjectDetail }` | T3 |
| `PATCH /projects/[id]` | act | `Partial<ProjectInput>` (без `keywords`) | `{ project }` | T3 |
| `DELETE /projects/[id]` | act | — | `{ ok: true }` | T3 |
| `POST /projects/[id]/keywords` | act | `{ raw: string, mode: "add" \| "replace" }` | `{ import }` | T3 |
| `DELETE /projects/[id]/keywords` | act | `{ ids: string[] }` | `{ removed }` | T3 |
| `POST /projects/[id]/run` | act | `{ force?: boolean }` | `{ runId }` или 409 `{ error: "already_running" \| "cooldown" }`, 400 `{ error: "no_creds" \| "no_keywords" }` | T3 |
| `GET /projects/[id]/runs?limit=60` | read | — | `{ runs: RunSummary[] }` (новые первыми) | T3 |
| `GET /projects/[id]/market?…` | read | `MarketQuery` в query (`changed=1`) | `{ rows, total, all }` | T3 |
| `GET /keywords/[id]/history?limit=30` | read | — | `KeywordHistory` | T3 |
| `GET /snapshots/[id]?compare=<id>` | read | — | `SnapshotView` (без `compare` — с предыдущим сравнённым `prevId`) | T3 |
| `GET /projects/[id]/domains?…` | read | `DomainQuery` в query | `{ rows, total }` | T4 |
| `POST /projects/[id]/domains/enrich` | act | `{ what: "age" \| "dr", hostIds?: number[] }` | `{ age, dr, errors, remaining }` — один ограниченный шаг (≤ 45 с), клиент зовёт повторно, пока `remaining > 0` | T4 |
| `GET /projects/[id]/export?kind=keywords\|domains` | read | для `domains` — `DomainQuery` | `text/csv; charset=utf-8`, UTF-8 BOM, `Content-Disposition: attachment` | T4 |
| `POST /projects/[id]/test-alert` | act | — | `{ ok, error? }` | T6 |

`kind=keywords` — одна колонка без заголовка: это кнопка «Фразы для Ahrefs» (вставляется в
Keywords Explorer как есть).

---

## 5. Алгоритм прогона (T3 реализует, остальные должны понимать)

1. `startRun`: проект свой, не на паузе (ручной запуск на паузе разрешён), нет `running`-прогона,
   ручной — не чаще `SERPMON_MANUAL_COOLDOWN_MS` без `force`, есть креды (`getAparserServerCreds`),
   есть активные запросы. Создаёт `SerpRun{planned}`, `kickSerpmonScheduler()`.
2. Планировщик: тик каждые **60 с**, флаг `running` против наложения. В тике:
   - прогоны `running`, у которых `startedAt` старше 12 ч → `aborted` с `error: "stale"`;
   - `advanceRun` для каждого `running`-прогона, общий бюджет тика **50 с**;
   - проекты, у которых `!paused && intervalHours > 0 && (nextRunAt ≤ now || nextRunAt == null)` и
     нет `running`-прогона → `startRun(..., "schedule")`;
   - остаток бюджета → `enrichPendingHosts({ limit: 40, deadline })`.
   Всё внутри `withCallContext({ userId, feature: "serpmon-cron" })`. Таблиц нет
   (`schemaMissing`) → планировщик выключается до перезапуска, как `drops/scheduler.ts`.
3. `advanceRun`: берёт ещё не снятые запросы этого прогона, параллельно не больше лимита
   A-Parser (лимитер уже в транспорте — отдельный пул не нужен, но запускать больше 16 промисов
   сразу не надо). Для каждого:
   `runSerp` → `rows` (host через `hostOfUrl`, строки без хоста отбрасываются) →
   `classifySnapshot` → предыдущий съём = `SerpKeyword.lastSnapshotId` →
   `comparableDepth` → если > 0: `diffKeyword(prev, cur, { depth, ignore })` →
   upsert `SerpHost` / `SerpUrl` (словарь, пачки ≤ 400 параметров) →
   `SerpSnapshot` (+`rows` как `[pos, urlId][]`) → `SerpChange[]` → обновить `SerpKeyword`.
   **`failed` не трогает `lastSnapshotId`.** Один запрос — одна транзакция.
4. `finalizeRun`: счётчики; `volatility` = медиана `SerpSnapshot.volatility` этого прогона;
   `shareHigh` через `shareAboveOwnP90` (история — прошлые `volatility` каждого запроса);
   `stormVerdict` по `volatility` прошлых `done`-прогонов проекта; `status = done`;
   `firstRunAt` если пусто; `lastRunAt`, `nextRunAt = finishedAt + intervalHours` (или `null`);
   `rebuildProjectHosts` (T4); `serpmonRunAlerts` (T6); прореживание старых съёмов (§6).
   Если **все** запросы `failed` — прогон `done`, `volatility = null`, `error = "all_failed"`,
   шторма нет, алерта о шторме нет.

## 6. Хранение и прореживание

После `finalizeRun`: съёмы проекта старше `retentionDays`, кроме первого в каждой ISO-неделе на
запрос, удаляются вместе с их `SerpChange` (каскад). Не больше 2000 удалений за один вызов.
`lastSnapshotId` никогда не удаляется. Сборка мусора `SerpUrl`/`SerpHost` — фаза 2.

---

## 7. i18n-ключи — T0 создаёт все, в семи файлах

Префикс `serpmon`. Плейсхолдеры в фигурных скобках — как принято в проекте (T0 проверяет
формат по существующим ключам и приводит к нему). Переводы на uk/fr/es/de/zh делает T0.

| Ключ | en | ru |
|---|---|---|
| serpmonNavTitle | SERP Monitor | SERP-монитор |
| serpmonTitle | SERP Monitor | SERP-монитор |
| serpmonSubtitle | Full top-100 snapshots per market: who enters, who drops, when the SERP shakes | Полная выдача топ-100 по рынку: кто вошёл, кто выпал, когда трясёт |
| serpmonNewProject | New project | Новый проект |
| serpmonEmpty | No projects yet. Create one to start collecting SERP snapshots. | Проектов пока нет. Создайте проект, чтобы начать собирать выдачу. |
| serpmonNotMigrated | Database tables are missing. Run `npx prisma db push` and restart. | В базе нет таблиц. Выполните `npx prisma db push` и перезапустите. |
| serpmonNoAparser | SERP Monitor needs A-Parser. Configure it in Settings → API keys. | Для SERP-монитора нужен A-Parser. Настройте его в Настройках → API-ключи. |
| serpmonOpenSettings | Open settings | Открыть настройки |
| serpmonCostNote | self-hosted · no per-request cost | свой сервер · без оплаты за запрос |
| serpmonFieldName | Name | Название |
| serpmonFieldCountry | Country | Страна |
| serpmonFieldLang | Language | Язык |
| serpmonFieldDepth | Depth | Глубина |
| serpmonFieldInterval | Check every | Проверять каждые |
| serpmonIntervalManual | Manual only | Только вручную |
| serpmonIntervalHours | {n} h | {n} ч |
| serpmonIntervalDays | {n} d | {n} дн |
| serpmonFieldKeywords | Keywords | Запросы |
| serpmonKeywordsHint | One per line. Optional group after a tab, ";" or ",". | По одному на строку. Группа — через табуляцию, «;» или «,». |
| serpmonFieldOwnDomains | Your domains | Свои домены |
| serpmonFieldIgnore | Hide these hosts from changes | Скрыть эти хосты из изменений |
| serpmonIgnoreDefaultsHint | Social networks, app stores and Wikipedia are hidden by default. | Соцсети, магазины приложений и Википедия скрыты по умолчанию. |
| serpmonFieldRetention | Keep full snapshots, days | Хранить полные съёмы, дней |
| serpmonFieldAlertStorm | Notify about storms | Уведомлять о штормах |
| serpmonPaused | Paused | На паузе |
| serpmonPause | Pause | Пауза |
| serpmonResume | Resume | Возобновить |
| serpmonSave | Save | Сохранить |
| serpmonCancel | Cancel | Отмена |
| serpmonEdit | Edit | Изменить |
| serpmonDelete | Delete project | Удалить проект |
| serpmonDeleteConfirm | Delete "{name}" and all its snapshots? | Удалить «{name}» и все его съёмы? |
| serpmonAddKeywords | Add keywords | Добавить запросы |
| serpmonReplaceKeywords | Replace keyword list | Заменить список запросов |
| serpmonImportResult | Added {added}, duplicates {duplicates}, skipped {skipped} | Добавлено {added}, дублей {duplicates}, пропущено {skipped} |
| serpmonExportKeywords | Keywords for Ahrefs | Фразы для Ahrefs |
| serpmonExportDomains | Export domains | Выгрузить домены |
| serpmonRunNow | Check now | Проверить сейчас |
| serpmonRunning | Checking {done} of {planned} | Проверено {done} из {planned} |
| serpmonAlreadyRunning | A check is already running | Проверка уже идёт |
| serpmonCooldown | Checked a few minutes ago. Run anyway? | Проверяли несколько минут назад. Запустить всё равно? |
| serpmonNoKeywords | Add keywords first | Сначала добавьте запросы |
| serpmonLastRun | Last check | Последняя проверка |
| serpmonNextRun | Next check | Следующая проверка |
| serpmonNever | never | никогда |
| serpmonTabMarket | Market | Рынок |
| serpmonTabStorms | Storms | Штормы |
| serpmonTabDomains | Domains | Домены |
| serpmonFilterQuery | Filter by keyword… | Фильтр по запросу… |
| serpmonFilterDomain | Filter by domain… | Фильтр по домену… |
| serpmonFilterGroup | All groups | Все группы |
| serpmonChangedOnly | With changes | С изменениями |
| serpmonShowPlatforms | Show platforms | Показать платформы |
| serpmonCountOf | {shown} of {total} | {shown} из {total} |
| serpmonColKeyword | Keyword | Запрос |
| serpmonColGroup | Group | Группа |
| serpmonColLeaders | Leaders | Лидеры |
| serpmonColChanges | Changes | Изменения |
| serpmonColVolatility | Volatility | Волатильность |
| serpmonColOwn | Your position | Ваша позиция |
| serpmonNoChanges | no changes | без изменений |
| serpmonNoComparison | first snapshot — nothing to compare yet | первый съём — сравнивать пока не с чем |
| serpmonChangeEnter | entered at #{to} | вошёл на #{to} |
| serpmonChangeExit | dropped out, was #{from} | выпал, был #{from} |
| serpmonChangeMove | #{from} → #{to} | #{from} → #{to} |
| serpmonUrlsCount | {n} URLs | URL: {n} |
| serpmonStatusOk | OK | ОК |
| serpmonStatusPartial | Partial | Неполный |
| serpmonStatusFailed | Failed | Ошибка |
| serpmonProblem_aparser_blocked_or_empty | Empty answer — proxies blocked or captcha | Пустой ответ — прокси заблокированы или капча |
| serpmonProblem_aparser_parser_failed | A-Parser reported a failed request | A-Parser сообщил об ошибке запроса |
| serpmonProblem_aparser_no_result | A-Parser returned no result object | A-Parser не вернул результат |
| serpmonProblem_short_result | Fewer results than requested | Результатов меньше, чем запрошено |
| serpmonProblem_provider_error | Provider error | Ошибка провайдера |
| serpmonProblem_no_creds | A-Parser is not configured | A-Parser не настроен |
| serpmonProblem_timeout | Timed out | Превышено время ожидания |
| serpmonHistoryTitle | SERP history | История выдачи |
| serpmonSnapshots | Snapshots | Съёмы |
| serpmonCompare | Compare | Сравнить |
| serpmonCompareWith | Compare with… | Сравнить с… |
| serpmonPosition | Position | Позиция |
| serpmonStormsCalibrating | Calibrating: {n} of {min} checks collected. Storms are measured against this project's own baseline. | Калибровка: собрано {n} из {min} проверок. Шторм считается относительно фона самого проекта. |
| serpmonStormBadge | Storm | Шторм |
| serpmonStormScore | Storm score | Сила шторма |
| serpmonBaseline | Baseline | Фон |
| serpmonShareHigh | Keywords above their usual churn | Запросов выше обычной тряски |
| serpmonGoogleUpdates | Google updates | Апдейты Google |
| serpmonTopShaken | Most shaken keywords | Сильнее всего трясло |
| serpmonTopMovers | Most entries and exits | Больше всего входов и выходов |
| serpmonRunsTable | Checks | Проверки |
| serpmonRunAllFailed | Every request failed — check proxies | Все запросы с ошибкой — проверьте прокси |
| serpmonPresetAll | All | Все |
| serpmonPresetNew | New | Новые |
| serpmonPresetYoung | Young | Молодые |
| serpmonPresetRising | Rising | Растут |
| serpmonPresetFalling | Falling | Падают |
| serpmonPresetBounced | Bounced | Отскочили |
| serpmonMaxAge | Registered within, months | Зарегистрирован не раньше, мес. |
| serpmonColHost | Domain | Домен |
| serpmonColAge | Age | Возраст |
| serpmonColDr | DR | DR |
| serpmonColKeywords | Keywords | Запросов |
| serpmonColTop10 | Top 10 | Топ-10 |
| serpmonColBest | Best | Лучшая |
| serpmonColAvg | Average | Средняя |
| serpmonColFirstSeen | First seen | Впервые |
| serpmonAgeMonths | {n} mo | {n} мес. |
| serpmonAgeYears | {n} y | {n} г. |
| serpmonLoadAge | Load registration dates | Загрузить возраст |
| serpmonLoadDr | Load DR | Загрузить DR |
| serpmonLoadFreeNote | Free: public RDAP/WHOIS and the free Ahrefs DR endpoint | Бесплатно: открытые RDAP/WHOIS и бесплатный DR от Ahrefs |
| serpmonAgeUnknown | no public registration date for this zone | у этой зоны нет открытой даты регистрации |
| serpmonTagNew | new | новый |
| serpmonTagYoung | young | молодой |
| serpmonTagRising | rising | растёт |
| serpmonTagFalling | falling | падает |
| serpmonTagBounced | bounced | отскочил |
| serpmonTagPlatform | platform | платформа |
| serpmonTagOwn | yours | ваш |
| serpmonTestAlert | Send a test storm alert | Тестовое уведомление о шторме |
| serpmonTestAlertSent | Sent | Отправлено |
| serpmonAlertNoChannel | No Telegram or Slack configured | Не настроен Telegram или Slack |
| serpmonPrev | Previous | Назад |
| serpmonNext | Next | Далее |

Строки уведомлений (`stormAlertText`) в локали **не** идут — они в `src/lib/notifyI18n.ts` (T6).

---

## 8. Фаза 2 — не делать сейчас, но не закрывать дорогу

- **Сетки:** `SerpHost.ns`, `SerpHost.ip24` через `lib/drops/dns.ts`; похожие title/сниппеты
  через `lib/seo/textSimilarity.ts`; кластер = ≥ 3 хоста с общим NS или /24 в одном проекте.
- **Мобильная выдача, Bing, Yandex** — `device`/`engine` уже в схеме; нужны id опций и
  `PROVIDER_ENGINES.aparser`.
- **Пакетный режим** `aparserAddTask` для проектов > 2000 запросов.
- **Платные провайдеры по расписанию** (DataForSEO) — только с месячным бюджетом, по образцу
  `warmupScheduler`, право `spend`.
- **«Материал для генерации»:** кнопка на запросе — отдать топ-N URL в существующий SERP-анализ.
- **Сборка мусора** `SerpUrl` / `SerpHost`.
