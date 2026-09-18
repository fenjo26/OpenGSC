# CONTRACT — drops activation wave

Literal models and signatures. T0 implements this file verbatim; T2–T6 consume it.
If reality disagrees with this file, the task stops and asks — it does not improvise
a parallel contract.

## As-built deviations (merged 2026-09-18, all seven tasks shipped)

- **7d crawl window is bounded, not half-open**: T6 specified
  `utcMidnightDaysBetween(now, lineTime) <= 7`, which lets *older* lines through with
  negative values; the implementation is `utcMidnightDaysBetween(lineTime, now) ∈ [0, 7]`.
- **GSC sitemap submit is a PUT** (Google's webmasters v3 `sitemaps.submit`), not the
  POST this contract sketched.
- **Wayback CDX gate is mirrored, not imported**: `cdxGate` is module-private in
  `wayback.ts` (outside T2's ownership), so `legacyUrls.ts` carries a self-contained
  mirror with the same discipline (1500 ms chained gate, same throttle statuses, same
  single spaced retry). Unify by exporting `cdxGate` if wayback.ts is ever touched.
- **GSC pages harvest** rides `queryGsc` (`src/lib/gscQuery.ts`, the `query_gsc_live`
  surface), `rowLimit` 25 000 / 480-day lookback; per-account errors are swallowed by
  that helper, so an unverified property harvests as "0 pages" rather than an error.
- **IndexNow statuses** additionally include `"network_error"` (a chunk whose fetch
  threw — the count stays cumulative) and the route answers `400 no_key` defensively
  for rows created outside `ensureAsset`.
- **Donor runner** resolves `assetId → domain` via `listAssets` (no by-id reader in
  the store) and reports empty results as machine codes (`no_donors`, `no_doorways`)
  for localized rendering.

## Models (T0 → `prisma/schema.prisma`, block after `DropEvent`)

```prisma
// ─── Drops — activation of acquired domains ─────────────────────────────────
// The funnel ends at `acquired`; these rows pick up there. See
// docs/tasks/drops-activation/CONTRACT.md and docs/DROPS-ACTIVATION.md.

/// One acquired domain being (re-)activated. `candidateId` is a plain string, not an
/// FK: activation must survive catalogue tidy-ups, and DropCandidate stays untouched.
model DropAsset {
  id             String   @id @default(cuid())
  userId         String
  domain         String
  candidateId    String?
  stage          String   @default("new")
  // new | harvesting | ready | live | paused

  gscSiteUrl          String?   // e.g. "sc-domain:example.gr" or "https://example.gr/"
  gscSitemapPath      String?   // e.g. "/sitemap.xml"
  gscSitemapSubmittedAt DateTime?

  sitemapUrl     String?   // where the sitemap is served on the asset host
  sitemapBuiltAt DateTime?

  indexnowKey        String?   // 32 hex chars, generated once at ensureAsset
  indexnowPushedAt   DateTime?
  indexnowCount      Int       @default(0)
  indexnowLastStatus String?   // "ok" | "202" | "422" | HTTP code as string

  lastGoogleHitAt DateTime?
  googleHits7d    Int      @default(0)

  note      String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  urls       DropLegacyUrl[]
  donors     DropDonor[]
  placements DropDonorPlacement[]

  @@unique([userId, domain])
  @@index([userId, stage])
}

/// One legacy URL of an asset, harvested from Wayback CDX and/or seen in GSC.
/// The sitemap is built from these rows.
model DropLegacyUrl {
  id        String   @id @default(cuid())
  assetId   String
  url       String
  source    String   @default("wayback") // wayback | gsc | manual
  inGsc     Boolean  @default(false)
  lastSeenAt DateTime?
  createdAt DateTime @default(now())

  asset DropAsset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@unique([assetId, url])
  @@index([assetId, inGsc])
}

/// A donor page — a third-party page that (already) links to the asset. Doorways
/// link to these; nothing ever links from a doorway to the asset itself.
model DropDonor {
  id        String   @id @default(cuid())
  assetId   String
  url       String
  createdAt DateTime @default(now())

  asset DropAsset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@unique([assetId, url])
}

/// One (doorway, donor) pair actually enqueued into the indexer network. The queue
/// row in `IndexerQueue` is the live injection; this row is the activation-view trail.
model DropDonorPlacement {
  id             String    @id @default(cuid())
  assetId        String
  doorway        String    // indexer network domain
  donorUrl       String
  placedAt       DateTime  @default(now())
  active         Boolean   @default(true)
  lastVerifiedAt DateTime?
  verifyOk       Boolean?

  asset DropAsset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@unique([assetId, doorway, donorUrl])
  @@index([assetId, active])
}
```

## Pure helpers (T0 → `src/lib/drops/activation.ts`)

```ts
export type ActivationStage = "new" | "harvesting" | "ready" | "live" | "paused";
export const ACTIVATION_STAGES: readonly ActivationStage[];

/// Doorway needs this many Google hits in the last DOORWAY_WINDOW_DAYS days to count
/// as "confirmed crawled". 1000/30d selects the three domains Google actually visits
/// today; a literal >0 would select 10 of 13, incl. domains with 4–7 touches/month.
export const GOOGLE_CRAWL_MIN_HITS = 1000;
export const DOORWAY_WINDOW_DAYS = 30;
/// IndexNow accepts up to 10 000 URLs per request.
export const INDEXNOW_BATCH = 10_000;

export function utcMidnightDaysBetween(a: Date, b: Date): number;
// Whole days between UTC midnights. The local-calendar version in wayback.ts:36-39
// drifted a day Athens-vs-UTC; this one must not repeat that.

export function normalizeLegacyUrl(raw: string, host: string): string | null;
// Uppercases scheme/host, strips fragment, keeps query. null when the URL is not
// http(s), not on `host` or its www twin, or malformed.

export function isDonorAllowed(assetDomain: string, donorUrl: string): boolean;
// false when donorUrl's registrable host equals the asset domain (www included).
// THE footprint rule: the network never links to the asset.

export function buildSitemapXml(urls: string[], opts?: { lastmod?: Date }): string;
export function buildRobotsTxt(sitemapUrl: string): string;
export function indexnowKeyFile(key: string): string; // just the key, body of /{key}.txt

export const NGINX_SNIPPET: string;
// Ordered locations for robots.txt / sitemap.xml / {key}.txt BEFORE the catch-all
// 301 — after it they redirect away and IndexNow rejects the key silently.
```

## Store (T0 → `src/lib/drops/activationStore.ts`)

```ts
import type { ActivationStage } from "./activation";

export interface AssetSummary {
  id: string; domain: string; stage: string; candidateId: string | null;
  urlsTotal: number; urlsWayback: number; urlsGsc: number;
  donors: number; placementsActive: number;
  sitemapBuiltAt: Date | null; sitemapUrl: string | null;
  indexnowPushedAt: Date | null; indexnowCount: number; indexnowLastStatus: string | null;
  gscSiteUrl: string | null; gscSitemapSubmittedAt: Date | null;
  lastGoogleHitAt: Date | null; googleHits7d: number;
  createdAt: Date;
}

/// Upsert by (userId, domain). Generates indexnowKey on first create. Never resets
/// progress fields on re-ensure.
export async function ensureAsset(
  userId: string, domain: string, opts?: { candidateId?: string | null },
): Promise<{ id: string; indexnowKey: string }>;

export async function listAssets(userId: string): Promise<AssetSummary[]>;
// counts via groupBy on DropLegacyUrl / DropDonor / DropDonorPlacement

export async function getAsset(userId: string, domain: string): Promise<{
  asset: { id: string; domain: string; stage: string; indexnowKey: string | null;
    gscSiteUrl: string | null; sitemapUrl: string | null; sitemapBuiltAt: Date | null;
    indexnowPushedAt: Date | null; indexnowCount: number; indexnowLastStatus: string | null;
    gscSitemapSubmittedAt: Date | null; lastGoogleHitAt: Date | null;
    googleHits7d: number; note: string | null; createdAt: Date };
  urls: { url: string; source: string; inGsc: boolean; lastSeenAt: Date | null }[];
  donors: { url: string }[];
  placements: { doorway: string; donorUrl: string; placedAt: Date; active: boolean }[];
} | null>;

export async function setAssetStage(userId: string, domain: string, stage: ActivationStage): Promise<void>;
export async function setAssetNote(userId: string, domain: string, note: string): Promise<void>;

/// Upsert by (assetId, url). markInGsc flips inGsc=true + lastSeenAt (a URL seen in
/// both sources keeps its first source). Returns rows added / updated.
export async function addLegacyUrls(
  userId: string, assetId: string,
  rows: { url: string; source: "wayback" | "gsc" | "manual" }[],
  opts?: { markInGsc?: boolean },
): Promise<{ added: number; updated: number }>;

export async function setSitemapBuilt(
  userId: string, assetId: string, p: { url: string; count: number },
): Promise<void>; // sets sitemapUrl, sitemapBuiltAt, stage→"ready" if it was "new"|"harvesting"

export async function setGscSite(userId: string, assetId: string, p: {
  siteUrl: string; sitemapPath: string;
}): Promise<void>; // sets gscSiteUrl, gscSitemapPath, gscSitemapSubmittedAt=now

export async function recordIndexnowPush(userId: string, assetId: string, p: {
  count: number; status: string;
}): Promise<void>; // indexnowCount += count (cumulative), pushedAt=now, lastStatus

/// Replace-all donor list for the asset. Rejects (throws) on any URL failing
/// isDonorAllowed — no partial writes.
export async function setDonors(
  userId: string, assetId: string, urls: string[],
): Promise<{ added: number; removed: number }>;

/// Doorways with confirmed Google crawl, computed fresh from IndexerDailyStat each
/// call. Never a stored list — it rots.
export async function eligibleDoorways(userId: string, opts?: {
  days?: number; minGoogleHits?: number;
}): Promise<{ domainId: string; domain: string; googleHits: number }[]>;

/// Upsert placements by (assetId, doorway, donorUrl), reactivate inactive ones, and
/// enqueue the donor URLs into that doorway's IndexerQueue (upsert, so re-runs are
/// idempotent). Re-checks isDonorAllowed before writing — throws on violation.
export async function addPlacements(
  userId: string, assetId: string, doorwayDomain: string, donorUrls: string[],
): Promise<{ added: number }>;

export async function recordCrawlLog(userId: string, assetId: string, p: {
  lastGoogleHitAt: Date | null; googleHits7d: number;
}): Promise<void>;
```

## API surface (T2–T4, routes under `src/app/api/drops/activation/[domain]/`)

All routes: `workspaceUserId("act")` auth, `{ domain }` resolves via `getAsset`;
404 `{ error: "asset_not_found" }` when absent (except harvest, which `ensureAsset`-creates).

- `POST …/harvest` `{ source: "wayback" | "gsc" | "all", gscSiteUrl?: string }` (T2)
- `GET  …/bundle` → `{ sitemapXml, robotsTxt, keyFile, nginxSnippet, sitemapUrl }` (T2)
- `POST …/gsc-submit` `{ siteUrl: string, sitemapPath?: string }` → GSC sitemaps.submit via user OAuth; records via `setGscSite` (T2)
- `POST …/indexnow` `{ limit?: number }` → pushes legacy URLs in INDEXNOW_BATCH chunks (T3)
- `PUT  …/donors` `{ urls: string[] }` → `setDonors` (T4)
- `POST …/run-donors` `{ minGoogleHits?: number, days?: number }` → doorways from `eligibleDoorways`, `addPlacements` per doorway; response lists doorways used + hits (T4)
- `POST …/crawl-log` `{ log: string }` → `crawlLog.ts` parse → `recordCrawlLog` (T6)

## Behaviours pinned across the wave

1. **Counter honesty (T1).** `recordAvailabilityResults` returns rows *written*, not
   verdicts received — see T1 for the acceptance numbers.
2. **Idempotency.** Every route above is safe to re-run: upserts everywhere, no
   duplicate placements, no duplicate queue rows (`IndexerQueue @@unique([domainId, url])`).
3. **No cross-task imports of internals.** Tail tasks import from `activation.ts`,
   `activationStore.ts`, and existing libs (`wayback.ts`, `watch.ts` patterns). They do
   not re-implement CDX fetching, throttling, or the i18n hook.
4. **i18n.** Every user-visible string from T5 lands in all locale files with manual
   `{host}`-style substitution (no `t()` interpolation — house rule). Keys prefixed
   `drops_activation_`.
5. **Check gates.** `npx tsc -p tsconfig.check.json` clean, `npm run test:unit` green,
   new test files registered in `package.json`.
