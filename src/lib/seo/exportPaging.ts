// The paging loops of the full backlink export, apart from the database.
//
// They live here, not in siteBacklinkStore.ts, so they can be driven by a fake gateway in a unit
// test: the store imports Prisma, and the lesson of this file is that these loops must be proven
// against gateways that misbehave.
//
// THE RULE: the end of a listing is an EMPTY page. A page shorter than the limit asked for is not
// the end — a gateway can answer with fewer rows than requested (a cap, or partial upstream data;
// a user's profile refresh once ended with 12 rows of 648), and reading that as "done" yields a
// "complete" export of a stub. The only shortcut is a short page that brings the run up to the
// provider's own live count, where one more request would prove nothing the count has not
// already shown.

import {
  EXPORT_PAGE_SIZE, PageFetch, PageQuery, monthSlices,
} from "@/lib/seo/backlinksApi";
import { refdomainShortfall } from "@/lib/seo/metrics";

export interface PagingState {
  rowsSeen: number;
  pagesPulled: number;
  unitsSpent: number;
  complete: boolean;
  /** true when the url_from cursor was rejected and monthly first_seen slices were used. */
  slicesUsed: boolean;
  /** true when a slice hit the page cap — within-slice truncation is then possible. */
  slicesTruncated: boolean;
  notes: string[];
}

export interface PagingDeps {
  target: string;
  /** live backlink count from backlinks-stats, when the provider answered it. */
  live: number | null;
  state: PagingState;
  fetchPage: (q: PageQuery) => Promise<PageFetch>;
  /** Persists one page and advances state.rowsSeen / pagesPulled. */
  persistPage: (rows: any[]) => Promise<void>;
}

/** A short page ends the run only when the run has caught up with the provider's own count. */
function caughtUp(state: PagingState, live: number | null): boolean {
  return live != null && live > 0 && state.rowsSeen >= live;
}

const keyOf = (r: any) => `${r?.url_from ?? ""}\u0001${r?.url_to ?? ""}`;
/** First and last row of a page — two identical edges in a row mean the gateway served the same page. */
const edgeOf = (rows: any[]) => `${keyOf(rows[0])}\u0002${keyOf(rows[rows.length - 1])}`;

/** offset paging. Steps by the rows actually received, never by the limit that was asked for. */
export async function pageByOffset(d: PagingDeps): Promise<boolean> {
  const { target, live, state } = d;
  let offset = 0;
  let prevEdge = "";
  for (;;) {
    const page = await d.fetchPage({ target, limit: EXPORT_PAGE_SIZE, offset });
    if (page.error) throw new Error(page.error);
    state.unitsSpent += page.units;
    if (!page.rows.length) return true;
    // An honoured offset never revisits a row. The same first and last row twice means the
    // gateway stopped honouring it — carry on and the loop would page one window forever.
    const edge = edgeOf(page.rows);
    if (edge === prevEdge) throw new Error("offset did not advance — gateway ignored the offset");
    prevEdge = edge;
    await d.persistPage(page.rows);
    if (page.rows.length < EXPORT_PAGE_SIZE && caughtUp(state, live)) return true;
    offset += page.rows.length;
  }
}

/** keyset paging on url_from; falls back to monthly first_seen slices when the cursor is rejected. */
export async function pageByKeyset(d: PagingDeps): Promise<boolean> {
  const { target, live, state } = d;
  let cursor: string | undefined;
  for (;;) {
    const page = await d.fetchPage({ target, limit: EXPORT_PAGE_SIZE, afterUrlFrom: cursor });
    // A 400 on a cursor page (and only there) means the gateway refuses `where` on url_from —
    // not a malformed select, which would 400 on the very first page too.
    if (page.status === 400 && cursor !== undefined) {
      state.notes.push("url_from cursor rejected by gateway; falling back to monthly first_seen slices");
      return pageBySlices(d);
    }
    if (page.error) throw new Error(page.error);
    state.unitsSpent += page.units;
    if (!page.rows.length) return true;
    await d.persistPage(page.rows);
    if (page.rows.length < EXPORT_PAGE_SIZE && caughtUp(state, live)) return true;
    // Ascending order: the last row of the page carries the largest url_from. A cursor that
    // does not advance means the gateway ignored the `where` and served the same head again —
    // without this check the loop would page the first rows forever. Not a row ceiling:
    // the run ends incomplete, with the reason in `error`.
    const next = page.rows[page.rows.length - 1]?.url_from;
    if (!next || String(next) === cursor) {
      throw new Error(cursor ? "keyset cursor did not advance — gateway ignored the where filter" : "keyset page without url_from — cannot continue");
    }
    cursor = String(next);
  }
}

/**
 * The lossy fallback: monthly first_seen_link windows. Never complete — links older than the
 * lookback are invisible to it, and a month with more links than one page cannot be paged
 * (that is the very limitation that forced this fallback).
 */
export async function pageBySlices(d: PagingDeps): Promise<boolean> {
  const { target, state } = d;
  state.slicesUsed = true;
  for (const s of monthSlices(new Date())) {
    const page = await d.fetchPage({
      target, limit: EXPORT_PAGE_SIZE, seenFrom: s.from, seenTo: s.to,
    });
    if (page.error) throw new Error(page.error);
    state.unitsSpent += page.units;
    if (!page.rows.length) continue;
    await d.persistPage(page.rows);
    if (page.rows.length >= EXPORT_PAGE_SIZE) state.slicesTruncated = true;
  }
  state.notes.push("slice fallback used: losses cannot be concluded from this run");
  return false;
}

/**
 * A run that reached an end but holds far fewer rows than the provider says exist is a sample.
 * Its rows are kept (they are real); it is just not called complete. Same tolerance as the
 * referring-domains pull, and only ever downgrades.
 */
export function settleCompleteness(state: PagingState, live: number | null): void {
  if (!state.complete) return;
  const short = refdomainShortfall(state.rowsSeen, live);
  if (!short) return;
  state.complete = false;
  state.notes.push(
    `export ended at ${short.pulled} rows but the provider reports ≈${short.total} live links — ` +
    `treated as a sample, not a complete export`,
  );
}
