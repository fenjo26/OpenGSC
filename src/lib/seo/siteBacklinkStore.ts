// Persistence and orchestration for the full Ahrefs backlink export (docs/tasks/T3-ahrefs-export.md).
//
// Two jobs live here. `upsertFromApi` writes one fetched page into SiteBacklink/SiteBacklinkEvent
// under the write rule of CONTRACT.md §1: the API writer names ONLY the api* group plus domainFrom
// and sources — a blanket spread would erase the check* results the placement checker (T4) and the
// operator's favourites, notes and prices (T5) keep in the same row.
//
// `runBacklinkExport` is the fire-and-forget body behind POST /api/backlinks/sync: probe the
// gateway's pagination dialect, page through the whole profile, persist each page, and keep the
// SiteBacklinkSync row honest (heartbeat, progress, units actually billed).
//
// The Prisma models are reached through `(prisma as any)`, the same way the audit crawler reaches
// SiteAudit: the models arrive with the T0 migration and the generated client may lag the schema
// on a checkout that has the code but not the migration. Typed access would turn that lag into a
// build break; the cast makes the module compile before and after the client catches up.

import { prisma } from "@/lib/prisma";
import { MetricsCreds, fetchKeyssoBacklinksPage } from "@/lib/seo/metrics";
import { releaseUnusedUnits } from "@/lib/seo/metricsStore";
import {
  MappedBacklinkRow, PaginationMode, ExistingApiState,
  mapApiRow, planEvents, probePagination, fetchBacklinksPage,
} from "@/lib/seo/backlinksApi";
import { pageByKeyset, pageByOffset, settleCompleteness, type PagingDeps } from "@/lib/seo/exportPaging";

const db = prisma as any;

// ─── Page persistence ──────────────────────────────────────────────────────────

export interface UpsertResult {
  written: number;
  events: number;
}

/**
 * Writes one page of raw all-backlinks rows.
 *
 * The row key is (siteId, urlFromNorm, urlTo): urlFrom stays exactly as it arrived so the
 * contractor's table keeps joining, urlFromNorm is the normalized dedup twin. Losses are taken
 * from the row's is_lost (mapped to apiLost) — never inferred from absence, which only a
 * complete pull would justify and which the provider answers directly anyway.
 */
export async function upsertFromApi(
  siteId: string, rawRows: any[], opts: { fetchedAt: Date },
): Promise<UpsertResult> {
  const mapped = rawRows.map(mapApiRow).filter(Boolean) as MappedBacklinkRow[];
  if (!mapped.length) return { written: 0, events: 0 };

  // The api* "before" state needed for event planning, read in one query per page. Keyed by the
  // full unique key — urlFromNorm alone is not the identity (one donor page can link to several
  // of our pages, and each pair is its own row).
  const norms = [...new Set(mapped.map(r => r.urlFromNorm))];
  let existingRows: any[] = [];
  try {
    existingRows = await db.siteBacklink.findMany({
      where: { siteId, urlFromNorm: { in: norms } },
      select: {
        id: true, urlFromNorm: true, urlTo: true, sources: true,
        apiLost: true, apiAnchor: true,
        apiDofollow: true, apiNofollow: true, apiSponsored: true, apiUgc: true,
      },
    });
  } catch {
    existingRows = []; // best effort, like every writer in the metrics layer
  }
  const key = (norm: string, to: string) => `${norm}\u0000${to}`;
  const byKey = new Map(existingRows.map((r: any) => [key(r.urlFromNorm, r.urlTo), r]));

  const eventRows: any[] = [];
  let written = 0;

  for (const row of mapped) {
    const k = key(row.urlFromNorm, row.urlTo);
    const ex: any | undefined = byKey.get(k);
    const before: ExistingApiState | null = ex
      ? {
          apiLost: !!ex.apiLost,
          apiAnchor: String(ex.apiAnchor ?? ""),
          apiDofollow: !!ex.apiDofollow,
          apiNofollow: !!ex.apiNofollow,
          apiSponsored: !!ex.apiSponsored,
          apiUgc: !!ex.apiUgc,
        }
      : null;
    const planned = planEvents(before, row);

    const apiData = {
      apiSeen: row.apiSeen,
      apiLost: row.apiLost,
      apiLostReason: row.apiLostReason,
      apiAnchor: row.apiAnchor,
      apiAlt: row.apiAlt,
      apiDofollow: row.apiDofollow,
      apiNofollow: row.apiNofollow,
      apiSponsored: row.apiSponsored,
      apiUgc: row.apiUgc,
      apiContent: row.apiContent,
      apiImage: row.apiImage,
      apiJsCrawl: row.apiJsCrawl,
      apiDr: row.apiDr,
      apiHttpCode: row.apiHttpCode,
      apiLinkType: row.apiLinkType,
      apiSnippet: row.apiSnippet,
      apiFirstSeen: row.apiFirstSeen,
      apiLastSeen: row.apiLastSeen,
      apiFetchedAt: opts.fetchedAt,
    };

    try {
      const saved = await db.siteBacklink.upsert({
        where: { siteId_urlFromNorm_urlTo: { siteId, urlFromNorm: row.urlFromNorm, urlTo: row.urlTo } },
        create: {
          siteId,
          urlFrom: row.urlFrom,
          urlFromNorm: row.urlFromNorm,
          urlTo: row.urlTo,
          domainFrom: row.domainFrom,
          ...apiData,
          source: "api",
          sources: "api",
        },
        // The update names ONLY the api group + domainFrom + sources. urlFrom is left as first
        // stored (the import's spelling is the one the client's table joins against), and
        // check*/page*/favorite/note/priceNote belong to other writers, not this one.
        update: {
          ...apiData,
          domainFrom: row.domainFrom,
          sources: mergeSources(ex?.sources),
        },
      });
      written++;
      if (planned.length) {
        eventRows.push(...planned.map(p => ({
          siteId, backlinkId: saved.id, kind: p.kind, detail: p.detail ?? "", origin: "api",
        })));
      }
      // The in-memory "before" becomes the row just written, so a duplicate key inside the same
      // page (aggregation=all can return one url_from twice — two links, same target) plans no
      // second appeared event.
      byKey.set(k, {
        id: saved.id, sources: mergeSources(ex?.sources),
        apiLost: row.apiLost, apiAnchor: row.apiAnchor,
        apiDofollow: row.apiDofollow, apiNofollow: row.apiNofollow,
        apiSponsored: row.apiSponsored, apiUgc: row.apiUgc,
      });
    } catch { /* best effort per row */ }
  }

  if (eventRows.length) {
    try { await db.siteBacklinkEvent.createMany({ data: eventRows }); } catch { /* best effort */ }
  }
  return { written, events: eventRows.length };
}

/** `"csv"` stays, `"api"` is ensured — the row is now known to both worlds. */
function mergeSources(existing?: string | null): string {
  const parts = String(existing ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.includes("api")) parts.push("api");
  return parts.join(",");
}

// ─── Sync-run bookkeeping ──────────────────────────────────────────────────────

/** A running sync whose heartbeat is fresh enough that a process may still be behind it. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

export async function createApiSync(siteId: string, paginationMode: string): Promise<any> {
  return db.siteBacklinkSync.create({
    data: { siteId, kind: "api", status: "running", stage: "pull", paginationMode, heartbeatAt: new Date() },
  });
}

/**
 * The one live run per site, after cleanup. Crash remnants — status "running" with a heartbeat
 * older than the stale window — are marked failed, not restarted: a restart would re-spend the
 * owner's units without a fresh price confirmation. The user starts a new run instead.
 */
export async function runningApiSync(siteId: string): Promise<any | null> {
  let rows: any[] = [];
  try {
    rows = await db.siteBacklinkSync.findMany({
      where: { siteId, kind: "api", status: "running" },
      orderBy: { startedAt: "desc" },
    });
  } catch { return null; }
  const now = Date.now();
  for (const r of rows) {
    const beat = r.heartbeatAt ? new Date(r.heartbeatAt).getTime() : new Date(r.startedAt).getTime();
    if (now - beat <= STALE_RUNNING_MS) return r;
    await db.siteBacklinkSync.update({
      where: { id: r.id },
      data: { status: "error", stage: "error", complete: false, error: "aborted: heartbeat stopped", finishedAt: new Date() },
    }).catch(() => {});
  }
  return null;
}

export async function heartbeatApiSync(id: string, patch: Record<string, unknown>): Promise<void> {
  await db.siteBacklinkSync.update({ where: { id }, data: { ...patch, heartbeatAt: new Date() } }).catch(() => {});
}

async function finishApiSync(id: string, patch: Record<string, unknown>): Promise<void> {
  await db.siteBacklinkSync.update({ where: { id }, data: { ...patch, finishedAt: new Date() } }).catch(() => {});
}

export async function listApiSyncs(siteId: string, take = 10): Promise<any[]> {
  try {
    const rows = await db.siteBacklinkSync.findMany({
      where: { siteId, kind: "api" },
      orderBy: { startedAt: "desc" },
      take,
    });
    return rows.map((r: any) => ({ ...r, summary: tryParse(r.summary) }));
  } catch { return []; }
}

const tryParse = (s: unknown): any => {
  if (!s) return null;
  try { return JSON.parse(String(s)); } catch { return null; }
};

// ─── The export run itself ─────────────────────────────────────────────────────

export interface ExportRunOpts {
  syncId: string;
  siteId: string;
  userId: string;
  target: string;
  creds: MetricsCreds;
  /** live backlink count from backlinks-stats — the progress denominator. */
  live: number | null;
  /** Units reserved against the monthly cap when the route accepted the run. */
  reservedUnits: number;
  /** Probe answer the route already had (per-host cache); null = the run probes itself. */
  mode?: PaginationMode | null;
}

export interface ExportSummary {
  rowsSeen: number;
  pagesPulled: number;
  unitsSpent: number;
  complete: boolean;
  paginationMode: string;
  /** true when the url_from cursor was rejected and monthly first_seen slices were used. */
  slicesUsed: boolean;
  /** true when a slice hit the page cap — within-slice truncation is then possible. */
  slicesTruncated: boolean;
  notes: string[];
}

/**
 * Pages through the whole profile and persists it. Runs detached from the request (the pattern
 * of /api/audit): the promise keeps the process alive after the response is sent.
 *
 * `complete = true` only when the loop reached the end of an unfiltered listing without an
 * error — CONTRACT.md §4. A slice run is never complete: it cannot page within a month and
 * cannot see links first seen before the window, so it may add rows but may never prove a loss.
 */
export async function runBacklinkExport(opts: ExportRunOpts): Promise<void> {
  const { syncId, siteId, userId, target, creds } = opts;
  const state: ExportSummary = {
    rowsSeen: 0, pagesPulled: 0, unitsSpent: 0, complete: false,
    paginationMode: "", slicesUsed: false, slicesTruncated: false, notes: [],
  };

  try {
    let mode: PaginationMode | null = opts.mode ?? null;
    if (!mode) {
      const probe = await probePagination(creds, target);
      state.unitsSpent += probe.units;
      if (!probe.mode) throw new Error(probe.error ?? "probe_failed");
      mode = probe.mode;
      state.paginationMode = mode;
      await heartbeatApiSync(syncId, { paginationMode: mode, unitsSpent: state.unitsSpent });
    } else {
      state.paginationMode = mode;
    }

    // Progress is measured against the live count the route already paid for. Unknown live →
    // the run reports pages and rows without a percentage rather than inventing one.
    const persistPage = async (rows: any[]) => {
      await heartbeatApiSync(syncId, { stage: "pull", unitsSpent: state.unitsSpent });
      await upsertFromApi(siteId, rows, { fetchedAt: new Date() });
      state.rowsSeen += rows.length;
      state.pagesPulled++;
      const progress = opts.live && opts.live > 0
        ? Math.min(99, Math.floor((state.rowsSeen / opts.live) * 100))
        : 0;
      await heartbeatApiSync(syncId, {
        stage: "persist", progress, rowsSeen: state.rowsSeen,
        pagesPulled: state.pagesPulled, unitsSpent: state.unitsSpent,
      });
    };

    // The loops themselves live in exportPaging.ts (no database, so a fake gateway can drive
    // them in a test). The end of a listing is an empty page, never a short one.
    const deps: PagingDeps = {
      target, live: opts.live, state,
      fetchPage: q => fetchBacklinksPage(creds, q),
      persistPage,
    };
    state.complete = mode === "offset" ? await pageByOffset(deps) : await pageByKeyset(deps);
    settleCompleteness(state, opts.live);

    await finishApiSync(syncId, {
      status: "completed", stage: "completed", progress: 100, complete: state.complete,
      rowsSeen: state.rowsSeen, pagesPulled: state.pagesPulled, unitsSpent: state.unitsSpent,
      summary: JSON.stringify(state), error: null,
    });
  } catch (e: any) {
    state.notes.push(String(e?.message ?? e));
    await finishApiSync(syncId, {
      status: "error", stage: "error", complete: false,
      rowsSeen: state.rowsSeen, pagesPulled: state.pagesPulled, unitsSpent: state.unitsSpent,
      summary: JSON.stringify(state),
      error: String(e?.message ?? e).slice(0, 500),
    });
  } finally {
    // Failed pages bill nothing at the gateway, so the reservation shrinks to what actually
    // succeeded — same reconciliation as /api/metrics/gap. Crashing between the last page and
    // this refund can only over-reserve, never over-spend.
    await releaseUnusedUnits(userId, "ahrefs", opts.reservedUnits, state.unitsSpent);
  }
}
// ─── Keys.so export ──────────────────────────────────────────────────────────

/** Hard stop for one Keys.so run: 20 000 pages × 100 links. Far past a normal profile, short of a loop. */
const KEYSSO_MAX_EXPORT_PAGES = 20000;

/**
 * The same export, sourced from Keys.so's Runet link index — what gives the toxicity, disavow
 * and recovery tabs real anchors for a site Ahrefs barely sees. Rows arrive already restated in
 * the all-backlinks shape (`keyssoBacklinkToExportRow`), so `upsertFromApi` is shared unchanged.
 *
 * Paging is plain `page`/`per_page`, ended by the envelope's `last_page` — no dialect probe.
 * One credit per page, metered on `keysso`. The gateway serves live links only (status=1), so
 * a complete run still never infers a loss from absence: `upsertFromApi` never does.
 */
export async function runKeyssoBacklinkExport(opts: ExportRunOpts): Promise<void> {
  const { syncId, siteId, userId, target, creds } = opts;
  const state: ExportSummary = {
    rowsSeen: 0, pagesPulled: 0, unitsSpent: 0, complete: false,
    paginationMode: "keysso_page", slicesUsed: false, slicesTruncated: false, notes: [],
  };
  try {
    for (let page = 1; page <= KEYSSO_MAX_EXPORT_PAGES; page++) {
      await heartbeatApiSync(syncId, { stage: "pull", unitsSpent: state.unitsSpent });
      const res = await fetchKeyssoBacklinksPage(creds, target, page);
      if (res.error) throw new Error(res.error);
      state.unitsSpent += res.units;
      if (!res.rows.length) { state.complete = true; break; }
      await upsertFromApi(siteId, res.rows, { fetchedAt: new Date() });
      state.rowsSeen += res.rows.length;
      state.pagesPulled++;
      const progress = opts.live && opts.live > 0
        ? Math.min(99, Math.floor((state.rowsSeen / opts.live) * 100))
        : 0;
      await heartbeatApiSync(syncId, {
        stage: "persist", progress, rowsSeen: state.rowsSeen,
        pagesPulled: state.pagesPulled, unitsSpent: state.unitsSpent,
      });
      if (res.lastPage != null && page >= res.lastPage) { state.complete = true; break; }
    }
    await finishApiSync(syncId, {
      status: "completed", stage: "completed", progress: 100, complete: state.complete,
      rowsSeen: state.rowsSeen, pagesPulled: state.pagesPulled, unitsSpent: state.unitsSpent,
      summary: JSON.stringify(state), error: null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    state.notes.push(message);
    await finishApiSync(syncId, {
      status: "error", stage: "error", complete: false,
      rowsSeen: state.rowsSeen, pagesPulled: state.pagesPulled, unitsSpent: state.unitsSpent,
      summary: JSON.stringify(state),
      error: message.slice(0, 500),
    });
  } finally {
    await releaseUnusedUnits(userId, "keysso", opts.reservedUnits, state.unitsSpent);
  }
}
