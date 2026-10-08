import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPORT_PAGE_SIZE, type PageFetch, type PageQuery } from "./backlinksApi";
import {
  pageByKeyset, pageByOffset, settleCompleteness, type PagingDeps, type PagingState,
} from "./exportPaging";

// The all-backlinks export loops against gateways that cap, ignore or reject paging parameters.
// Same incident as refdomainsPaging.test.ts: a short page is not the end of the listing.

type Gw = { total: number; cap?: number; honorsOffset?: boolean; honorsWhere?: boolean; rejectWhere?: boolean };

const urlFrom = (i: number) => `https://donor${String(i).padStart(5, "0")}.example/page`;

function harness(g: Gw, live: number | null) {
  const rows = Array.from({ length: g.total }, (_, i) => ({ url_from: urlFrom(i), url_to: "https://t.example/", anchor: "a" }));
  const requests: PageQuery[] = [];
  const persisted: any[] = [];
  const state: PagingState = {
    rowsSeen: 0, pagesPulled: 0, unitsSpent: 0, complete: false, slicesUsed: false, slicesTruncated: false, notes: [],
  };
  const deps: PagingDeps = {
    target: "t.example", live, state,
    fetchPage: async (q): Promise<PageFetch> => {
      requests.push(q);
      let out = rows;
      if (q.afterUrlFrom !== undefined) {
        if (g.rejectWhere) return { rows: [], units: 0, status: 400, error: "ahrefs 400: where" };
        if (g.honorsWhere !== false) out = out.filter(r => r.url_from > q.afterUrlFrom!);
      } else if (q.seenFrom !== undefined || q.seenTo !== undefined) {
        out = []; // slice fallback is exercised only for "was it entered"
      } else if (g.honorsOffset !== false) {
        out = out.slice(q.offset ?? 0);
      }
      out = out.slice(0, Math.min(q.limit, g.cap ?? q.limit));
      return { rows: out, units: Math.max(50, out.length * 20) };
    },
    persistPage: async rs => {
      persisted.push(...rs);
      state.rowsSeen += rs.length;
      state.pagesPulled++;
    },
  };
  return { deps, state, requests, persisted };
}

test("offset, honest gateway: the short last page ends the run once the live count is reached", async () => {
  const h = harness({ total: 2500 }, 2500);
  assert.equal(await pageByOffset(h.deps), true);
  assert.equal(h.persisted.length, 2500);
  assert.equal(h.requests.length, 3, "no confirmation request after a short page that reaches the live count");
});

test("offset, gateway capping responses at 12: pages on by rows received, not by the limit", async () => {
  const h = harness({ total: 648, cap: 12 }, 648);
  assert.equal(await pageByOffset(h.deps), true);
  assert.equal(h.persisted.length, 648);
  assert.equal(new Set(h.persisted.map(r => r.url_from)).size, 648);
  assert.deepEqual(h.requests.slice(0, 3).map(r => r.offset), [0, 12, 24]);
});

test("offset, unknown live count: a short page is confirmed by an empty one", async () => {
  const h = harness({ total: 700 }, null);
  assert.equal(await pageByOffset(h.deps), true);
  assert.equal(h.persisted.length, 700);
  assert.equal(h.requests.length, 2);
});

test("offset ignored by the gateway: stops with an error instead of paging one window forever", async () => {
  const h = harness({ total: 648, cap: 12, honorsOffset: false }, 648);
  await assert.rejects(() => pageByOffset(h.deps), /offset did not advance/);
  assert.ok(h.requests.length <= 3);
});

test("a sample (12 rows, provider reports 648) finishes but is never complete", async () => {
  const h = harness({ total: 12, cap: 12 }, 648);
  h.state.complete = await pageByOffset(h.deps);
  assert.equal(h.state.complete, true, "the listing did end");
  settleCompleteness(h.state, 648);
  assert.equal(h.state.complete, false);
  assert.match(h.state.notes.join(" "), /12 rows.*648/);
});

test("settleCompleteness leaves an honest full export complete, and tolerates drift", () => {
  const ok = { rowsSeen: 640, complete: true, notes: [] as string[] } as PagingState;
  settleCompleteness(ok, 648);
  assert.equal(ok.complete, true);
  const unknown = { rowsSeen: 5, complete: true, notes: [] as string[] } as PagingState;
  settleCompleteness(unknown, null);
  assert.equal(unknown.complete, true);
  const lostIncluded = { rowsSeen: 900, complete: true, notes: [] as string[] } as PagingState;
  settleCompleteness(lostIncluded, 648); // all_time history returns lost links on top of live ones
  assert.equal(lostIncluded.complete, true);
});

test("keyset, gateway capping at 12: follows the cursor to the end", async () => {
  const h = harness({ total: 648, cap: 12 }, 648);
  assert.equal(await pageByKeyset(h.deps), true);
  assert.equal(h.persisted.length, 648);
  assert.equal(new Set(h.persisted.map(r => r.url_from)).size, 648);
});

test("keyset, honest gateway: short last page ends the run without a further request", async () => {
  const h = harness({ total: 1500 }, 1500);
  assert.equal(await pageByKeyset(h.deps), true);
  assert.equal(h.persisted.length, 1500);
  assert.equal(h.requests.length, 2);
});

test("keyset ignoring the where filter: errors out instead of looping", async () => {
  const h = harness({ total: 648, cap: 12, honorsWhere: false }, 648);
  await assert.rejects(() => pageByKeyset(h.deps), /cursor did not advance/);
  assert.ok(h.requests.length <= 3);
});

test("keyset cursor rejected with 400: falls back to slices and is never complete", async () => {
  const h = harness({ total: 648, cap: 12, rejectWhere: true }, 648);
  assert.equal(await pageByKeyset(h.deps), false);
  assert.equal(h.state.slicesUsed, true);
});

test("sanity: the page size the loops compare against is the documented one", () => {
  assert.equal(EXPORT_PAGE_SIZE, 1000);
});
