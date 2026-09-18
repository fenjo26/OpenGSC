// Donor accelerator — the composition layer of the activation wave. The indexer network
// links to DONOR pages (third-party pages that already link to the asset) so Google
// re-crawls them and re-discovers their links to the drop. It never links to the asset
// itself: that «дорвей → наш домен» edge is the footprint this whole wave exists to avoid.
// Spec: docs/tasks/drops-activation/T4-donor-accelerator.md.
//
// This module composes; the store (activationStore.ts) validates and writes. The footprint
// rule is enforced at THREE layers on purpose: setDonors validates the list, addPlacements
// re-validates before every write, and runDonors re-validates the STORED donors before it
// composes anything — a row that slipped past the first two (a manual db edit, a schema
// migration) must not reach the queue.

import { DOORWAY_WINDOW_DAYS, GOOGLE_CRAWL_MIN_HITS, isDonorAllowed } from "./activation";
import { addPlacements, eligibleDoorways, getAsset, listAssets } from "./activationStore";

/** A doorway already confirmed crawled by Google, as eligibleDoorways returns it. */
export interface EligibleDoorway {
  domainId: string;
  domain: string;
  googleHits: number;
}

/** What runDonors will inject into one doorway: the doorway plus every donor URL it gets. */
export interface DonorRunPlanEntry {
  domain: string;
  googleHits: number;
  urls: string[];
}

/** Why a run composed nothing. Machine codes — the panel (T5) renders the prose, localized. */
export type DonorRunHint =
  | { code: "no_donors" }
  | { code: "no_doorways"; minGoogleHits: number; days: number };

export interface DonorRunResult {
  doorways: { domain: string; googleHits: number }[];
  /** Donor URLs pushed into doorway queues this run (upsert — re-runs re-push the same rows). */
  urlsEnqueued: number;
  /** DropDonorPlacement rows newly created this run (reactivated rows are not re-counted). */
  placements: number;
  /** Doorways skipped mid-run — always 0 today; the field pins the shape for when it isn't. */
  skipped: number;
  hint: DonorRunHint | null;
}

/**
 * Compose the per-doorway url lists. Pure: threshold filtering is eligibleDoorways' job, so
 * this takes the doorway list already filtered and only decides WHO gets WHAT — every doorway
 * gets every (deduplicated, trimmed, non-empty) donor URL. An empty donor list composes
 * nothing rather than N doorways × zero URLs: enqueueing no one into anything is a no-op the
 * caller should report as "add donors first", not as a successful run over zero pages.
 */
export function planDonorRun(
  donors: readonly string[],
  doorways: readonly { domain: string; googleHits: number }[],
): DonorRunPlanEntry[] {
  const urls = [...new Set(donors.map(u => u.trim()).filter(Boolean))];
  if (!urls.length) return [];
  return doorways.map(d => ({ domain: d.domain, googleHits: d.googleHits, urls }));
}

/**
 * Run the donor accelerator for one asset: stored donors × eligible doorways → placements +
 * IndexerQueue rows (the live injection the deployed doorway scripts already read).
 *
 * `minGoogleHits`/`days` default to GOOGLE_CRAWL_MIN_HITS/DOORWAY_WINDOW_DAYS. When no doorway
 * qualifies the result is empty WITH the threshold echoed back — lowering it is the operator's
 * call to make per run; this function never lowers it on its own.
 *
 * Throws `asset_not_found` and `donor_not_allowed` (Error with `.rejected: string[]`) upward
 * for the routes to map; see mapDonorError.
 */
export async function runDonors(
  userId: string,
  assetId: string,
  opts?: { minGoogleHits?: number; days?: number },
): Promise<DonorRunResult> {
  // The store reads assets by (userId, domain), not by id — resolve the id to its domain via
  // the summary list rather than reaching around activationStore into Prisma from here.
  const summary = (await listAssets(userId)).find(a => a.id === assetId);
  if (!summary) throw new Error("asset_not_found");
  const full = await getAsset(userId, summary.domain);
  if (!full) throw new Error("asset_not_found");

  // Defense in depth: the stored list was validated on write, but the write and this run can
  // be arbitrarily far apart. A donor that is no longer allowed must fail the WHOLE run
  // before any placement or queue row is written, exactly like setDonors would.
  const donorUrls = full.donors.map(d => d.url);
  const rejected = donorUrls.filter(u => !isDonorAllowed(full.asset.domain, u));
  if (rejected.length) throw donorNotAllowed(rejected);

  if (!donorUrls.length) {
    return { doorways: [], urlsEnqueued: 0, placements: 0, skipped: 0, hint: { code: "no_donors" } };
  }

  const minGoogleHits = opts?.minGoogleHits ?? GOOGLE_CRAWL_MIN_HITS;
  const days = opts?.days ?? DOORWAY_WINDOW_DAYS;
  // Annotated against our own copy of the store's row shape: if the store's return type ever
  // drifts from what this module composes, this line is where tsc says so.
  const doorways: EligibleDoorway[] = await eligibleDoorways(userId, { minGoogleHits, days });
  if (!doorways.length) {
    return {
      doorways: [], urlsEnqueued: 0, placements: 0, skipped: 0,
      hint: { code: "no_doorways", minGoogleHits, days },
    };
  }

  const plan = planDonorRun(donorUrls, doorways);
  const used: { domain: string; googleHits: number }[] = [];
  let urlsEnqueued = 0;
  let placements = 0;
  for (const entry of plan) {
    const { added } = await addPlacements(userId, assetId, entry.domain, entry.urls);
    placements += added;
    urlsEnqueued += entry.urls.length;
    used.push({ domain: entry.domain, googleHits: entry.googleHits });
  }
  return { doorways: used, urlsEnqueued, placements, skipped: 0, hint: null };
}

export interface MappedDonorError {
  status: number;
  body: { error: string; rejected?: string[] };
}

/**
 * Map the module's thrown errors to a route response shape, or null when the error is not
 * ours. Pure (no Next imports) so the mapping is testable without a server: the routes just
 * wrap it in NextResponse.json. The donor_not_allowed body carries the rejected list — the
 * panel must render the rule that was broken, not a generic 400.
 */
export function mapDonorError(e: unknown): MappedDonorError | null {
  const err = e as { message?: string; rejected?: string[] } | undefined;
  const message = String(err?.message ?? "");
  if (message === "donor_not_allowed") {
    return {
      status: 400,
      body: {
        error: "donor_not_allowed",
        rejected: Array.isArray(err?.rejected) ? err.rejected : [],
      },
    };
  }
  if (message === "asset_not_found") return { status: 404, body: { error: "asset_not_found" } };
  // A doorway that vanished between eligibleDoorways and addPlacements (deactivated mid-run).
  // Not retryable as-is; the next run recomputes the list fresh.
  if (message === "doorway_not_found") return { status: 404, body: { error: "doorway_not_found" } };
  return null;
}

function donorNotAllowed(rejected: string[]): Error & { rejected: string[] } {
  const err = new Error("donor_not_allowed") as Error & { rejected: string[] };
  err.rejected = rejected;
  return err;
}
