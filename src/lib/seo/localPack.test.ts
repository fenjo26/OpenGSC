// wave-nov N3 — the map pack, against fixtures in ./__fixtures__/ (provider answer shapes, no
// keys). What is worth testing is where a mistake is silent and expensive:
//  - `matchLocalPack` deciding a pack entry is US when it is not (a wrong #1 in the tracker),
//    or missing us when it is (a silent "not in pack");
//  - the parsers trusting a renamed field into a garbled pack;
//  - a geolocated query slipping to a provider that cannot geolocate — the answer would be the
//    COUNTRY position stored under a city keyword, which the history then keeps forever.
//
// The snapshot test pins the other half of the contract: a call WITHOUT `location` returns
// exactly the response `runSerp` returned before this wave — SERP Monitor and SEO Tools share
// this function and their snapshots must not grow new fields.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { runSerp } from "./serp";
import { fallbackForLocation } from "../rankFallback";
import {
  brandNamesFromHost, dfsLocationParams, matchLocalPack, parseAparserLocal,
  parseCoordinates, parseDfsLocalPack, parseSerperPlaces, validateLocation,
} from "./localPack";

const fix = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));

// The A-Parser row shape that has no local block — what the live-probe fixtures look like.
const APARSER_ROW_NO_LOCAL = {
  success: 1,
  totalcount: "10",
  serp: [{ link: "https://skytaxi.gr/", anchor: "Sky Taxi", snippet: "Transfers" }],
};

// ── parseSerperPlaces ──────────────────────────────────────────────────────────

test("Serper places: the pack is the TOP THREE, website→domain, rating kept, no-website entry null", () => {
  const pack = parseSerperPlaces(fix("serper-local-places.json").places);
  assert.equal(pack.length, 3, "the fourth place is cut");
  assert.deepEqual(
    pack.map((p) => p.position),
    [1, 2, 3],
  );
  assert.equal(pack[0].title, "Sky Taxi Thessaloniki");
  assert.equal(pack[0].domain, "skytaxi.gr", "www. stripped from the website url");
  assert.equal(pack[0].rating, 4.8);
  assert.equal(pack[0].address, "Airport Road, Thessaloniki 546 03");
  assert.equal(pack[1].domain, null, "an entry with no website has no domain — not ''");
});

// ── parseDfsLocalPack ──────────────────────────────────────────────────────────

test("DataForSEO: only type=local_pack items, in rank order, rating.value unwrapped", () => {
  const tasks = fix("dfs-local-pack.json").tasks as { result?: { items?: unknown[] }[] }[] | undefined;
  const items = tasks?.[0]?.result?.[0]?.items ?? [];
  const pack = parseDfsLocalPack(items);
  assert.equal(pack.length, 3);
  assert.deepEqual(pack.map((p) => p.position), [1, 2, 3]);
  assert.equal(pack[0].domain, "skytaxi.gr");
  assert.equal(pack[1].domain, null);
  assert.equal(pack[1].rating, 4.6, "nested rating.value, not the object");
  assert.equal(pack[2].rating, null, "rating:null stays null, never 0");
});

// ── matchLocalPack ─────────────────────────────────────────────────────────────

test("matchLocalPack by domain: exact host, www ignored, subdomain counts, look-alike apex does not", () => {
  const pack = parseSerperPlaces(fix("serper-local-places.json").places);
  // us = skytaxi.gr → place 1 by domain.
  assert.deepEqual(matchLocalPack(pack, { host: "skytaxi.gr", names: [] }), { position: 1, title: "Sky Taxi Thessaloniki" });
  assert.deepEqual(matchLocalPack(pack, { host: "www.skytaxi.gr", names: [] }), { position: 1, title: "Sky Taxi Thessaloniki" }, "www on OUR host is still us");
  // An entry on a SUBDOMAIN of the tracked host is us — the same direction matchesSite in
  // lib/rank.ts applies to organic results (a result on the apex of a tracked subdomain is not).
  const withSub = [{ position: 1, title: "Booking page", domain: "booking.skytaxi.gr", address: null, rating: null }];
  assert.equal(matchLocalPack(withSub, { host: "skytaxi.gr", names: [] })?.position, 1);
  assert.equal(matchLocalPack(pack, { host: "sub.skytaxi.gr", names: [] }), null, "the pack's apex is not a tracked subdomain's site (organic convention)");
  assert.equal(matchLocalPack(pack, { host: "skytaxi-2.gr", names: [] }), null, "similar name, different registrable domain — not us");
  assert.equal(matchLocalPack(pack, { host: "notaxi.gr", names: [] }), null, "suffix without dot boundary is not us");
});

test("matchLocalPack: a domain match on place 2 beats name-matching place 1", () => {
  const pack = [
    { position: 1, title: "Sky Taxi Thessaloniki", domain: "other-taxi.gr", address: null, rating: null },
    { position: 2, title: "Some Other Co", domain: "skytaxi.gr", address: null, rating: null },
  ];
  assert.equal(matchLocalPack(pack, { host: "skytaxi.gr", names: [] })?.position, 2);
});

test("matchLocalPack by name: diacritics fold (Masáž Thessaloníki = Masaz Thessaloniki)", () => {
  const pack = [{ position: 2, title: "Masaz Thessaloniki", domain: null, address: null, rating: null }];
  assert.deepEqual(
    matchLocalPack(pack, { host: "massage-thess.gr", names: ["Masáž Thessaloníki"] }),
    { position: 2, title: "Masaz Thessaloniki" },
  );
});

test("matchLocalPack by name: a similar name below the 0.6 Jaccard is somebody else's business", () => {
  const pack = [{ position: 1, title: "Athens Taxi Transfer", domain: null, address: null, rating: null }];
  // {athens,taxi,tours} vs {athens,taxi,transfer} → 2/4 = 0.5
  assert.equal(matchLocalPack(pack, { host: "athens-taxi-tours.gr", names: ["Athens Taxi Tours"] }), null);
  // An unrelated name is far below.
  assert.equal(matchLocalPack(pack, { host: "x.gr", names: ["Ergo Lambda Cafe"] }), null);
});

test("matchLocalPack: any of the names matches when no pack entry carries a website", () => {
  const pack = [{ position: 3, title: "Massage Thessaloniki Therapies", domain: null, address: null, rating: null }];
  assert.equal(matchLocalPack(pack, { host: "unrelated.gr", names: ["Massage Thessaloniki Therapies"] })?.position, 3);
});

// ── location validation ────────────────────────────────────────────────────────

test("validateLocation: empty ok, city ok, coordinates ok with ranges enforced", () => {
  assert.deepEqual(validateLocation(""), { ok: true, value: "" });
  assert.deepEqual(validateLocation("  Thessaloniki,   Greece "), { ok: true, value: "Thessaloniki, Greece" });
  assert.deepEqual(validateLocation("40.5197,22.9709"), { ok: true, value: "40.5197,22.9709" });
  assert.equal(validateLocation("91,10").ok, false, "latitude out of range");
  assert.equal(validateLocation("40.5,999").ok, false, "longitude out of range");
  assert.equal(validateLocation("40.5").ok, false, "a lone number is not a location");
  assert.equal(validateLocation("x".repeat(121)).ok, false, "over 120 characters");
  assert.deepEqual(parseCoordinates("40.5197, 22.9709"), { lat: 40.5197, lng: 22.9709 });
  assert.equal(parseCoordinates("Thessaloniki"), null);
});

test("brandNamesFromHost: label and hyphen-split words, TLD and short debris dropped", () => {
  assert.deepEqual(brandNamesFromHost("massagethess.gr"), ["massagethess"]);
  assert.deepEqual(brandNamesFromHost("thessaloniki-taxi.gr"), ["thessaloniki-taxi", "thessaloniki taxi"]);
  assert.deepEqual(brandNamesFromHost("a.b.gr"), [], "tokens under 3 chars are debris");
});

test("dfsLocationParams: coordinates → location_coordinate with radius, name → location_name", () => {
  assert.deepEqual(dfsLocationParams("40.5197,22.9709"), { location_coordinate: "40.5197,22.9709,14" });
  assert.deepEqual(dfsLocationParams("Thessaloniki, Central Macedonia, Greece"), { location_name: "Thessaloniki, Central Macedonia, Greece" });
});

test("fallbackForLocation: a fallback without a location parameter never answers a local keyword", () => {
  assert.equal(fallbackForLocation("scrapingrobot", "Thessaloniki"), null);
  assert.equal(fallbackForLocation("goanyapi", "Thessaloniki"), null);
  assert.equal(fallbackForLocation("serper", "Thessaloniki"), "serper");
  assert.equal(fallbackForLocation("dataforseo", "40.5197,22.9709"), "dataforseo");
  assert.equal(fallbackForLocation("aparser", "Thessaloniki"), "aparser");
  // Without a location the configured fallback stands, whatever it is.
  assert.equal(fallbackForLocation("scrapingrobot", ""), "scrapingrobot");
  assert.equal(fallbackForLocation(null, "Thessaloniki"), null);
  assert.equal(fallbackForLocation(undefined, undefined), null);
});

// ── runSerp guards ─────────────────────────────────────────────────────────────

test("a geolocated query on a provider without a location parameter is refused, code verbatim", async () => {
  for (const provider of ["goanyapi", "scrapingrobot"]) {
    const r = await runSerp(provider, "key", "taxi thessaloniki airport", { location: "Thessaloniki, Greece" });
    assert.equal(r.error, "location_unsupported", provider);
    assert.equal(r.results.length, 0);
    assert.ok(r.errorDetail && /location/i.test(r.errorDetail), "the detail says what to pick instead");
  }
});

test("the credential guard still runs before the location guard on capable providers", async () => {
  const r = await runSerp("dataforseo", "", "kw", { location: "Thessaloniki" });
  assert.notEqual(r.error, "location_unsupported");
  assert.equal(r.error, "no_serp_key");
});

// ── runSerp full paths, transport stubbed like serpmon/aparserSerp.test.ts ─────

/** Stubs fetch with canned JSON answers; returns the captured request bodies. */
function stub(responses: unknown[]): { bodies: () => unknown[]; done: () => void } {
  const g = globalThis as unknown as { fetch: typeof fetch };
  const real = g.fetch;
  const seen: unknown[] = [];
  let i = 0;
  g.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    seen.push(init.body ? JSON.parse(String(init.body)) : null);
    return { ok: true, status: 200, text: async () => "", json: async () => responses[Math.min(i++, responses.length - 1)] };
  }) as unknown as typeof fetch;
  return { bodies: () => seen, done: () => { g.fetch = real; } };
}

/** The captured body of one provider call, as a plain record (assertions read single fields). */
const body = (s: { bodies: () => unknown[] }, i = 0): Record<string, unknown> => s.bodies()[i] as Record<string, unknown>;

test("serper WITHOUT location: the response is exactly what it was before the pack existed", async () => {
  const s = stub([fix("serper-local-places.json")]);
  try {
    const r = await runSerp("serper", "k", "taxi thessaloniki airport", { gl: "gr", hl: "en", num: 10 });
    assert.equal(r.error, undefined);
    // The snapshot: no localPack, no hasLocalPack — the shared function's other callers see
    // exactly the old shape.
    assert.deepEqual(r, {
      engine: "google",
      provider: "serper",
      keyword: "taxi thessaloniki airport",
      results: [
        { position: 1, url: "https://skytaxi.gr/", title: "Sky Taxi — Thessaloniki airport transfers", snippet: "Fixed price airport transfers, 24/7.", domain: "skytaxi.gr" },
        { position: 2, url: "https://www.example-travel-blog.gr/taxi-guide", title: "Thessaloniki Airport Taxi Guide", snippet: "Everything about taxis at SKG.", domain: "example-travel-blog.gr" },
        { position: 3, url: "https://welcomepickups.com/gr/thessaloniki", title: "Welcome Pickups Thessaloniki", snippet: "Pre-booked airport pickup.", domain: "welcomepickups.com" },
      ],
      peopleAlsoAsk: ["How much is a taxi from Thessaloniki airport to the centre?"],
      relatedSearches: ["thessaloniki airport taxi price", "taxi thessaloniki airport to halkidiki"],
    });
    assert.equal(body(s).location, undefined, "no location in the request either");
  } finally { s.done(); }
});

test("serper WITH location: request carries it, answer carries the top-three pack", async () => {
  const s = stub([fix("serper-local-places.json")]);
  try {
    const r = await runSerp("serper", "k", "taxi thessaloniki airport", { gl: "gr", hl: "en", num: 10, location: "Thessaloniki, Greece" });
    assert.equal(r.error, undefined);
    assert.equal(r.hasLocalPack, true);
    assert.equal(r.localPack?.length, 3);
    assert.equal(r.localPack?.[0].title, "Sky Taxi Thessaloniki");
    assert.equal(r.localPack?.[0].domain, "skytaxi.gr");
    assert.equal(body(s).location, "Thessaloniki, Greece");
    assert.equal(r.results.length, 3, "the organic half of the answer is untouched");
  } finally { s.done(); }
});

test("dataforseo WITH a city name: location_name replaces location_code; the pack is parsed", async () => {
  const s = stub([fix("dfs-local-pack.json")]);
  try {
    const r = await runSerp("dataforseo", "login:pass", "taxi thessaloniki airport", {
      gl: "gr", hl: "en", num: 10, location: "Thessaloniki, Central Macedonia, Greece",
    });
    assert.equal(r.error, undefined);
    const task = body(s)[0] as Record<string, unknown>;
    assert.equal(task.location_name, "Thessaloniki, Central Macedonia, Greece");
    assert.equal("location_code" in task, false, "the API refuses both fields at once");
    assert.equal(r.hasLocalPack, true);
    assert.deepEqual(r.localPack?.map((p) => p.position), [1, 2, 3]);
    assert.equal(r.localPack?.[2].title, "KTEL Transfers");
  } finally { s.done(); }
});

test("dataforseo WITH coordinates: location_coordinate '<lat>,<lng>,14'", async () => {
  const s = stub([fix("dfs-local-pack.json")]);
  try {
    const r = await runSerp("dataforseo", "login:pass", "kw", { gl: "gr", num: 10, location: "40.5197,22.9709" });
    assert.equal(r.error, undefined);
    assert.equal((body(s)[0] as Record<string, unknown>).location_coordinate, "40.5197,22.9709,14");
    assert.equal("location_code" in (body(s)[0] as Record<string, unknown>), false);
  } finally { s.done(); }
});

test("dataforseo does not recognise the location → location_unknown, never an empty SERP", async () => {
  const s = stub([{ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 40400, status_message: "Location name 'Xyyyy' not found" }] }]);
  try {
    const r = await runSerp("dataforseo", "login:pass", "kw", { gl: "gr", num: 10, location: "Xyyyy" });
    assert.equal(r.error, "location_unknown");
    assert.match(r.errorDetail ?? "", /Xyyyy/);
    assert.equal(r.results.length, 0);
  } finally { s.done(); }
});

test("aparser WITH location: the geo rides as an override; a row without a local block says nothing", async () => {
  const s = stub([{ success: 1, data: { results: [APARSER_ROW_NO_LOCAL] } }]);
  try {
    const r = await runSerp("aparser", "pw", "kw", { baseUrl: "127.0.0.1:9091", num: 10, location: "Thessaloniki" });
    assert.equal(r.error, undefined);
    const opts = (body(s).data as { options: { id: string; value: unknown }[] }).options;
    assert.ok(opts.some((o) => o.id === "location" && o.value === "Thessaloniki"), "the location override is sent");
    assert.equal(r.hasLocalPack, null, "no local block in the row → the provider did not say");
    assert.equal("localPack" in r, false);
  } finally { s.done(); }
});

test("aparser refuses an override: the degraded retry KEEPS the location, dropping only gl/hl", async () => {
  const s = stub([
    { success: 0, data: "unknown option id" },
    { success: 1, data: { results: [APARSER_ROW_NO_LOCAL] } },
  ]);
  try {
    const r = await runSerp("aparser", "pw", "kw", { baseUrl: "127.0.0.1:9091", num: 10, gl: "gr", hl: "el", location: "Thessaloniki" });
    assert.equal(r.error, undefined);
    assert.equal(s.bodies().length, 2);
    assert.deepEqual(
      (body(s, 1).data as { options: unknown[] }).options,
      [
        { type: "override", id: "pagecount", value: 1 },
        { type: "override", id: "location", value: "Thessaloniki" },
      ],
    );
  } finally { s.done(); }
});

test("parseAparserLocal: a row WITH a local block yields entries and hasPack true; absent key stays null", () => {
  const withLocal = {
    ...APARSER_ROW_NO_LOCAL,
    local: [
      { title: "Sky Taxi Thessaloniki", link: "https://www.skytaxi.gr/", rating: 4.9, address: "Airport Rd" },
      "A bare string entry",
    ],
  };
  const parsed = parseAparserLocal(withLocal);
  assert.equal(parsed.hasPack, true);
  assert.equal(parsed.pack.length, 2);
  assert.equal(parsed.pack[0].domain, "skytaxi.gr");
  assert.equal(parsed.pack[1].title, "A bare string entry");
  assert.deepEqual(parseAparserLocal(APARSER_ROW_NO_LOCAL), { pack: [], hasPack: null });
  assert.deepEqual(parseAparserLocal({ ...APARSER_ROW_NO_LOCAL, local: [] }), { pack: [], hasPack: false });
});
