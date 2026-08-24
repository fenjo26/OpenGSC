import assert from "node:assert/strict";
import test from "node:test";
// Type-only: the shapes come from T0's backlinkTypes (CONTRACT.md §2), which does not exist
// on this branch yet. tsx erases the import, so these tests run pre-merge.
import type { PlacementHit } from "@/lib/seo/backlinkTypes";
import {
  absolutizeUrl,
  buildCheckUpdate,
  classifyFailedFetch,
  classifyOpenPage,
  diffCheckEvents,
  finishSummary,
  groupByHost,
  hostOf,
  isTlsCertFailure,
  newSummary,
  pickBestHit,
  tallyRow,
  urlsEquivalent,
  type CheckSnapshot,
  type RowCheckResult,
} from "./placementRunner";

// ─── fixtures ──────────────────────────────────────────────────────────────────

const dofollowRel = { raw: "", nofollow: false, sponsored: false, ugc: false, dofollow: true };
const nofollowRel = { raw: "nofollow", nofollow: true, sponsored: false, ugc: false, dofollow: false };

const hit = (over: Partial<PlacementHit> = {}): PlacementHit => ({
  sourceUrl: "https://donor.example/page",
  finalUrl: "https://donor.example/page",
  matchedDomain: "mysite.com",
  linkUrl: "https://mysite.com/landing",
  anchor: "our anchor",
  isImage: false,
  rel: dofollowRel,
  ...over,
});

const snap = (over: Partial<CheckSnapshot> = {}): CheckSnapshot => ({
  checkStatus: "found",
  checkAnchor: "our anchor",
  checkRel: "",
  checkNofollow: false,
  checkSponsored: false,
  checkUgc: false,
  ...over,
});

const checkResult = (over: Partial<RowCheckResult> = {}): RowCheckResult => ({
  checkStatus: "found",
  pageStatus: "alive",
  checkError: "",
  hit: null,
  targetOk: null,
  pageTitle: "",
  insecure: false,
  jsSuspect: false,
  ...over,
});

// ─── HTTP status → checkStatus/pageStatus (the table in docs/tasks/T4, задача 1) ─

test("opened page: link found vs not found vs non-HTML", () => {
  assert.deepEqual(classifyOpenPage(true, true), { checkStatus: "found", pageStatus: "alive", checkError: "" });
  assert.deepEqual(classifyOpenPage(false, true), { checkStatus: "missing", pageStatus: "alive", checkError: "" });
  assert.deepEqual(classifyOpenPage(false, false), { checkStatus: "error", pageStatus: "alive", checkError: "non_html" });
});

test("401/403/429 are blocked, not missing — the site refused us, the link verdict is unknown", () => {
  for (const status of [401, 403, 429]) {
    const out = classifyFailedFetch(status);
    assert.equal(out.checkStatus, "blocked", `HTTP ${status}`);
    assert.equal(out.pageStatus, "blocked", `HTTP ${status}`);
  }
});

test("403 NEVER produces missing — the false accusation this feature exists to prevent", () => {
  for (const status of [401, 403, 429, 408, 500, 503, 400, 0]) {
    assert.notEqual(classifyFailedFetch(status).checkStatus, "missing", `HTTP ${status} must not read as missing`);
  }
  // missing is reachable only through an opened HTML page or a verifiably dead page:
  assert.equal(classifyFailedFetch(404).checkStatus, "missing");
  assert.equal(classifyFailedFetch(410).checkStatus, "missing");
});

test("404/410: page gone — link missing for a different reason (pageStatus dead)", () => {
  for (const status of [404, 410]) {
    assert.deepEqual(classifyFailedFetch(status), {
      checkStatus: "missing",
      pageStatus: "dead",
      checkError: `http_${status}`,
    });
  }
});

test("all attempts fell over (network/DNS/timeout): blocked with unknown page state", () => {
  assert.deepEqual(classifyFailedFetch(0), { checkStatus: "blocked", pageStatus: "unknown", checkError: "network" });
});

test("other statuses stay a no-verdict error", () => {
  for (const status of [400, 408, 451, 500, 502, 503]) {
    const out = classifyFailedFetch(status);
    assert.equal(out.checkStatus, "error", `HTTP ${status}`);
    assert.equal(out.pageStatus, "unknown", `HTTP ${status}`);
  }
});

// ─── best link of several (T4, задача 4) ───────────────────────────────────────

test("urlTo match wins over dofollow, dofollow wins over first, order breaks ties", () => {
  const wrongPageDofollow = hit({ linkUrl: "https://mysite.com/homepage", anchor: "homepage link" });
  const agreedPageNofollow = hit({ linkUrl: "https://mysite.com/agreed", anchor: "agreed link", rel: nofollowRel });
  const firstNofollow = hit({ linkUrl: "https://mysite.com/other", anchor: "first", rel: nofollowRel });
  const secondNofollow = hit({ linkUrl: "https://mysite.com/other2", anchor: "second", rel: nofollowRel });

  const byTarget = pickBestHit([wrongPageDofollow, agreedPageNofollow], "https://mysite.com/agreed");
  assert.equal(byTarget?.hit.anchor, "agreed link");
  assert.equal(byTarget?.targetOk, true);

  const byDofollow = pickBestHit([firstNofollow, wrongPageDofollow, secondNofollow], "");
  assert.equal(byDofollow?.hit.anchor, "homepage link");
  assert.equal(byDofollow?.targetOk, null); // urlTo empty → nothing to compare against

  const byOrder = pickBestHit([firstNofollow, secondNofollow], "");
  assert.equal(byOrder?.hit.anchor, "first");
});

test("checkTargetOk: null without urlTo or without a link, false when the link points elsewhere", () => {
  assert.equal(pickBestHit([], "https://mysite.com/agreed"), null);
  const solo = pickBestHit([hit()], "");
  assert.ok(solo); // a non-empty hit list always yields a row
  assert.equal(solo.targetOk, null);

  const elsewhere = pickBestHit([hit({ linkUrl: "https://mysite.com/homepage" })], "https://mysite.com/agreed");
  assert.equal(elsewhere?.targetOk, false);
});

test("urlsEquivalent: protocol/www/trailing-slash tolerant, query strict, hash ignored", () => {
  assert.equal(urlsEquivalent("https://www.mysite.com/landing", "http://mysite.com/landing/"), true);
  assert.equal(urlsEquivalent("https://mysite.com/landing?utm=x", "https://mysite.com/landing"), false);
  assert.equal(urlsEquivalent("https://mysite.com/landing#top", "https://mysite.com/landing"), true);
  assert.equal(urlsEquivalent("https://mysite.com/landing", "https://mysite.com/landing2"), false);
  assert.equal(urlsEquivalent("https://mysite.com/", "https://mysite.com"), true);
  assert.equal(urlsEquivalent("not a url", "https://mysite.com/"), false);
});

// ─── events (T4, задача 4) ─────────────────────────────────────────────────────

test("found → missing is lost; missing → found is returned", () => {
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "found" }), snap({ checkStatus: "missing" })), [
    { kind: "lost", detail: JSON.stringify({ from: "found", to: "missing" }) },
  ]);
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "missing" }), snap({ checkStatus: "found" })), [
    { kind: "returned", detail: JSON.stringify({ from: "missing", to: "found" }) },
  ]);
});

test("anchor change and rel downgrade while found", () => {
  const events = diffCheckEvents(snap(), snap({ checkAnchor: "new anchor" }));
  assert.equal(events[0].kind, "anchor_changed");
  assert.deepEqual(JSON.parse(events[0].detail), { from: "our anchor", to: "new anchor" });

  const downgraded = diffCheckEvents(snap(), snap({ checkRel: "nofollow", checkNofollow: true }));
  assert.equal(downgraded[0].kind, "rel_downgraded");

  // sponsored without nofollow still loses weight — it is a downgrade too
  const sponsored = diffCheckEvents(snap(), snap({ checkRel: "sponsored", checkSponsored: true }));
  assert.equal(sponsored[0].kind, "rel_downgraded");

  // and the reverse direction is an upgrade
  const upgraded = diffCheckEvents(snap({ checkRel: "nofollow", checkNofollow: true }), snap());
  assert.equal(upgraded[0].kind, "rel_upgraded");
});

test("blocked and error produce no events — an event is an assertion", () => {
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "found" }), snap({ checkStatus: "blocked" })), []);
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "found" }), snap({ checkStatus: "error" })), []);
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "blocked" }), snap({ checkStatus: "missing" })), []);
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "error" }), snap({ checkStatus: "found" })), []);
});

test("first verdict records no event: unchecked is a baseline, not a change", () => {
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "unchecked" }), snap()), []);
  assert.deepEqual(diffCheckEvents(snap({ checkStatus: "unchecked" }), snap({ checkStatus: "missing" })), []);
});

test("unknown previous anchor is not an anchor_changed event", () => {
  assert.deepEqual(diffCheckEvents(snap({ checkAnchor: "" }), snap({ checkAnchor: "new anchor" })), []);
});

// ─── host-grouped queue (T4, задача 2) ─────────────────────────────────────────

test("rows of one host share a group — two donor URLs never run concurrently", () => {
  const rows = [
    { id: "1", urlFrom: "https://a.example/1" },
    { id: "2", urlFrom: "https://b.example/1" },
    { id: "3", urlFrom: "https://a.example/2" },
    { id: "4", urlFrom: "http://a.example:8080/3" },
    { id: "5", urlFrom: "https://c.example/1" },
  ];
  const groups = groupByHost(rows);
  const hosts = groups.map(g => g.host);
  assert.deepEqual([...hosts].sort(), ["a.example", "b.example", "c.example"]);
  for (const group of groups) {
    const ids = group.rows.map(r => r.id).sort();
    if (group.host === "a.example") assert.deepEqual(ids, ["1", "3", "4"]);
    else assert.equal(group.rows.length, 1);
  }
  // longest group first, so workers drain the big site while small ones interleave
  assert.equal(groups[0].host, "a.example");
  // nothing lost, nothing duplicated
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
});

test("unparseable urlFrom still groups under a stable key instead of crashing", () => {
  assert.equal(hostOf("not a url"), "not a url");
  const groups = groupByHost([{ id: "1", urlFrom: "garbage" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows[0].id, "1");
});

// ─── TLS failure detection (T4, задача 3) ──────────────────────────────────────

test("expired/self-signed certificates are detected through the cause chain", () => {
  const direct = Object.assign(new Error("cert"), { code: "CERT_HAS_EXPIRED" });
  assert.equal(isTlsCertFailure(direct), true);
  const nested = new Error("wrapped", { cause: Object.assign(new Error("leaf"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
  assert.equal(isTlsCertFailure(nested), true);
  const altName = Object.assign(new Error("altname"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.equal(isTlsCertFailure(altName), true);

  assert.equal(isTlsCertFailure(new Error("plain network error")), false);
  assert.equal(isTlsCertFailure(Object.assign(new Error("revoked"), { code: "CERT_REVOKED" })), false);
  assert.equal(isTlsCertFailure(null), false);
});

// ─── DB write guard (CONTRACT.md §1: each writer names only its own fields) ────

test("buildCheckUpdate writes exactly the check*/page* group and nothing else", () => {
  const update = buildCheckUpdate(checkResult({ hit: hit(), targetOk: true, pageTitle: "Donor page" }), new Date());
  const keys = Object.keys(update).sort();
  assert.deepEqual(keys, [
    "checkAnchor", "checkError", "checkFoundUrl", "checkInsecure", "checkMatchedDomain",
    "checkNofollow", "checkRel", "checkSponsored", "checkStatus", "checkTargetOk", "checkUgc",
    "checkedAt", "pageCheckedAt", "pageTitle", "pageStatus",
  ].sort());
  const asRecord = update as Record<string, unknown>;
  for (const forbidden of ["apiSeen", "apiAnchor", "favorite", "note", "priceNote", "urlTo", "urlFrom"]) {
    assert.equal(asRecord[forbidden], undefined, forbidden);
  }
});

test("a blocked check does not blank the pageTitle a previous check read", () => {
  const update = buildCheckUpdate(checkResult({ checkStatus: "blocked", pageStatus: "blocked", checkError: "http_403" }), new Date());
  assert.equal("pageTitle" in update, false);
});

// ─── summary (T4, задача 5 and 6) ──────────────────────────────────────────────

test("tallyRow and finishSummary count verdicts, domains, errors and js-suspects", () => {
  const acc = newSummary();
  const row = { id: "1", domainFrom: "donor.example", urlFrom: "https://donor.example/x" };
  tallyRow(acc, row, checkResult({ hit: hit() }));
  tallyRow(acc, { ...row, id: "2" }, checkResult({ checkStatus: "missing", pageStatus: "alive" }));
  tallyRow(acc, { ...row, id: "3" }, checkResult({ checkStatus: "missing", jsSuspect: true }));
  tallyRow(acc, { ...row, id: "4" }, checkResult({ checkStatus: "blocked", pageStatus: "blocked", checkError: "http_403" }));
  tallyRow(acc, { ...row, id: "5" }, checkResult({ checkStatus: "error", pageStatus: "unknown", checkError: "non_html" }));

  const summary = finishSummary(acc, true);
  assert.equal(summary.scanned, 5);
  assert.equal(summary.withLink, 1);
  assert.equal(summary.zeroMatches, 2);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.byDomain, { "donor.example": 5 });
  assert.deepEqual(summary.byError, { http_403: 1, non_html: 1 });
  // apiJsCrawl + missing comes back separately so the UI can say "not a removal" (blchkJsHint)
  assert.deepEqual(summary.jsSuspectIds, ["3"]);
  assert.equal(summary.jsSuspect, 1);
  assert.equal(summary.unitsSpent, 0); // our own HTTP, not Ahrefs units
  assert.equal(summary.complete, true);
});

// ─── misc ──────────────────────────────────────────────────────────────────────

test("scheme-less donor URLs are upgraded to https for the fetch layer", () => {
  assert.equal(absolutizeUrl("donor.example/page"), "https://donor.example/page");
  assert.equal(absolutizeUrl("http://donor.example/page"), "http://donor.example/page");
  assert.equal(absolutizeUrl("  https://donor.example  "), "https://donor.example");
});
