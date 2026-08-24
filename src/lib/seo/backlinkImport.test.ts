import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBacklinkUrl, donorHostOf, isHttpUrl, parseBacklinkImport, buildImportPlan,
  parseBacklinkFilters, buildBacklinkWhere, parseBacklinkSort,
  type ExistingBacklinkRow,
} from "./backlinkImport";

// ─── normalizeBacklinkUrl: the five migration steps ───────────────────────────
// A TS step that diverges from 20260825120000's SQL would duplicate every migrated row on
// re-import, so the examples here mirror the SQL's CTEs one by one.

test("normalize: lowercase", () => {
  assert.equal(normalizeBacklinkUrl("https://Donor.RU/Blog/Statya"), "donor.ru/blog/statya");
});

test("normalize: drops fragment", () => {
  assert.equal(normalizeBacklinkUrl("https://donor.ru/page#section"), "donor.ru/page");
});

test("normalize: drops scheme, www and one trailing slash", () => {
  assert.equal(normalizeBacklinkUrl("http://www.donor.ru/"), "donor.ru");
  assert.equal(normalizeBacklinkUrl("https://donor.ru/blog/"), "donor.ru/blog");
  // exactly one trailing slash — "a//" keeps the inner one, like the SQL's single substr
  assert.equal(normalizeBacklinkUrl("https://donor.ru//"), "donor.ru/");
});

test("normalize: empty input", () => {
  assert.equal(normalizeBacklinkUrl("   "), "");
});

test("donorHostOf: host only, no www", () => {
  assert.equal(donorHostOf("https://www.donor.ru/blog/statya"), "donor.ru");
  assert.equal(donorHostOf("donor.ru"), "donor.ru");
});

test("isHttpUrl: http(s) with a real host only", () => {
  assert.equal(isHttpUrl("https://donor.ru/a"), true);
  assert.equal(isHttpUrl("http://donor.ru/a"), true);
  assert.equal(isHttpUrl("ftp://donor.ru/a"), false);
  assert.equal(isHttpUrl("donor.ru/a"), false);
  assert.equal(isHttpUrl("http://localhost/a"), false); // no dot — not a donor page
  assert.equal(isHttpUrl("garbage"), false);
});

// ─── parseBacklinkImport ───────────────────────────────────────────────────────

test("parse: bare list with comments and junk", () => {
  const r = parseBacklinkImport([
    "# contractor report 2026-08",
    "https://donor.ru/blog/statya",
    "https://other.net/page",
    "not-a-url",
    "",
    "https://bad",
  ].join("\n"));
  assert.equal(r.mode, "list");
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.columns, ["url"]);
  assert.equal(r.skippedRows, 2);
  assert.equal(r.rows[0].urlNorm, "donor.ru/blog/statya");
});

test("parse: CSV table with header, alias columns, ignored column, invalid rows", () => {
  const csv = [
    "Url,Anchor Text,Target,rel,DR,Price,Comment,InternalId",
    "https://donor.ru/a, купить окна ,https://mysite.ru/okna,dofollow,23,100 rub, agreed, x1",
    "donor.ru/b,broken", // scheme-less — the "мусор" the preview must count
    "https://donor.ru/c,anchor2,https://mysite.ru/c,nofollow,41,,,",
  ].join("\n");
  const r = parseBacklinkImport(csv);
  assert.equal(r.mode, "table");
  assert.deepEqual(r.columns, ["url", "anchor", "target_url", "rel", "dr", "price", "note"]);
  assert.deepEqual(r.ignoredColumns, ["InternalId"]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.skippedRows, 1);
  const a = r.rows[0];
  assert.equal(a.anchor, "купить окна");
  assert.equal(a.targetUrl, "https://mysite.ru/okna");
  assert.equal(a.rel, "dofollow");
  assert.equal(a.dr, 23);
  assert.equal(a.price, "100 rub");
  assert.equal(a.note, "agreed");
});

test("parse: TSV table recognized by header aliases", () => {
  const tsv = [
    "url_from\ttarget_url",
    "https://donor.ru/x\thttps://mysite.ru/x",
  ].join("\n");
  const r = parseBacklinkImport(tsv);
  assert.equal(r.mode, "table");
  assert.deepEqual(r.columns, ["url", "target_url"]);
  assert.equal(r.rows[0].targetUrl, "https://mysite.ru/x");
});

test("parse: headerless positional rows (the dialog's documented example)", () => {
  const r = parseBacklinkImport(
    "https://donor.ru/blog/statya, купить окна, https://mysite.ru/okna, dofollow",
  );
  assert.equal(r.mode, "list"); // no header — positional, not table
  assert.deepEqual(r.columns, ["url", "anchor", "target_url", "rel"]);
  const row = r.rows[0];
  assert.equal(row.url, "https://donor.ru/blog/statya");
  assert.equal(row.anchor, "купить окна");
  assert.equal(row.targetUrl, "https://mysite.ru/okna");
  assert.equal(row.rel, "dofollow");
  assert.equal(row.dr, null); // column not present in the line
});

test("parse: duplicates inside one import merge, not double-create", () => {
  const r = parseBacklinkImport([
    "https://donor.ru/a, anchor one",
    "https://WWW.DONOR.RU/a/, anchor two",
  ].join("\n"));
  assert.equal(r.rows.length, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.rows[0].anchor, "anchor one"); // first wins, second fills nothing
});

test("parse: list and CSV give the same rows for the same data", () => {
  const list = parseBacklinkImport("https://donor.ru/a\nhttps://donor.ru/b");
  const csv = parseBacklinkImport("url\nhttps://donor.ru/a\nhttps://donor.ru/b");
  assert.deepEqual(list.rows, csv.rows);
});

// ─── buildImportPlan: the write rule ───────────────────────────────────────────

const existing = (over: Partial<ExistingBacklinkRow> = {}): ExistingBacklinkRow => ({
  id: "e1", urlNorm: "donor.ru/a", urlTo: "", sources: ["api"], note: "", priceNote: "", ...over,
});

test("plan: new url creates a row with the import origin", () => {
  const parsed = parseBacklinkImport("https://new.ru/page");
  const plan = buildImportPlan(parsed, [], "csv");
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.creates[0].sources, "csv");
  assert.equal(plan.creates[0].source, "csv");
  assert.equal(plan.creates[0].domainFrom, "new.ru");
  assert.equal(plan.creates[0].urlFromNorm, "new.ru/page");
});

test("plan: re-import matches despite case/www/scheme differences and adds to sources", () => {
  const parsed = parseBacklinkImport("https://WWW.Donor.RU/a");
  const plan = buildImportPlan(parsed, [existing()], "csv");
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].sources, "api,csv");
});

test("plan: urlTo filled only when empty", () => {
  const withTarget = parseBacklinkImport("https://donor.ru/a, , https://mysite.ru/okna");
  const filled = buildImportPlan(withTarget, [existing()], "csv");
  assert.equal(filled.updates[0].urlTo, "https://mysite.ru/okna");

  const again = buildImportPlan(withTarget, [existing({ urlTo: "https://other.page" })], "csv");
  assert.equal(again.updates[0].urlTo, undefined); // never overwritten
});

test("plan: prefers the candidate whose urlTo matches the import target", () => {
  const parsed = parseBacklinkImport("https://donor.ru/a, x, https://mysite.ru/two");
  const rows = [
    existing({ id: "one", urlTo: "https://mysite.ru/one" }),
    existing({ id: "two", urlTo: "https://mysite.ru/two" }),
  ];
  const plan = buildImportPlan(parsed, rows, "manual");
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "two");
});

test("plan: note and price fill-if-empty, never overwrite", () => {
  const parsed = parseBacklinkImport("https://donor.ru/a, , , , , 500, contractor says live");
  const fresh = buildImportPlan(parsed, [existing()], "csv");
  assert.equal(fresh.updates[0].note, "contractor says live");
  assert.equal(fresh.updates[0].priceNote, "500");

  const written = buildImportPlan(parsed, [existing({ note: "my own note", priceNote: "300" })], "csv");
  assert.equal(written.updates[0].note, undefined);
  assert.equal(written.updates[0].priceNote, undefined);
});

test("plan: sources already containing the origin yields a no-op update", () => {
  const parsed = parseBacklinkImport("https://donor.ru/a");
  const plan = buildImportPlan(parsed, [existing({ sources: ["api", "csv"] })], "csv");
  assert.equal(plan.updates.length, 0);
});

// ─── filters and sort ──────────────────────────────────────────────────────────

const sp = (qs: string) => new URLSearchParams(qs);

test("filters: rejects unknown enum values", () => {
  assert.equal(parseBacklinkFilters(sp("status=alive")).ok, false);
  assert.equal(parseBacklinkFilters(sp("rel=ugc")).ok, false);
  assert.equal(parseBacklinkFilters(sp("source=friends")).ok, false);
  assert.equal(parseBacklinkFilters(sp("drMin=abc")).ok, false);
});

test("filters: accepts the documented set", () => {
  const f = parseBacklinkFilters(sp("status=missing&rel=dofollow&source=csv&domain=DONOR.ru&drMin=10&drMax=50&favorite=1&lost=1"));
  assert.ok(f.ok);
  if (f.ok) {
    assert.equal(f.status, "missing");
    assert.equal(f.domain, "donor.ru");
    assert.equal(f.drMin, 10);
    assert.equal(f.favorite, true);
    assert.equal(f.lost, true);
  }
});

test("where: every filter lands on the query", () => {
  const f = parseBacklinkFilters(sp("status=blocked&source=manual&domain=donor.ru&drMin=5&favorite=1&lost=1"));
  assert.ok(f.ok);
  if (f.ok) {
    const w = buildBacklinkWhere("site1", f) as any;
    assert.equal(w.siteId, "site1");
    assert.equal(w.checkStatus, "blocked");
    assert.equal(w.sources.contains, "manual");
    assert.equal(w.domainFrom.contains, "donor.ru");
    assert.equal(w.apiDr.gte, 5);
    assert.equal(w.favorite, true);
    assert.equal(w.apiLost, true);
  }
});

test("where: rel=nofollow prefers our check when found, Ahrefs otherwise", () => {
  const f = parseBacklinkFilters(sp("rel=nofollow"));
  assert.ok(f.ok);
  if (f.ok) {
    const w = buildBacklinkWhere("s", f) as any;
    const [base, cond] = w.AND;
    assert.equal(base.siteId, "s");
    const checked = cond.OR[0].AND[1].OR.map((c: any) => Object.keys(c)[0]).sort();
    const fromApi = cond.OR[1].AND[1].OR.map((c: any) => Object.keys(c)[0]).sort();
    assert.deepEqual(checked, ["checkNofollow", "checkSponsored", "checkUgc"]);
    // the api side reads the same fields the UI cell does: dofollow=false IS nofollow
    assert.deepEqual(fromApi, ["apiDofollow", "apiNofollow", "apiSponsored", "apiUgc"]);
    assert.equal(cond.OR[0].AND[0].checkStatus, "found");
    assert.equal(cond.OR[1].AND[0].checkStatus.not, "found");
  }
});

test("where: rel=dofollow is the negation of rel=nofollow", () => {
  const nf = parseBacklinkFilters(sp("rel=nofollow"));
  const df = parseBacklinkFilters(sp("rel=dofollow"));
  assert.ok(nf.ok && df.ok);
  if (nf.ok && df.ok) {
    const a = buildBacklinkWhere("s", nf) as any;
    const b = buildBacklinkWhere("s", df) as any;
    assert.deepEqual(b.AND[1].NOT, a.AND[1]);
  }
});

test("sort: whitelist with a stable tiebreaker", () => {
  assert.deepEqual(parseBacklinkSort(sp("sort=dr_desc")), [{ apiDr: "desc" }, { id: "desc" }]);
  assert.deepEqual(parseBacklinkSort(sp("sort=domain_asc")), [{ domainFrom: "asc" }, { id: "desc" }]);
  // unknown keys fall back to newest-first, never reach Prisma as raw input
  assert.deepEqual(parseBacklinkSort(sp("sort=;DROP TABLE")), [{ addedAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(parseBacklinkSort(sp("")), [{ addedAt: "desc" }, { id: "desc" }]);
});
