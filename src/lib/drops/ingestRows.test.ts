import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDelimiter, parseDelimited, parseDomainRows } from "./ingest";

// The case this whole parser exists for: an Ahrefs "Outgoing links" export puts the SOURCE
// column (Referring page URL) before the TARGET column, so "first field that looks like a
// domain" imports the donor 143 000 times and nothing else.

const OUTGOING = [
  'Referring page title\tReferring page URL\tTarget URL\tAnchor\tDomain rating',
  'Noticias\thttps://elpais.com/a/1\thttps://iberconceptos.net/x\t"hola, mundo"\t31',
  'Noticias\thttps://elpais.com/a/2\thttps://cincomillonesdepasos.org/y\tancla\t12',
  'Noticias\thttps://elpais.com/a/3\thttps://iberconceptos.net/z\totro\t35',
].join("\n");

test("the target column wins over the referring-page column", () => {
  const { rows, columns } = parseDomainRows(OUTGOING);
  assert.equal(columns.detected, true);
  assert.deepEqual(rows.map(r => r.domain), ["iberconceptos.net", "cincomillonesdepasos.org"]);
  assert.ok(!rows.some(r => r.domain === "elpais.com"), "the donor must not be imported");
});

test("DR rides in from the file, keeping the highest value per domain", () => {
  const { rows } = parseDomainRows(OUTGOING);
  assert.equal(rows.find(r => r.domain === "iberconceptos.net")?.dr, 35);
  assert.equal(rows.find(r => r.domain === "cincomillonesdepasos.org")?.dr, 12);
});

test("a comma inside a quoted anchor does not shift the columns", () => {
  const { rows } = parseDomainRows(
    'Anchor,Target URL,Domain rating\n"hola, mundo",https://iberconceptos.net/x,31\n',
  );
  assert.deepEqual(rows, [{ domain: "iberconceptos.net", dr: 31 }]);
});

test("quotes, doubled quotes and newlines inside a field survive", () => {
  const table = parseDelimited('a,"say ""hi""","line\nbreak"\n', ",");
  assert.deepEqual(table, [["a", 'say "hi"', "line\nbreak"]]);
});

test("delimiter detection prefers the tab Ahrefs actually writes", () => {
  assert.equal(detectDelimiter('Anchor\tTarget URL\nhola, mundo\thttps://x.com'), "\t");
  assert.equal(detectDelimiter("Anchor,Target URL\na,b"), ",");
});

test("without a recognisable header it falls back and says so", () => {
  const { rows, columns } = parseDomainRows("iberconceptos.net\ncincomillonesdepasos.org\n");
  assert.equal(columns.detected, false);
  assert.deepEqual(rows.map(r => r.domain), ["iberconceptos.net", "cincomillonesdepasos.org"]);
});

test("a manual column override beats detection", () => {
  const { rows } = parseDomainRows(OUTGOING, { domain: 1 });
  assert.deepEqual(rows.map(r => r.domain), ["elpais.com"]);
});

test("hosts reduce to the apex and junk rows are reported, not imported", () => {
  const { rows, skipped } = parseDomainRows(
    "Target URL,Domain rating\nhttps://www.blog.iberconceptos.net/x,31\n192.0.2.1,5\n,\n",
  );
  assert.deepEqual(rows, [{ domain: "iberconceptos.net", dr: 31 }]);
  assert.ok(skipped.some(s => s.reason === "ip_address"));
});

test("numbers survive decimal commas and thousand separators", () => {
  const { rows } = parseDomainRows(
    'Linked domain;Domain rating;Referring domains\nx.com;"3,4";"1 234"\n',
  );
  assert.deepEqual(rows, [{ domain: "x.com", dr: 3.4, refdomains: 1234 }]);
});

test("DR is clamped to the 0-100 the column claims to be", () => {
  const { rows } = parseDomainRows("Target URL,DR\nhttps://x.com,999\n");
  assert.equal(rows[0].dr, 100);
});
