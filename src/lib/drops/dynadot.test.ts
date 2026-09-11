import { test } from "node:test";
import assert from "node:assert/strict";
import { findResultNode, readVerdict } from "./dynadot";
import { parseBootstrap } from "./rdapBootstrap";

// What is worth testing here is not "does the HTTP call work" but the two places where a wrong
// reading costs money: turning a registrar's answer into a verdict, and finding that answer
// inside an envelope whose exact shape could not be pinned against a live account.

// ─── findResultNode ──────────────────────────────────────────────────────────

test("the result is found whatever wrapper it arrives in", () => {
  const shapes: unknown[] = [
    { SearchResponse: { ResponseCode: "0", SearchResults: [{ DomainName: "beton.cool", Available: "yes" }] } },
    { Results: [{ domainName: "beton.cool", available: "yes" }] },
    { DomainName: "beton.cool", Available: "yes" },
  ];
  for (const body of shapes) {
    const node = findResultNode(body, "beton.cool");
    assert.ok(node, `not found in ${JSON.stringify(body)}`);
    assert.equal(readVerdict(node).verdict, "available");
  }
});

test("the right domain is picked out of a multi-domain answer", () => {
  const body = {
    SearchResponse: {
      SearchResults: [
        { DomainName: "taken.com", Available: "no" },
        { DomainName: "free.com", Available: "yes" },
      ],
    },
  };
  assert.equal(readVerdict(findResultNode(body, "free.com")).verdict, "available");
  assert.equal(readVerdict(findResultNode(body, "taken.com")).verdict, "unavailable");
});

test("a cyclic response does not hang the walk", () => {
  const body: Record<string, unknown> = { DomainName: "x.com", Available: "yes" };
  body.self = body;
  assert.equal(readVerdict(findResultNode(body, "x.com")).verdict, "available");
});

// ─── readVerdict ─────────────────────────────────────────────────────────────

test("premium is its own verdict, never plain available", () => {
  // The whole point: a premium name is "available" to the registrar and useless to the funnel,
  // which assumes a standard registration fee.
  const cases = [
    { DomainName: "x.com", Available: "yes", Price: "3200.00", IsPremium: "yes" },
    { DomainName: "x.com", Available: "yes", Status: "premium" },
  ];
  for (const node of cases) {
    const v = readVerdict(node);
    assert.equal(v.verdict, "premium", JSON.stringify(node));
  }
});

test("a plain available carries its price without becoming premium", () => {
  const v = readVerdict({ DomainName: "x.com", Available: "yes", Price: "10.99" });
  assert.equal(v.verdict, "available");
  assert.equal(v.price, "10.99");
});

test("an error field is a refusal, not a verdict about the domain", () => {
  // A bad key or a throttled account must never read as "this name is taken".
  const v = readVerdict({ Error: "Invalid API key" });
  assert.equal(v.verdict, "refused");
  assert.match(v.reason ?? "", /Invalid API key/);
});

test("an unreadable availability value stays unknown", () => {
  assert.equal(readVerdict({ DomainName: "x.com", Available: "" }).verdict, "unknown");
  assert.equal(readVerdict({ DomainName: "x.com", Available: "maybe" }).verdict, "unknown");
  assert.equal(readVerdict(null).verdict, "unknown");
});

test("boolean-ish spellings are accepted", () => {
  assert.equal(readVerdict({ Available: "true" }).verdict, "available");
  assert.equal(readVerdict({ Available: "false" }).verdict, "unavailable");
});

// ─── parseBootstrap ──────────────────────────────────────────────────────────

test("the IANA bootstrap maps every zone in a service group", () => {
  const map = parseBootstrap({
    publication: "2026-09-10T00:00:00Z",
    services: [
      [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
      [["cool", "guide"], ["https://rdap.identitydigital.services/rdap/"]],
    ],
  });
  assert.equal(map.get("com"), "https://rdap.verisign.com/com/v1/");
  assert.equal(map.get("net"), "https://rdap.verisign.com/com/v1/");
  assert.equal(map.get("guide"), "https://rdap.identitydigital.services/rdap/");
});

test("https wins when a registry publishes both, and a trailing slash is guaranteed", () => {
  const map = parseBootstrap({
    services: [[["example"], ["http://rdap.example.test/rdap", "https://rdap.example.test/rdap"]]],
  });
  assert.equal(map.get("example"), "https://rdap.example.test/rdap/");
});

test("malformed entries are skipped instead of poisoning the map", () => {
  const map = parseBootstrap({
    services: [
      "nonsense",
      [["ok"], ["https://rdap.ok.test/"]],
      [["noservers"], []],
      [[], ["https://rdap.orphan.test/"]],
      [["badscheme"], ["ftp://rdap.bad.test/"]],
    ] as unknown[],
  });
  assert.equal(map.get("ok"), "https://rdap.ok.test/");
  assert.equal(map.has("noservers"), false);
  assert.equal(map.has("badscheme"), false);
  assert.equal(map.size, 1);
});

test("a document with no services parses to an empty map rather than throwing", () => {
  assert.equal(parseBootstrap({}).size, 0);
  assert.equal(parseBootstrap({ services: null } as never).size, 0);
});
