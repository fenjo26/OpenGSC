# CONTRACT — волна «Октябрь», задачи T0…T7

Единственный источник правды по именам моделей, полей, типов, сигнатур, маршрутов, ключей i18n
и шаблонов уведомлений. Копируй буквально. Нашёл ошибку — не исправляй молча, а напиши в отчёте:
остальные задачи уже пишут код против этих имён.

---

## 0. Смысловое ядро: восемь ловушек, ради которых написан контракт

1. **LLM не умеет считать символы (T1).** Правило «Title 50–60 символов» написано в промпте
   трижды (`prompts.ts` 224, 407, 733), и всё равно на проде title 66–80 символов. Длину
   проверяет только код, а судья её не проверяет. Выбор варианта тоже делает код: сейчас
   `pick()` берёт **первый** непустой `title_options`, даже когда второй вариант влезает.
2. **Одни границы на всё (T1, T5).** Генератор целится в 50–60 и ~155, аудит ругается на >65 и
   <150. Цель генератора должна лежать **внутри** зелёной зоны аудита, и числа должны браться
   из одного файла (`metaLimits.ts`), а не жить в двух местах.
3. **Упал монитор ≠ упал сайт (T2).** Если за один тик разом упали все сайты, скорее всего,
   отвалилась сеть самого VPS. Тогда алерта нет, статус «проверка недоступна». Иначе один
   сетевой сбой разошлёт 50 ложных тревог.
4. **Только переход — событие (T2).** Сайт, который уже лежал в момент включения монитора,
   не шлёт «упал». Алерт — только на переход `up → down` после `failThreshold` подряд неудачных
   проверок, и только один раз на инцидент (`AlertEvent.dedupeKey`).
5. **Квота Google считается по Тихоокеанскому времени (T4).** Дневные квоты Search Console API
   сбрасываются в полночь по `America/Los_Angeles`, а не по UTC. Лимит URL Inspection —
   2000 в день и 600 в минуту **на ресурс** (property). Ручная проверка, MCP `inspect_url` и
   автопроверка тратят одну и ту же квоту, поэтому учитываются в одной таблице.
6. **Эвристика не снижает оценку (T5, T7).** `title_query_mismatch`, `cwv_poor` по выборке,
   hreflang-подсказки уровня info — `affectsScore: false`. Health score не должен падать от
   догадки (`PRODUCT-ROADMAP.md` §3.3).
7. **Share of voice — из уже сохранённых ответов (T7).** `AeoCheck.answerText` и
   `AeoCheck.citations` заполняются с момента появления трекера. Добавление конкурента
   пересчитывает историю **без** новых запросов к ИИ.
8. **Многозначный бренд — шум (T6).** По запросу «Golden Crown» Google News вернёт короны и
   отели. Поэтому у каждого термина есть `mustInclude` (контекстные слова), а в ленту попадает
   только совпадение по границе слова в заголовке или сниппете.

---

## 1. Prisma (T0 вставляет дословно)

### 1.1 Новые поля в существующих моделях

В `model Site` — после блока `clarityInterval`/GA4 (место не важно, важны имена):

```prisma
  // Uptime monitor (T2). One monitor per site; created lazily by the uptime scheduler when the
  // workspace has autoEnroll on, or explicitly from the site's Health tab.
  uptimeMonitor         UptimeMonitor?

  // Automatic URL Inspection (T4). JSON: IndexInspectSettings (src/lib/indexing/types.ts).
  // Null = defaults (DEFAULT_INDEX_INSPECT).
  indexInspect          String?
  indexCoverage         IndexCoverageDaily[]

  // Brand mentions (T6). JSON: MentionSettings (src/lib/mentions/types.ts). Null = off.
  mentionSettings       String?
  brandMentions         BrandMention[]

  // AI share of voice (T7). JSON: AiCompetitor[] (src/lib/visibility/types.ts). Null = none.
  aeoCompetitors        String?
```

В `model User` — рядом с `alertSettings`:

```prisma
  uptimeSettings   String? // JSON: UptimeWorkspaceSettings (src/lib/uptime/types.ts)
  notifyChannels   String? // JSON: NotifyChannelsConfig (src/lib/notify/types.ts) — secrets inside, never sent to the browser unmasked
```

В `model SitemapUrl` — после блока `googleChecked`:

```prisma
  googleVerdict   String?   // PASS | NEUTRAL | FAIL | PARTIAL | VERDICT_UNSPECIFIED (raw from the API)
  googleLastCrawl DateTime?
  googleCanonical String?   // Google-selected canonical, when it differs from the URL it is worth showing
  googleNextCheck DateTime? // when the auto-inspection queue may pick this URL again (T4)
```

и индекс в той же модели:

```prisma
  @@index([siteId, googleNextCheck])
```

### 1.2 Новые модели (в конец файла)

```prisma
// ─── Uptime monitor (T2) ─────────────────────────────────────────────────────
// One HTTP check per site every intervalMin. Raw checks are kept 7 days; UptimeDaily keeps the
// long history (uptime %, latency) forever at one row per monitor per UTC day. An incident is
// opened after failThreshold consecutive failures and closed by the first success after it.
model UptimeMonitor {
  id               String    @id @default(cuid())
  siteId           String    @unique
  enabled          Boolean   @default(true)
  url              String                        // absolute https URL; default = site root
  intervalMin      Int       @default(5)         // one of UPTIME_INTERVALS
  timeoutMs        Int       @default(15000)
  acceptStatus     String    @default("200-399") // ranges/codes, comma-separated: "200-399,401"
  keyword          String    @default("")        // must appear in the body when non-empty
  slowMs           Int       @default(5000)      // above this → degraded (still "up" for alerts)
  failThreshold    Int       @default(2)
  alerts           Boolean   @default(true)
  status           String    @default("unknown") // UptimeStatus
  statusSince      DateTime?
  consecutiveFails Int       @default(0)
  lastCheckedAt    DateTime?
  lastLatencyMs    Int?
  lastHttpStatus   Int?
  lastError        String?                       // UptimeCause code + short detail, ≤ 300 chars
  nextCheckAt      DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  site      Site             @relation(fields: [siteId], references: [id], onDelete: Cascade)
  checks    UptimeCheck[]
  daily     UptimeDaily[]
  incidents UptimeIncident[]

  @@index([enabled, nextCheckAt])
}

model UptimeCheck {
  id         String   @id @default(cuid())
  monitorId  String
  checkedAt  DateTime @default(now())
  ok         Boolean
  httpStatus Int?
  latencyMs  Int?
  cause      String?  // UptimeCause when !ok
  detail     String?  // ≤ 300 chars

  monitor UptimeMonitor @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@index([monitorId, checkedAt])
  @@index([checkedAt])
}

model UptimeDaily {
  monitorId  String
  day        String   // "YYYY-MM-DD", UTC
  checks     Int      @default(0)
  fails      Int      @default(0)
  latencySum Int      @default(0) // over successful checks only
  latencyMax Int      @default(0)
  downMs     Int      @default(0) // incident time falling inside this day

  monitor UptimeMonitor @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@id([monitorId, day])
}

model UptimeIncident {
  id          String    @id @default(cuid())
  monitorId   String
  startedAt   DateTime  // time of the FIRST failed check of the streak, not of confirmation
  endedAt     DateTime?
  cause       String    // UptimeCause of the confirming check
  detail      String?
  httpStatus  Int?
  alertedDown Boolean   @default(false)
  alertedUp   Boolean   @default(false)
  lastReminderAt DateTime?

  monitor UptimeMonitor @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@index([monitorId, startedAt])
  @@index([endedAt])
}

// ─── URL Inspection quota ledger (T4) ─────────────────────────────────────────
// Google's URL Inspection quota is 2000/day and 600/min PER PROPERTY, reset at midnight
// America/Los_Angeles. Every inspection from any path (manual button, MCP inspect_url, the
// auto queue) increments the same row, so the auto queue never starves the manual button.
model InspectionQuota {
  property String   // Site.siteId, e.g. "sc-domain:example.com"
  day      String   // "YYYY-MM-DD" in America/Los_Angeles
  used     Int      @default(0)
  auto     Int      @default(0) // part of `used` spent by the auto queue
  errors   Int      @default(0)
  exhaustedAt DateTime?        // set on a quota error from Google; the queue stops for this day

  @@id([property, day])
}

// One row per site per UTC day, written once a day by the T4 scheduler from SitemapUrl.
model IndexCoverageDaily {
  siteId     String
  day        String   // "YYYY-MM-DD", UTC
  total      Int      @default(0) // active sitemap URLs
  indexed    Int      @default(0)
  notIndexed Int      @default(0)
  unknown    Int      @default(0) // never inspected
  reasons    String?  // JSON: Record<coverageState, count> for notIndexed

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)

  @@id([siteId, day])
}

// ─── Brand mentions (T6) ─────────────────────────────────────────────────────
model BrandMention {
  id          String    @id @default(cuid())
  siteId      String
  source      String    // MentionSource
  kind        String    @default("mention") // MentionKind
  term        String    // the watched term that matched
  url         String
  urlKey      String    // normalizeMentionUrl(url) — dedupe key, ≤ 191 chars (sha1 hex when longer)
  title       String    @default("")
  snippet     String    @default("")
  publisher   String    @default("")
  lang        String    @default("")
  publishedAt DateTime?
  firstSeenAt DateTime  @default(now())
  linkStatus  String    @default("unchecked") // MentionLinkStatus
  linkCheckedAt DateTime?
  reviewed    Boolean   @default(false)
  dismissed   Boolean   @default(false)
  notifiedAt  DateTime?

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)

  @@unique([siteId, source, urlKey])
  @@index([siteId, firstSeenAt])
  @@index([siteId, dismissed, reviewed])
}
```

Больше ничего в схеме не меняется. `AeoCheck` для T7 **не** расширяется: всё нужное уже есть.

---

## 2. Общие типы (T0 создаёт дословно; дальше файлы не меняются)

Все файлы типов чистые: без импортов сервера, их импортируют клиентские компоненты.

### 2.1 `src/lib/seo/metaLimits.ts`

```ts
// One source of truth for meta-tag lengths. The audit (src/lib/audit/rules.ts) flags OUTSIDE
// the audit band; the generators (src/lib/seo/metaFit.ts) aim INSIDE the target band, which
// sits wholly inside the audit band so a freshly generated page is never flagged.
// Lengths are counted in Unicode code points (Array.from(s).length), after trimming.

export const META_LIMITS = {
  title:       { targetMin: 50,  targetMax: 60,  auditMin: 50,  auditMax: 65 },
  description: { targetMin: 150, targetMax: 160, auditMin: 150, auditMax: 165 },
} as const;

export type MetaField = keyof typeof META_LIMITS;

export const metaLength = (s: string): number => Array.from(s.trim()).length;

export type MetaFitMethod =
  | "kept"          // the value was already inside the target band
  | "picked"        // another existing option was inside the band and was chosen
  | "trimmed"       // deterministic removal of a trailing clause
  | "llm"           // a repair call produced an in-band variant
  | "forced_cut"    // word-boundary cut; last resort, reported as a concern
  | "unfixable";    // nothing worked (e.g. too short and no LLM allowed); left as is

export interface MetaFitResult {
  field: MetaField;
  before: string;
  after: string;
  length: number;
  method: MetaFitMethod;
  inBand: boolean;      // targetMin ≤ length ≤ targetMax
  auditOk: boolean;     // auditMin ≤ length ≤ auditMax
}

export interface MetaFitItem {
  id?: string;          // caller's id (history id, audit page url…) — echoed back
  keyword: string;      // main query; kept at the start of the title when possible
  language: string;     // ISO-639-1
  title?: string;
  description?: string;
  titleOptions?: string[];
  descriptionOptions?: string[];
  brand?: string;       // if present, may be dropped first when over the limit
}

export interface MetaFitResponse {
  id?: string;
  title?: MetaFitResult;
  description?: MetaFitResult;
  llmCalls: number;     // 0 when everything was solved deterministically
}
```

### 2.2 `src/lib/uptime/types.ts`

```ts
export type UptimeStatus = "up" | "degraded" | "down" | "unknown" | "paused" | "checker_offline";

export type UptimeCause =
  | "timeout" | "dns" | "tls" | "connect" | "http_status"
  | "keyword_missing" | "redirect_loop" | "blocked_target" | "other";

export const UPTIME_INTERVALS = [1, 3, 5, 10, 15, 30, 60] as const;
export const UPTIME_RAW_RETENTION_DAYS = 7;
export const UPTIME_CONFIRM_RECHECK_MS = 30_000;   // first failure → one quick re-check
export const UPTIME_OFFLINE_RATIO = 0.8;           // ≥ 80 % of ≥ 3 monitors fail in one tick → checker_offline

export interface UptimeWorkspaceSettings {
  autoEnroll: boolean;          // create a monitor for every live (not archived, not hidden) site
  defaultIntervalMin: number;   // one of UPTIME_INTERVALS
  reminderHours: number;        // 0 = no "still down" reminders
  heartbeatUrl: string;         // dead-man's switch pinged every scheduler tick; "" = off
  notifyDegraded: boolean;      // alert on degraded too (default false)
}

export const DEFAULT_UPTIME_SETTINGS: UptimeWorkspaceSettings = {
  autoEnroll: true, defaultIntervalMin: 5, reminderHours: 6, heartbeatUrl: "", notifyDegraded: false,
};

export interface UptimeCheckResult {
  ok: boolean;
  status: "up" | "degraded" | "down";
  httpStatus: number | null;
  latencyMs: number | null;
  cause: UptimeCause | null;
  detail: string | null;
  finalUrl: string | null;
}

/** Light per-site row for the dashboard dot. */
export interface UptimeBadge {
  siteId: string;
  status: UptimeStatus;
  since: string | null;         // ISO
  latencyMs: number | null;
  uptime24h: number | null;     // 0..100, null = no checks yet
  lastError: string | null;
}

export interface UptimeSummary {
  monitor: {
    id: string; url: string; enabled: boolean; intervalMin: number; timeoutMs: number;
    acceptStatus: string; keyword: string; slowMs: number; failThreshold: number; alerts: boolean;
  };
  badge: UptimeBadge;
  uptime: { d1: number | null; d7: number | null; d30: number | null; d90: number | null };
  latency: { day: string; avg: number | null; max: number | null }[];   // last 30 days
  incidents: { id: string; startedAt: string; endedAt: string | null; durationMs: number | null; cause: UptimeCause; detail: string | null; httpStatus: number | null }[];
}
```

### 2.3 `src/lib/notify/types.ts`

```ts
export type NotifyEvent = "alert" | "digest" | "uptime" | "index" | "mention" | "test";

export const NOTIFY_EVENTS: NotifyEvent[] = ["alert", "digest", "uptime", "index", "mention"];

export type NotifyChannelId = "telegram" | "slack" | "discord" | "teams" | "email" | "webhook";

export interface NotifyChannelBase {
  on: boolean;
  events: NotifyEvent[];       // empty = all events
  lastOkAt?: string | null;    // ISO, written by delivery
  lastError?: string | null;
}

export interface NotifyChannelsConfig {
  discord?: NotifyChannelBase & { url: string };
  teams?:   NotifyChannelBase & { url: string };
  webhook?: NotifyChannelBase & { url: string; secret: string };   // HMAC-SHA256 of the raw body → X-OpenGSC-Signature: sha256=<hex>
  email?:   NotifyChannelBase & {
    host: string; port: number; secure: boolean; user: string; pass: string;
    from: string; to: string[];
  };
  /** Event filters for the two channels whose credentials live in their own User columns. */
  telegramEvents?: NotifyEvent[];
  slackEvents?: NotifyEvent[];
}

/** What the settings UI receives: secrets replaced by masks, never the raw values. */
export interface NotifyChannelView {
  id: NotifyChannelId;
  configured: boolean;
  on: boolean;
  events: NotifyEvent[];
  target: string | null;       // masked URL / "user@host → a@b.c"
  lastOkAt: string | null;
  lastError: string | null;
}

export interface NotifyOptions {
  event?: NotifyEvent;         // default "alert"
  title?: string;              // subject for e-mail / card title; default = first line of text
}

export interface NotifyDelivery {
  channel: NotifyChannelId;
  ok: boolean;
  error?: string;
}
```

### 2.4 `src/lib/indexing/types.ts`

```ts
export interface IndexInspectSettings {
  on: boolean;
  dailyBudget: number;          // auto share of the 2000/day property quota; clamp 0..1800
  recheckIndexedDays: number;   // default 14
  recheckNotIndexedDays: number;// default 3
  alertOnLoss: boolean;         // indexed → not indexed for a page with clicks in the last 28 days
}

export const DEFAULT_INDEX_INSPECT: IndexInspectSettings = {
  on: false, dailyBudget: 1000, recheckIndexedDays: 14, recheckNotIndexedDays: 3, alertOnLoss: true,
};

export const INSPECTION_DAILY_LIMIT = 2000;   // Google, per property
export const INSPECTION_PER_MINUTE = 60;      // ours; Google allows 600 — we stay 10× below
export const INSPECTION_TZ = "America/Los_Angeles";

export type InspectPriority = "new" | "changed" | "not_indexed" | "stale_indexed";

export interface InspectCandidate {
  url: string;
  priority: InspectPriority;
  firstSeenAt: string;          // ISO
  googleChecked: string | null; // ISO
}

export interface InspectOutcome {
  url: string;
  ok: boolean;                  // the API answered
  verdict: string | null;
  coverageState: string | null;
  indexed: boolean | null;      // null when !ok
  lastCrawl: string | null;
  googleCanonical: string | null;
  error: string | null;
  quotaExhausted: boolean;
}

export interface IndexAutoStatus {
  settings: IndexInspectSettings;
  property: string;
  quota: { day: string; used: number; auto: number; limit: number; exhausted: boolean };
  queue: Record<InspectPriority, number>;
  coverage: { day: string; total: number; indexed: number; notIndexed: number; unknown: number }[]; // last 90 days
  reasons: { coverageState: string; count: number }[];   // current not-indexed breakdown
  recentLosses: { url: string; lostAt: string; coverageState: string | null; clicks28d: number }[];
}
```

### 2.5 `src/lib/mentions/types.ts`

```ts
export type MentionSource = "news" | "wikipedia" | "wikidata";
export type MentionKind = "mention" | "link" | "entity";
export type MentionLinkStatus = "unchecked" | "linked" | "unlinked" | "unreachable";

export interface MentionTerm {
  term: string;                 // exact phrase, searched quoted
  mustInclude: string[];        // at least one must also appear (context words); empty = none
}

export interface MentionSettings {
  on: boolean;
  terms: MentionTerm[];         // empty → derived from Site.brandedKeywords + host
  exclude: string[];            // drop results whose title/snippet contain any of these
  sources: MentionSource[];     // default all three
  lang: string;                 // ISO-639-1, default from site market
  country: string;              // gl, default Site.market or "us"
  notify: boolean;              // daily batch to notify channels (event "mention")
  lastRunAt?: string | null;
}

export const DEFAULT_MENTION_SOURCES: MentionSource[] = ["news", "wikipedia", "wikidata"];

export interface MentionHit {
  source: MentionSource;
  kind: MentionKind;
  term: string;
  url: string;
  title: string;
  snippet: string;
  publisher: string;
  lang: string;
  publishedAt: string | null;   // ISO
}

export interface MentionRow extends MentionHit {
  id: string;
  firstSeenAt: string;
  linkStatus: MentionLinkStatus;
  reviewed: boolean;
  dismissed: boolean;
}

export interface MentionQuery {
  source?: MentionSource | "all";
  state?: "new" | "reviewed" | "dismissed" | "all";
  linkStatus?: MentionLinkStatus | "all";
  q?: string;
  limit?: number;               // clamp 1..200, default 50
  offset?: number;
}
```

### 2.6 `src/lib/visibility/types.ts`

```ts
export interface AiCompetitor {
  name: string;                 // display name
  domain: string;               // host without www; "" when the rival has no site
  terms: string[];              // brand spellings; name is always included implicitly
}

export interface SovEngineRow {
  engine: string;               // AeoEngine
  answers: number;              // latest answer per question in the window
  us: { mentioned: number; cited: number; avgRank: number | null };
  competitors: { name: string; mentioned: number; cited: number }[];
}

export interface SovReport {
  window: { from: string; to: string };
  questions: number;
  answers: number;
  shareOfVoice: { name: string; isUs: boolean; mentions: number; share: number }[];   // share 0..1
  citationShare: { name: string; isUs: boolean; citations: number; share: number }[];
  byEngine: SovEngineRow[];
  trend: { week: string; usShare: number | null }[];            // ISO week "2026-W40"
}

export interface CitedDomainRow {
  domain: string;
  citations: number;            // total citation slots across answers
  answers: number;              // answers citing it at least once
  engines: string[];
  questions: number;
  exampleQuestion: string;
  exampleUrl: string;
  isUs: boolean;
  competitor: string | null;    // competitor name if the domain belongs to one
}

export interface SuggestedQuestion {
  question: string;
  impressions28d: number;
  clicks28d: number;
  page: string | null;
}
```

---

## 3. Сигнатуры модулей и заглушки

T0 создаёт каждый файл с **точными** экспортами. Тела — `throw new Error("wave: <fn> not implemented (Tn)")`.
Исключения, которые не бросают, отмечены. Типы импортируются из файлов §2.

### T1 — `src/lib/seo/metaFit.ts`
```ts
import type { MetaField, MetaFitItem, MetaFitResponse, MetaFitResult } from "./metaLimits";

/** Pure. Best existing candidate or a deterministic trim; never calls a model. */
export function fitMetaLocal(field: MetaField, value: string, options: string[], keyword: string, brand?: string): MetaFitResult;
/** Parse the ```Title: …``` block at the head of an article. Null when absent. */
export function readMetaBlock(text: string): { title: string; description: string; slug: string } | null;
/** Replace the values inside an existing block; returns text unchanged when no block. */
export function writeMetaBlock(text: string, meta: { title?: string; description?: string }): string;
/** Local first, then up to 2 repair calls when allowLlm. */
export async function fitMeta(item: MetaFitItem, llm: { allow: boolean; provider?: string; apiKey?: string; model?: string; baseUrl?: string }): Promise<MetaFitResponse>;
```

### T2 — `src/lib/uptime/`
```ts
// check.ts (pure except the fetch; the classifier is exported separately for tests)
export function parseAcceptStatus(spec: string): (code: number) => boolean;
export function classifyCheck(input: { httpStatus: number | null; latencyMs: number | null; error: unknown; bodyHasKeyword: boolean | null }, monitor: { acceptStatus: string; slowMs: number }): import("./types").UptimeCheckResult;
export async function runUptimeCheck(monitor: { url: string; timeoutMs: number; acceptStatus: string; keyword: string; slowMs: number }): Promise<import("./types").UptimeCheckResult>;

// state.ts (pure)
export interface MonitorState { status: import("./types").UptimeStatus; consecutiveFails: number; openIncidentId: string | null }
export type Transition = "none" | "confirm_pending" | "went_down" | "recovered" | "degraded" | "undegraded";
export function nextState(prev: MonitorState, result: import("./types").UptimeCheckResult, failThreshold: number): { state: MonitorState; transition: Transition };
export function isCheckerOffline(results: { ok: boolean }[]): boolean;

// store.ts
export async function uptimeBadges(userId: string): Promise<import("./types").UptimeBadge[]>;
export async function uptimeSummary(userId: string, siteId: string): Promise<import("./types").UptimeSummary | null>;
export async function upsertMonitor(userId: string, siteId: string, patch: Partial<import("./types").UptimeSummary["monitor"]>): Promise<import("./types").UptimeSummary>;
export async function getUptimeSettings(userId: string): Promise<import("./types").UptimeWorkspaceSettings>;
export async function saveUptimeSettings(userId: string, s: import("./types").UptimeWorkspaceSettings): Promise<void>;

// scheduler.ts — startUptimeScheduler / kickUptimeScheduler are EMPTY functions in the stub (no throw)
export function startUptimeScheduler(): void;
export function kickUptimeScheduler(): void;
export async function checkMonitorNow(userId: string, siteId: string): Promise<import("./types").UptimeCheckResult>;
```

### T3 — `src/lib/notify.ts` (фасад, сигнатуры существующих функций не меняются) и `src/lib/notify/`
```ts
// notify.ts — existing exports stay: sendTelegram, detectChatId, getTelegramCreds, getSlackWebhook,
// telegramToSlackMarkdown, sendSlack. notifyUser gains an OPTIONAL third argument:
export async function notifyUser(userId: string, text: string, opts?: import("./notify/types").NotifyOptions): Promise<boolean>;
// true when at least one channel delivered. Existing two-argument calls keep working and count as event "alert".
export async function notifyUserDetailed(userId: string, text: string, opts?: import("./notify/types").NotifyOptions): Promise<import("./notify/types").NotifyDelivery[]>;

// notify/format.ts (pure)
export function toDiscordChunks(text: string): string[];          // ≤ 2000 chars each
export function toTeamsCard(title: string, text: string): object; // Adaptive Card 1.4 envelope for Workflows webhooks
export function toEmail(title: string, text: string): { subject: string; text: string; html: string };
export function toWebhookBody(event: import("./notify/types").NotifyEvent, title: string, text: string, instance: string): string; // JSON string
export function signWebhook(secret: string, body: string): string;  // "sha256=<hex>"
export function eventAllowed(events: import("./notify/types").NotifyEvent[] | undefined, event: import("./notify/types").NotifyEvent): boolean;

// notify/channels.ts
export async function readChannels(userId: string): Promise<import("./notify/types").NotifyChannelsConfig>;
export async function channelViews(userId: string): Promise<import("./notify/types").NotifyChannelView[]>;
export async function saveChannel(userId: string, id: Exclude<import("./notify/types").NotifyChannelId, "telegram" | "slack">, patch: Record<string, unknown>): Promise<import("./notify/types").NotifyChannelView>;
export async function testChannel(userId: string, id: import("./notify/types").NotifyChannelId): Promise<import("./notify/types").NotifyDelivery>;
```
Заглушка `notifyUser` в T0 **не** бросает: T0 только добавляет в существующую функцию
необязательный третий параметр `opts` (он пока игнорируется). Остальное T0 не трогает.

### T4 — `src/lib/indexing/`
```ts
// queue.ts (pure)
export function pacificDay(d: Date): string;                       // "YYYY-MM-DD" in America/Los_Angeles
export function pickInspectBatch(rows: { url: string; firstSeenAt: Date; googleChecked: Date | null; googleNextCheck: Date | null; googleStatus: string | null; changeStatus: string; inventoryStatus: string }[], now: Date, limit: number): import("./types").InspectCandidate[];
export function nextCheckAt(outcome: import("./types").InspectOutcome, settings: import("./types").IndexInspectSettings, now: Date): Date;
export function isIndexedCoverage(coverageState: string | null, verdict: string | null): boolean | null;

// quota.ts
export async function quotaToday(property: string): Promise<{ day: string; used: number; auto: number; exhausted: boolean }>;
export async function recordInspections(property: string, n: number, opts: { auto: boolean; errors?: number; exhausted?: boolean }): Promise<void>;
export async function remainingToday(property: string, autoBudget: number): Promise<number>; // min(limit − used, budget − auto), ≥ 0

// inspect.ts
export async function inspectUrls(userId: string, siteDbId: string, urls: string[], opts: { auto: boolean }): Promise<import("./types").InspectOutcome[]>;

// status.ts
export async function indexAutoStatus(userId: string, siteDbId: string): Promise<import("./types").IndexAutoStatus | null>;
export async function saveIndexInspect(userId: string, siteDbId: string, s: import("./types").IndexInspectSettings): Promise<void>;

// scheduler.ts — start/kick are EMPTY in the stub
export function startIndexScheduler(): void;
export function kickIndexScheduler(): void;
```

### T5 — `src/lib/audit/`
Сигнатуры внутри `src/lib/audit/**` T5 определяет сам: снаружи на них никто не опирается.
Внешнее обязательство одно — новые id правил и их `titleKey` из §7 (они уже в локалях).
Заглушки T0 для T5: `src/lib/audit/hreflang.ts`, `src/lib/audit/queryAlign.ts`,
`src/lib/audit/psi.ts` — каждая с одним экспортом `export {}` и комментарием «T5».

### T6 — `src/lib/mentions/`
```ts
// parse.ts (pure)
export function parseGoogleNewsRss(xml: string, term: string, lang: string): import("./types").MentionHit[];
export function matchesTerm(text: string, t: import("./types").MentionTerm): boolean;      // word-boundary, case- and diacritics-insensitive
export function isExcluded(hit: import("./types").MentionHit, exclude: string[]): boolean;
export function normalizeMentionUrl(url: string): string;                                 // ≤ 191 chars
export function deriveTerms(brandedKeywords: string | null, host: string): import("./types").MentionTerm[];

// sources.ts
export async function fetchNews(t: import("./types").MentionTerm, lang: string, country: string): Promise<import("./types").MentionHit[]>;
export async function fetchWikipedia(terms: import("./types").MentionTerm[], host: string, lang: string): Promise<import("./types").MentionHit[]>;
export async function fetchWikidata(host: string, name: string): Promise<import("./types").MentionHit[]>;

// store.ts
export async function runMentions(userId: string, siteDbId: string): Promise<{ found: number; inserted: number; errors: string[] }>;
export async function listMentions(userId: string, siteDbId: string, q: import("./types").MentionQuery): Promise<{ total: number; rows: import("./types").MentionRow[] } | { notMigrated: true }>;
export async function updateMention(userId: string, id: string, patch: { reviewed?: boolean; dismissed?: boolean }): Promise<void>;
export async function checkMentionLink(userId: string, id: string): Promise<import("./types").MentionLinkStatus>;
export async function getMentionSettings(userId: string, siteDbId: string): Promise<import("./types").MentionSettings>;
export async function saveMentionSettings(userId: string, siteDbId: string, s: import("./types").MentionSettings): Promise<void>;

// scheduler.ts — start/kick are EMPTY in the stub
export function startMentionsScheduler(): void;
export function kickMentionsScheduler(): void;
```

### T7 — `src/lib/visibility/`
```ts
// sov.ts (pure)
export interface SovAnswer { questionId: string; question: string; engine: string; checkedAt: Date; answerText: string | null; citations: { url: string; domain: string; title: string }[]; rank: number | null; status: string | null }
export function mentionsOf(text: string, terms: string[]): boolean;                       // word-boundary, case/diacritics-insensitive
export function latestPerQuestionEngine(answers: SovAnswer[], from: Date, to: Date): SovAnswer[];
export function buildSovReport(answers: SovAnswer[], us: { host: string; terms: string[] }, rivals: import("./types").AiCompetitor[], from: Date, to: Date): import("./types").SovReport;
export function buildCitedDomains(answers: SovAnswer[], us: { host: string }, rivals: import("./types").AiCompetitor[], limit: number): import("./types").CitedDomainRow[];
export function questionLike(query: string, lang: string): boolean;                      // who/what/how/best… + per-language equivalents

// store.ts
export async function sovForSite(userId: string, siteDbId: string, days: number): Promise<{ report: import("./types").SovReport; cited: import("./types").CitedDomainRow[] } | null>;
export async function getCompetitors(userId: string, siteDbId: string): Promise<import("./types").AiCompetitor[]>;
export async function saveCompetitors(userId: string, siteDbId: string, list: import("./types").AiCompetitor[]): Promise<void>;
export async function suggestQuestions(userId: string, siteDbId: string, limit: number): Promise<import("./types").SuggestedQuestion[]>;
```

---

## 4. HTTP API

Все маршруты возвращают `{ error: "<code>" }` со стабильным кодом; UI переводит код через `t()`.
Таблицы нет → `200 { notMigrated: true }`.

| Метод и путь | Право | Владелец | Тело / ответ |
|---|---|---|---|
| `POST /api/seo/meta-fit` | `act` (LLM — `spend`) | T1 | `{ items: MetaFitItem[] (≤ 50), allowLlm?: boolean, historyIds?: string[] }` → `{ results: MetaFitResponse[] }`. `allowLlm: true` без права `spend` → 403 `spend_required`. При `historyIds` мета записывается обратно в `SeoHistory.data` |
| `GET /api/uptime/status` | `read` | T2 | → `{ badges: UptimeBadge[] }` (для дашборда, один запрос) |
| `GET /api/uptime/[siteId]` | `read` | T2 | → `UptimeSummary` \| `{ monitor: null }` |
| `PUT /api/uptime/[siteId]` | `act` | T2 | patch полей монитора → `UptimeSummary` |
| `POST /api/uptime/[siteId]/check` | `act` | T2 | → `UptimeCheckResult` |
| `GET·PUT /api/uptime/settings` | `read`·`act` | T2 | `UptimeWorkspaceSettings` |
| `GET /api/settings/notify-channels` | `read` | T3 | → `{ channels: NotifyChannelView[] }` |
| `PUT /api/settings/notify-channels` | `act` | T3 | `{ id, patch }` → `NotifyChannelView`. Пустая строка в поле секрета = «не менять» |
| `POST /api/settings/notify-channels/test` | `act` | T3 | `{ id }` → `NotifyDelivery` |
| `GET /api/indexing/auto?siteId=` | `read` | T4 | → `IndexAutoStatus` |
| `PUT /api/indexing/auto` | `act` | T4 | `{ siteId, settings: IndexInspectSettings }` |
| `POST /api/indexing/auto/run` | `act` | T4 | `{ siteId, limit? ≤ 200 }` → `{ inspected, indexed, notIndexed, errors, quota }` (бесплатно, тратит квоту) |
| `GET /api/mentions?siteId=&…MentionQuery` | `read` | T6 | → `{ total, rows }` |
| `POST /api/mentions/run` | `act` | T6 | `{ siteId }` → `{ found, inserted, errors }` |
| `PATCH /api/mentions/[id]` | `act` | T6 | `{ reviewed?, dismissed? }` |
| `POST /api/mentions/[id]/check-link` | `act` | T6 | → `{ linkStatus }` |
| `GET·PUT /api/mentions/settings?siteId=` | `read`·`act` | T6 | `MentionSettings` |
| `POST /api/mentions/[id]/outreach` | `act` | T6 | → `{ prospectId }` — через тот же серверный сервис, что MCP `save_outreach_prospect` |
| `POST /api/aeo/cited-to-outreach` | `act` | T7 | `{ siteId, domain }` → `{ prospectId }` — так же |
| `GET /api/aeo/sov?siteId=&days=` | `read` | T7 | → `{ report: SovReport, cited: CitedDomainRow[] }` |
| `GET·PUT /api/aeo/competitors?siteId=` | `read`·`act` | T7 | `AiCompetitor[]` |
| `GET /api/aeo/suggest-questions?siteId=&limit=` | `read` | T7 | → `{ items: SuggestedQuestion[] }` |

`/api/audit/**` T5 меняет только если нужно, наружу контракт не меняется.

---

## 5. MCP-инструменты

T0 создаёт файлы с пустыми массивами и регистрирует их в `MCP_TOOLS` (`src/lib/mcp/tools.ts`):
`META_TOOLS` (`toolsMeta.ts`, T1), `UPTIME_TOOLS` (`toolsUptime.ts`, T2), `INDEX_TOOLS`
(`toolsIndex.ts`, T4), `MENTIONS_TOOLS` (`toolsMentions.ts`, T6), `VISIBILITY_TOOLS`
(`toolsVisibility.ts`, T7). Каждый экспорт — `McpTool[]`.

| Имя | cost | Владелец | Что делает |
|---|---|---|---|
| `fit_meta` | `local` (`paid` при `allow_llm`, тогда нужен `confirm: true`) | T1 | `items[]` → подогнанные title/description |
| `get_uptime` | `local` | T2 | статусы всех сайтов или сводка одного (`site`) |
| `get_index_coverage` | `local` | T4 | покрытие по дням, причины, недавние выпадения, квота |
| `get_brand_mentions` | `local` | T6 | лента упоминаний с фильтрами `MentionQuery` |
| `get_ai_share_of_voice` | `local` | T7 | `SovReport` + топ цитируемых доменов |

---

## 6. Регистрация тестов (T0)

В конец строки `test:unit` в `package.json` через пробел, без кавычек и без перестановок:

```
src/lib/seo/metaFit.test.ts src/lib/uptime/*.test.ts src/lib/notify/*.test.ts src/lib/indexing/*.test.ts src/lib/mentions/*.test.ts src/lib/visibility/*.test.ts src/lib/audit/hreflang.test.ts src/lib/audit/queryAlign.test.ts
```

T0 кладёт в каждую папку с глобом `types.test.ts` с реальными проверками констант (§2), а
`metaFit.test.ts`, `hreflang.test.ts` и `queryAlign.test.ts` делает с одним тестом-заглушкой
`test("placeholder (Tn)", () => {})`. Задачи переписывают их целиком.

T0 добавляет зависимость `nodemailer` (последняя 6.x или 7.x) и `@types/nodemailer` в
devDependencies для T3.

---

## 7. i18n-ключи

T0 создаёт **все** ключи во всех семи локалях: en и ru — дословно из таблиц, остальные пять
(uk, fr, es, de, zh) переводит сам, коротко и в тоне соседних ключей. Плейсхолдеры `{n}`,
`{site}` и т. п. не переводить.

### 7.1 Изменение существующего ключа
| ключ | en | ru |
|---|---|---|
| `tabAeo` | Visibility | Видимость |

(uk «Видимість», fr «Visibilité», es «Visibilidad», de «Sichtbarkeit», zh «可见度».)

### 7.2 Хаб «Видимость» (T0)
| ключ | en | ru |
|---|---|---|
| `visTabAi` | AI answers | Ответы ИИ |
| `visTabSov` | Share of voice | Доля голоса |
| `visTabMentions` | Mentions | Упоминания |
| `visTabLlm` | LLM Mentions (index) | LLM Mentions (индекс) |
| `visHubHint` | How visible the brand is in AI answers, news and Wikipedia | Насколько бренд заметен в ответах ИИ, новостях и Википедии |

### 7.3 T1 — мета
| ключ | en | ru |
|---|---|---|
| `metaFitTitle` | Meta tags | Мета-теги |
| `metaFitLen` | {n}/{max} | {n}/{max} |
| `metaFitOk` | Within limits | В пределах нормы |
| `metaFitTooLong` | Too long | Слишком длинный |
| `metaFitTooShort` | Too short | Слишком короткий |
| `metaFitMethod_kept` | Kept as written | Оставлен как есть |
| `metaFitMethod_picked` | Another suggested option fit | Подошёл другой вариант |
| `metaFitMethod_trimmed` | Trailing clause removed | Убрана хвостовая часть |
| `metaFitMethod_llm` | Rewritten to fit | Переписан под лимит |
| `metaFitMethod_forced_cut` | Cut at a word boundary — review | Обрезан по слову — проверьте |
| `metaFitMethod_unfixable` | Could not be fixed automatically | Не удалось исправить автоматически |
| `metaFitRun` | Fit meta tags | Подогнать мету |
| `metaFitRunFree` | Try free fix | Бесплатная попытка |
| `metaFitRunLlm` | Rewrite with AI (uses credits) | Переписать с ИИ (тратит кредиты) |
| `metaFitConfirm` | This makes up to {n} AI calls on your key. Continue? | Будет до {n} запросов к ИИ на вашем ключе. Продолжить? |
| `metaFitApplied` | Meta tags updated | Мета-теги обновлены |
| `metaFitNothing` | Nothing to fix | Исправлять нечего |
| `metaFitSuggest` | Suggest fixed meta | Предложить исправленную мету |
| `metaFitCopy` | Copy | Копировать |

### 7.4 T2 — аптайм
| ключ | en | ru |
|---|---|---|
| `uptimeTitle` | Uptime | Аптайм |
| `uptimeStatus_up` | Online | Онлайн |
| `uptimeStatus_degraded` | Slow | Медленно |
| `uptimeStatus_down` | Offline | Офлайн |
| `uptimeStatus_unknown` | Not checked yet | Ещё не проверялся |
| `uptimeStatus_paused` | Monitoring off | Мониторинг выключен |
| `uptimeStatus_checker_offline` | Check unavailable (server network) | Проверка недоступна (сеть сервера) |
| `uptimeCause_timeout` | Timeout | Таймаут |
| `uptimeCause_dns` | DNS error | Ошибка DNS |
| `uptimeCause_tls` | SSL/TLS error | Ошибка SSL/TLS |
| `uptimeCause_connect` | Connection refused | Соединение отклонено |
| `uptimeCause_http_status` | HTTP {code} | HTTP {code} |
| `uptimeCause_keyword_missing` | Expected text not found | Ожидаемый текст не найден |
| `uptimeCause_redirect_loop` | Redirect loop | Цикл редиректов |
| `uptimeCause_blocked_target` | Address not allowed | Адрес запрещён |
| `uptimeCause_other` | Error | Ошибка |
| `uptimeSince` | since {time} | с {time} |
| `uptimeLatency` | {ms} ms | {ms} мс |
| `uptimePct` | Uptime {d} | Аптайм за {d} |
| `uptime24h` | 24 h | 24 ч |
| `uptime7d` | 7 days | 7 дней |
| `uptime30d` | 30 days | 30 дней |
| `uptime90d` | 90 days | 90 дней |
| `uptimeIncidents` | Incidents | Инциденты |
| `uptimeNoIncidents` | No incidents | Инцидентов нет |
| `uptimeOngoing` | ongoing | продолжается |
| `uptimeDuration` | {d} | {d} |
| `uptimeCheckNow` | Check now | Проверить сейчас |
| `uptimeUrl` | Monitored URL | URL для проверки |
| `uptimeInterval` | Check every | Проверять каждые |
| `uptimeIntervalMin` | {n} min | {n} мин |
| `uptimeTimeout` | Timeout, s | Таймаут, с |
| `uptimeAccept` | Accepted HTTP codes | Допустимые HTTP-коды |
| `uptimeKeyword` | Page must contain | Страница должна содержать |
| `uptimeSlow` | Slow above, ms | Медленно, если дольше, мс |
| `uptimeFailThreshold` | Failures before alert | Неудач подряд до алерта |
| `uptimeAlerts` | Send alerts | Отправлять алерты |
| `uptimeEnabled` | Monitor this site | Мониторить сайт |
| `uptimeNeedsAttention` | Needs attention | Требуют внимания |
| `uptimeDownCount` | {n} offline | {n} офлайн |
| `uptimeFilter` | Status | Статус |
| `uptimeFilterAll` | All | Все |
| `uptimeFilterIssues` | Offline or slow | Офлайн или медленно |
| `uptimeSettingsTitle` | Uptime monitoring | Мониторинг аптайма |
| `uptimeAutoEnroll` | Monitor every new site automatically | Автоматически мониторить новые сайты |
| `uptimeDefaultInterval` | Default interval | Интервал по умолчанию |
| `uptimeReminder` | Remind while down, every (h; 0 = off) | Напоминать, пока лежит, каждые (ч; 0 — нет) |
| `uptimeNotifyDegraded` | Alert on slow responses too | Алертить и о медленных ответах |
| `uptimeHeartbeat` | Heartbeat URL (dead-man's switch) | Heartbeat URL (контроль самого сервера) |
| `uptimeHeartbeatHint` | OpenGSC pings this URL every minute. If the server itself dies, the external service (e.g. healthchecks.io) alerts you. | OpenGSC пингует этот URL раз в минуту. Если упадёт сам сервер, внешний сервис (например, healthchecks.io) предупредит вас. |
| `uptimeFree` | free · runs on your server | бесплатно · работает на вашем сервере |

### 7.5 T3 — каналы
| ключ | en | ru |
|---|---|---|
| `notifyChTitle` | Delivery channels | Каналы доставки |
| `notifyChDiscord` | Discord | Discord |
| `notifyChTeams` | Microsoft Teams | Microsoft Teams |
| `notifyChEmail` | E-mail (SMTP) | E-mail (SMTP) |
| `notifyChWebhook` | Webhook | Webhook |
| `notifyChUrl` | Webhook URL | Webhook URL |
| `notifyChSecret` | Signing secret | Секрет для подписи |
| `notifyChSecretHint` | Requests carry X-OpenGSC-Signature: sha256=HMAC(body) | Запросы подписаны заголовком X-OpenGSC-Signature: sha256=HMAC(body) |
| `notifyChTeamsHint` | Use a Teams "Workflows" webhook (Office 365 connectors are retired) | Используйте webhook из Teams «Workflows» (коннекторы Office 365 закрыты) |
| `notifyChSmtpHost` | SMTP host | SMTP-сервер |
| `notifyChSmtpPort` | Port | Порт |
| `notifyChSmtpSecure` | TLS (port 465) | TLS (порт 465) |
| `notifyChSmtpUser` | Login | Логин |
| `notifyChSmtpPass` | Password / app password | Пароль / пароль приложения |
| `notifyChFrom` | From | Отправитель |
| `notifyChTo` | Recipients (comma-separated) | Получатели (через запятую) |
| `notifyChEvents` | Send | Отправлять |
| `notifyChEventsAll` | Everything | Всё |
| `notifyEv_alert` | Alerts | Алерты |
| `notifyEv_digest` | Digests | Дайджесты |
| `notifyEv_uptime` | Uptime | Аптайм |
| `notifyEv_index` | Indexing | Индексация |
| `notifyEv_mention` | Mentions | Упоминания |
| `notifyChTest` | Send test | Отправить тест |
| `notifyChTestOk` | Delivered | Доставлено |
| `notifyChLastOk` | Last delivered {time} | Последняя доставка {time} |
| `notifyChLastError` | Last error: {error} | Последняя ошибка: {error} |
| `notifyChSaved` | Saved | Сохранено |
| `notifyChKeep` | Leave empty to keep the current value | Оставьте пустым, чтобы не менять |
| `notifyChErr_invalid_url` | This URL is not a valid webhook for this service | Это не webhook этого сервиса |
| `notifyChErr_private_address` | Internal addresses are not allowed | Внутренние адреса запрещены |
| `notifyChErr_smtp_auth` | SMTP login failed | SMTP: неверный логин или пароль |
| `notifyChErr_smtp_connect` | Cannot reach the SMTP server | SMTP-сервер недоступен |

### 7.6 T4 — индексация
| ключ | en | ru |
|---|---|---|
| `idxAutoTitle` | Automatic index checks | Автопроверка индексации |
| `idxAutoHint` | Uses Google's free URL Inspection quota (2,000 URLs/day per property, resets at midnight Pacific). Paid checkers are not used. | Тратит бесплатную квоту Google URL Inspection (2000 URL в день на ресурс, сброс в полночь по Тихоокеанскому времени). Платные сервисы не используются. |
| `idxAutoOn` | Check automatically | Проверять автоматически |
| `idxAutoBudget` | Daily budget for auto checks | Дневной бюджет автопроверки |
| `idxAutoQuota` | Today: {used}/{limit} (auto {auto}) | Сегодня: {used}/{limit} (авто {auto}) |
| `idxAutoExhausted` | Google quota exhausted until midnight Pacific | Квота Google исчерпана до полуночи по Тихоокеанскому времени |
| `idxAutoRecheckIndexed` | Re-check indexed pages every (days) | Перепроверять проиндексированные каждые (дн.) |
| `idxAutoRecheckNot` | Re-check not indexed every (days) | Перепроверять непроиндексированные каждые (дн.) |
| `idxAutoAlertLoss` | Alert when a page with traffic drops out of the index | Алерт, если страница с трафиком выпала из индекса |
| `idxAutoQueue` | Queue | Очередь |
| `idxAutoPri_new` | Never checked | Не проверялись |
| `idxAutoPri_changed` | Changed | Изменились |
| `idxAutoPri_not_indexed` | Not indexed — recheck | Не в индексе — перепроверка |
| `idxAutoPri_stale_indexed` | Indexed — recheck | В индексе — перепроверка |
| `idxAutoCoverage` | Index coverage | Покрытие индексом |
| `idxAutoIndexed` | Indexed | В индексе |
| `idxAutoNotIndexed` | Not indexed | Не в индексе |
| `idxAutoUnknown` | Unknown | Неизвестно |
| `idxAutoReasons` | Why not indexed | Почему не в индексе |
| `idxAutoLosses` | Dropped out recently | Недавно выпали |
| `idxAutoRunNow` | Check a batch now | Проверить пачку сейчас |
| `idxAutoRunDone` | Checked {n}: {indexed} indexed, {not} not | Проверено {n}: в индексе {indexed}, нет {not} |
| `idxAutoFree` | free · Google quota | бесплатно · квота Google |
| `idxAutoNoGoogle` | Connect the Google account that owns this property | Подключите Google-аккаунт, которому принадлежит ресурс |

### 7.7 T5 — правила аудита
| ключ | en | ru |
|---|---|---|
| `auditIssueHreflangInvalid` | Invalid hreflang annotation | Некорректная разметка hreflang |
| `auditIssueHreflangNoReturn` | hreflang without a return link | hreflang без обратной ссылки |
| `auditIssueHreflangSelfMissing` | hreflang set does not include the page itself | В наборе hreflang нет самой страницы |
| `auditIssueHreflangTargetBad` | hreflang points to a redirect, error, noindex or non-canonical page | hreflang ведёт на редирект, ошибку, noindex или неканоническую страницу |
| `auditIssueHreflangXDefaultMissing` | No x-default in the hreflang set | Нет x-default в наборе hreflang |
| `auditIssueLangHreflangMismatch` | html lang differs from the page's own hreflang | html lang не совпадает с hreflang самой страницы |
| `auditIssueViewportNotResponsive` | Viewport is not responsive or blocks zoom | Viewport не адаптивный или запрещает масштабирование |
| `auditIssueImagesNoDimensions` | Images without width/height (layout shift risk) | Изображения без width/height (риск сдвига макета) |
| `auditIssueInternalRedirectLinks` | Internal links point to redirects | Внутренние ссылки ведут на редиректы |
| `auditIssueTitleQueryMismatch` | Title and H1 miss the page's main search query | Title и H1 не содержат главный запрос страницы |
| `auditIssueCwvPoor` | Poor Core Web Vitals (sampled page) | Плохие Core Web Vitals (страница из выборки) |
| `auditIssueHtmlTooLarge` | HTML document is very large | HTML-документ слишком большой |
| `auditPsiTitle` | PageSpeed sample | Выборка PageSpeed |
| `auditPsiHint` | Mobile PageSpeed Insights on one page per template. Field data when Google has it, lab data otherwise. | PageSpeed Insights (мобильный) по одной странице на шаблон. Полевые данные, если они есть у Google, иначе лабораторные. |
| `auditPsiUnavailable` | Not run: no PageSpeed API key (Settings → API Keys → Health Check) | Не запускалось: нет ключа PageSpeed (Настройки → API-ключи → Health Check) |
| `auditPsiField` | field | полевые |
| `auditPsiLab` | lab | лаб. |
| `auditPsiScore` | Score | Оценка |
| `auditEvidenceQuery` | Main query: “{q}” · {n} impressions / 28 d | Главный запрос: «{q}» · {n} показов / 28 дн |

### 7.8 T6 — упоминания
| ключ | en | ru |
|---|---|---|
| `mentionsTitle` | Brand mentions | Упоминания бренда |
| `mentionsHint` | Google News and Wikipedia, checked daily. Free public sources. | Google News и Википедия, раз в день. Бесплатные открытые источники. |
| `mentionsOn` | Watch mentions | Отслеживать упоминания |
| `mentionsTerms` | Brand terms | Брендовые слова |
| `mentionsTermHint` | Exact phrase. Add context words if the name is ambiguous. | Точная фраза. Если название многозначное, добавьте контекстные слова. |
| `mentionsMustInclude` | …and one of | …и одно из |
| `mentionsExclude` | Exclude results containing | Исключать результаты со словами |
| `mentionsSource_news` | News | Новости |
| `mentionsSource_wikipedia` | Wikipedia | Википедия |
| `mentionsSource_wikidata` | Wikidata | Wikidata |
| `mentionsKind_mention` | Mention | Упоминание |
| `mentionsKind_link` | Links to you | Ссылается на вас |
| `mentionsKind_entity` | Entity | Сущность |
| `mentionsLink_unchecked` | Link not checked | Ссылка не проверена |
| `mentionsLink_linked` | Links to you | Есть ссылка |
| `mentionsLink_unlinked` | No link — outreach opportunity | Ссылки нет — повод для outreach |
| `mentionsLink_unreachable` | Page unreachable | Страница недоступна |
| `mentionsCheckLink` | Check link | Проверить ссылку |
| `mentionsToOutreach` | Add to Outreach | В Outreach |
| `mentionsReviewed` | Mark reviewed | Просмотрено |
| `mentionsDismiss` | Dismiss | Скрыть |
| `mentionsState_new` | New | Новые |
| `mentionsState_reviewed` | Reviewed | Просмотренные |
| `mentionsState_dismissed` | Dismissed | Скрытые |
| `mentionsRunNow` | Check now | Проверить сейчас |
| `mentionsRunDone` | Found {n}, new {m} | Найдено {n}, новых {m} |
| `mentionsEmpty` | No mentions yet | Упоминаний пока нет |
| `mentionsNotify` | Daily summary to notification channels | Ежедневная сводка в каналы уведомлений |
| `mentionsFree` | free · public sources | бесплатно · открытые источники |

### 7.9 T7 — доля голоса
| ключ | en | ru |
|---|---|---|
| `aiSovTitle` | Share of voice in AI answers | Доля голоса в ответах ИИ |
| `aiSovHint` | Computed from answers already stored by the tracker — adding a competitor costs nothing. | Считается по ответам, которые трекер уже сохранил: добавление конкурента ничего не стоит. |
| `aiSovShare` | Share of voice | Доля голоса |
| `aiSovCitationShare` | Citation share | Доля цитирований |
| `aiSovAvgRank` | Avg. rank among cited | Средняя позиция среди цитируемых |
| `aiSovUs` | You | Вы |
| `aiSovCompetitors` | Competitors | Конкуренты |
| `aiSovAddCompetitor` | Add competitor | Добавить конкурента |
| `aiSovCompName` | Name | Название |
| `aiSovCompDomain` | Domain | Домен |
| `aiSovCompTerms` | Other spellings | Другие написания |
| `aiSovByEngine` | By engine | По движкам |
| `aiSovTrend` | Weekly trend | Динамика по неделям |
| `aiSovWindow` | Last {n} days | За {n} дней |
| `aiSovNoData` | No stored answers in this window yet | За этот период ответов ещё нет |
| `aiCitedTitle` | Sources AI cites for your questions | Источники, которые ИИ цитирует по вашим вопросам |
| `aiCitedHint` | Being mentioned on these sites is how you get into the answers. | Попасть в ответы ИИ проще всего через упоминание на этих сайтах. |
| `aiCitedCitations` | Citations | Цитирований |
| `aiCitedAnswers` | Answers | Ответов |
| `aiCitedEngines` | Engines | Движки |
| `aiCitedToOutreach` | Add to Outreach | В Outreach |
| `aiSuggestTitle` | Question ideas from Search Console | Идеи вопросов из Search Console |
| `aiSuggestAdd` | Track | Отслеживать |
| `aiSuggestEmpty` | No question-like queries in the last 28 days | За 28 дней нет запросов в форме вопроса |
| `aeoEngineGemini` | Gemini | Gemini |

---

## 8. Шаблоны уведомлений (T0, `src/lib/notifyI18n.ts`)

В тип `Tpl` добавляются поля ниже; T0 заполняет все семь языков. Формат — тот же, что у
соседних шаблонов (Telegram-markdown, `*жирный*`). `dur` — уже отформатированная
длительность («12 мин», «2 ч 5 мин»); форматтер `formatDuration(ms, lang)` T0 экспортирует
из этого же файла.

| поле | en | ru |
|---|---|---|
| `uptimeDownTitle: (site) => string` | 🔴 {site} is down | 🔴 {site} недоступен |
| `uptimeDownMsg: (site, url, cause, since) => string` | *{site}* is not responding.\nURL: {url}\nReason: {cause}\nSince: {since} | *{site}* не отвечает.\nURL: {url}\nПричина: {cause}\nС: {since} |
| `uptimeStillDownMsg: (site, dur) => string` | *{site}* is still down ({dur}). | *{site}* всё ещё недоступен ({dur}). |
| `uptimeUpTitle: (site) => string` | 🟢 {site} is back | 🟢 {site} снова работает |
| `uptimeUpMsg: (site, dur) => string` | *{site}* is responding again. Downtime: {dur}. | *{site}* снова отвечает. Простой: {dur}. |
| `uptimeDegradedMsg: (site, ms) => string` | 🟡 *{site}* is slow: {ms} ms. | 🟡 *{site}* отвечает медленно: {ms} мс. |
| `uptimeCause: (code, http) => string` | timeout · DNS error · SSL/TLS error · connection refused · HTTP {http} · expected text not found · redirect loop · address not allowed · error | таймаут · ошибка DNS · ошибка SSL/TLS · соединение отклонено · HTTP {http} · нет ожидаемого текста · цикл редиректов · адрес запрещён · ошибка |
| `indexLossTitle: (site) => string` | 📉 {site}: pages left Google's index | 📉 {site}: страницы выпали из индекса Google |
| `indexLossMsg: (site, n, lines) => string` | *{site}* — {n} page(s) with traffic are no longer indexed:\n{lines} | *{site}* — {n} стр. с трафиком больше не в индексе:\n{lines} |
| `mentionsNotifyTitle: (site) => string` | 📰 New mentions of {site} | 📰 Новые упоминания {site} |
| `mentionsNotifyMsg: (site, n, lines) => string` | *{site}* — {n} new mention(s):\n{lines} | *{site}* — новых упоминаний: {n}\n{lines} |
| `notifyTestMsg: (channel) => string` | ✅ OpenGSC test message via {channel}. | ✅ Тестовое сообщение OpenGSC через {channel}. |

`uptimeCause` — одна функция с `switch` по `UptimeCause`; в таблице значения перечислены в
порядке типа.
