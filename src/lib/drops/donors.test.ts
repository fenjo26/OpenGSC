import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// donors.ts statically imports the store (→ @/lib/prisma), so DATABASE_URL must point at a
// scratch file before it loads — the same trick prisma.test.ts and availability.test.ts use.
// Only the pure helpers are exercised here; the db paths are covered by the store's own
// guarantees (setDonors/addPlacements validate before writing) plus runDonors' re-check.
type DonorsModule = typeof import("./donors");
let donors!: DonorsModule;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "opengsc-donors-"));
  process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;
  donors = await import("./donors");
});

// ── planDonorRun — composition ────────────────────────────────────────────────
// Threshold filtering is eligibleDoorways' job; these tests pass the doorway list already
// filtered, the way runDonors does.

test("every doorway gets every donor URL (N doorways × M donors)", () => {
  const doorways = [
    { domain: "deadp47.shop", googleHits: 47_694 },
    { domain: "carcolor.shop", googleHits: 31_135 },
    { domain: "juliet.autos", googleHits: 27_698 },
  ];
  const urls = [
    "https://blog.other.gr/post-1",
    "https://news.example.org/article",
    "https://forum.third.party/thread",
  ];
  const plan = donors.planDonorRun(urls, doorways);
  assert.equal(plan.length, 3);
  for (const entry of plan) {
    assert.deepEqual(entry.urls, urls);
  }
  assert.deepEqual(
    plan.map(p => p.domain),
    ["deadp47.shop", "carcolor.shop", "juliet.autos"],
  );
  assert.deepEqual(plan.map(p => p.googleHits), [47_694, 31_135, 27_698]);
});

test("donors are trimmed, empties dropped and duplicates collapsed", () => {
  const plan = donors.planDonorRun(
    ["  https://a.example/p  ", "", "https://a.example/p", "https://b.example/q"],
    [{ domain: "d.shop", googleHits: 1000 }],
  );
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].urls, ["https://a.example/p", "https://b.example/q"]);
});

test("an empty donor list composes nothing — the early return, not zero-url runs", () => {
  assert.deepEqual(donors.planDonorRun([], [{ domain: "d.shop", googleHits: 47_694 }]), []);
  assert.deepEqual(donors.planDonorRun(["  ", ""], [{ domain: "d.shop", googleHits: 47_694 }]), []);
});

test("no doorways means no plan, even with donors", () => {
  assert.deepEqual(donors.planDonorRun(["https://a.example/p"], []), []);
});

// ── mapDonorError — route-level mapping, pure ────────────────────────────────

test("donor_not_allowed maps to 400 carrying the rejected list", () => {
  const err = new Error("donor_not_allowed") as Error & { rejected?: string[] };
  err.rejected = ["https://example.gr/self", "https://www.example.gr/also-self"];
  const mapped = donors.mapDonorError(err);
  assert.deepEqual(mapped, {
    status: 400,
    body: {
      error: "donor_not_allowed",
      rejected: ["https://example.gr/self", "https://www.example.gr/also-self"],
    },
  });
});

test("donor_not_allowed without a rejected list still maps (empty list, not a crash)", () => {
  const mapped = donors.mapDonorError(new Error("donor_not_allowed"));
  assert.equal(mapped?.status, 400);
  assert.deepEqual(mapped?.body.rejected, []);
});

test("asset and doorway misses map to 404; anything else is not ours (null)", () => {
  assert.deepEqual(donors.mapDonorError(new Error("asset_not_found")), {
    status: 404,
    body: { error: "asset_not_found" },
  });
  assert.deepEqual(donors.mapDonorError(new Error("doorway_not_found")), {
    status: 404,
    body: { error: "doorway_not_found" },
  });
  assert.equal(donors.mapDonorError(new Error("P2021: table does not exist")), null);
  assert.equal(donors.mapDonorError(new Error("boom")), null);
  assert.equal(donors.mapDonorError(undefined), null);
  assert.equal(donors.mapDonorError("string error"), null);
});
