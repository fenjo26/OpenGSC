import { test } from "node:test";
import assert from "node:assert/strict";
import { aparserOneRequest, isMissingConfigPreset, isMissingParserPreset } from "../seo/aparser";
import { describeAparserRow } from "../seo/aparserSerp";

test("isMissingConfigPreset recognises A-Parser's message, with or without the transport prefix", () => {
  assert.equal(isMissingConfigPreset(`aparser: {"msg":"configPreset 'my' not exists","success":0}`), true);
  assert.equal(isMissingConfigPreset("configPreset 'x' not exist"), true);
  assert.equal(isMissingConfigPreset(`aparser: {"msg":"Auth failed","success":0}`), false);
  assert.equal(isMissingConfigPreset(undefined), false);
});

test("a missing thread config is retried once with default", async () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push(body.data.configPreset);
    const payload = body.data.configPreset === "default"
      ? { success: 1, data: { results: [{ success: 1, serp: [] }] } }
      : { success: 0, data: "configPreset 'my' not exists" };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await aparserOneRequest({ baseUrl: "http://127.0.0.1:9091", password: "p", configPreset: "my" }, "SE::Google", "q");
    assert.ok(r.data);
    assert.deepEqual(sent, ["my", "default"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("other failures are not retried", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ success: 0, data: "Auth failed" }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await aparserOneRequest({ baseUrl: "http://127.0.0.1:9091", password: "p", configPreset: "my" }, "SE::Google", "q");
    assert.equal(r.data, null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("describeAparserRow leads with the verdict and the cause", () => {
  const live = describeAparserRow(
    { success: 0, serp: [], totalcount: "none", info: { success: 0, stats: { reCaptchaShows: 3, proxiesUsed: 1, retries: 14 } } },
    [
      [0, 1789559036, "Ban proxy 185.243.218.108:29760:socks5:: for parser SE::Google for 60 seconds"],
      [0, 1789559036, "All retries exceed"],
      [3, 1789559036, 0, '{"success":0,"retries":14}'],
      [0, 1789559036, "Thread complete work"],
    ],
  );
  assert.equal(live, "captcha 3, proxies 1, retries 14 · log: Ban proxy 185.243.218.108:29760:socks5:: for parser SE::Google for 60 seconds | All retries exceed");
});

test("describeAparserRow falls back to the key list for an unexpected shape", () => {
  const d = describeAparserRow({ success: 1, query: "nv casino", serp: [], totalcount: "", other: { a: 1 } }, ["retry 3/3 exhausted"]);
  assert.match(d, /keys: success=1, query, serp\[0\], totalcount=, other\{\}/);
  assert.match(d, /log: retry 3\/3 exhausted/);
  assert.equal(describeAparserRow(null, undefined), "results[0]: absent");
  assert.ok(describeAparserRow({ k: 1 }, Array(50).fill("x".repeat(100)), 100).length <= 101);
});

test("live captcha answer (A-Parser 1.2.3628) is filed as blocked, not as a parser failure", async () => {
  const { readFileSync } = await import("node:fs");
  const { mapAparserSerp, aparserSerpOptions } = await import("../seo/aparserSerp");
  const row = JSON.parse(readFileSync(new URL("./__fixtures__/aparser-serp-captcha-live.json", import.meta.url), "utf8"));
  const m = mapAparserSerp(row, 100);
  assert.equal(m.problem, "aparser_blocked_or_empty");
  assert.deepEqual(m.results, []);
  const ids = aparserSerpOptions({ depth: 100, gl: "gr", hl: "el" }).map(o => `${o.id}=${o.value}`);
  assert.deepEqual(ids, ["pagecount=10", "gl=gr", "hl=el", "redirectBrowserSingle=0"]);
});

test("a failed row without captchas stays a parser failure; totalcount 'none' is unknown", async () => {
  const { mapAparserSerp } = await import("../seo/aparserSerp");
  assert.equal(mapAparserSerp({ success: 0, serp: [] }, 10).problem, "aparser_parser_failed");
  const ok = mapAparserSerp({ success: 1, totalcount: "none", serp: [{ link: "https://a.gr/", anchor: "A" }] }, 10);
  assert.equal(ok.totalCount, "");
  assert.equal(ok.results.length, 1);
});

test("addTask sends the documented task shape (resultsSaveTo is the enum 'file')", async () => {
  const { aparserAddTask } = await import("../seo/aparser");
  let body: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    body = JSON.parse(String(init?.body ?? "{}")).data;
    return new Response(JSON.stringify({ success: 1, data: { taskid: 7 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await aparserAddTask({ baseUrl: "http://127.0.0.1:9091", password: "p" }, { parser: "SE::Google", queries: ["nv casino", " "] });
    assert.equal(r.data, 7);
    assert.equal(body.resultsSaveTo, "file");
    assert.match(String(body.resultsFileName), /^OpenGSC-SE-Google-\d+\.txt$/);
    assert.equal(body.queriesFrom, "text");
    assert.deepEqual(body.queryFormat, ["$query"]);
    assert.equal(body.resultsFormat, "$p1.preset");
    assert.deepEqual(body.queries, ["nv casino"]);
    assert.deepEqual(body.parsers, [["SE::Google", "default"]]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("task results are downloaded through the configured base URL, never the link's host", async () => {
  const { aparserTaskResultsText } = await import("../seo/aparser");
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u);
    seen.push(url);
    if (url.endsWith("/API")) {
      return new Response(JSON.stringify({ success: 1, data: "http://evil.example:9091/downloadResults?fileName=a.txt&token=t" }), { status: 200 });
    }
    return new Response("https://a.gr/\nhttps://b.gr/\n", { status: 200 });
  }) as typeof fetch;
  try {
    const r = await aparserTaskResultsText({ baseUrl: "http://127.0.0.1:9091", password: "p" }, 7);
    assert.equal(r.data?.text, "https://a.gr/\nhttps://b.gr/\n");
    assert.equal(seen[1], "http://127.0.0.1:9091/downloadResults?fileName=a.txt&token=t");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("flat serp (A-Parser 1.2.3640 live shape, 7 values per result) is mapped", async () => {
  const { readFileSync } = await import("node:fs");
  const { mapAparserSerp, serpItems } = await import("../seo/aparserSerp");
  const row = JSON.parse(readFileSync(new URL("./__fixtures__/aparser-serp-flat-live-shape.json", import.meta.url), "utf8"));
  const m = mapAparserSerp(row, 100);
  assert.equal(m.problem, null);
  assert.equal(m.totalCount, "21100000");
  // 9 results, one duplicate URL dropped, positions renumbered without holes
  assert.equal(m.results.length, 8);
  assert.deepEqual(m.results.map(r => r.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(m.results[0].url, "https://site0.gr/page");
  assert.equal(m.results[0].title, "Τίτλος 0");
  assert.equal(m.results[0].snippet, "Snippet 0");
  assert.equal(m.results[3].url, "https://site4.gr/page");
  assert.ok(m.results.every(r => !r.url.includes("google.com/goto")));
  assert.ok(m.features.includes("ai_overview"));
  assert.equal(mapAparserSerp(row, 5).results.length, 5);
  // a list no width explains yields nothing rather than a guess
  assert.deepEqual(serpItems(["https://a.gr/", "https://b.gr/", "x", 1]), []);
  assert.deepEqual(serpItems([]), []);
  // documented object shape still works
  assert.equal(serpItems([{ link: "https://a.gr/", anchor: "A" }]).length, 1);
});

test("links that contradict their titles reject the whole answer (1.2.3640 live pattern)", async () => {
  const { readFileSync } = await import("node:fs");
  const { mapAparserSerp } = await import("../seo/aparserSerp");
  const { classifySnapshot } = await import("./noise");
  const row = JSON.parse(readFileSync(new URL("./__fixtures__/aparser-serp-mismatched-links-live-shape.json", import.meta.url), "utf8"));
  const m = mapAparserSerp(row, 100);
  assert.equal(m.problem, "suspicious_links");
  assert.deepEqual(m.results, []);
  assert.match(String(m.problemDetail), /repeated links 4\/9/);
  assert.match(String(m.problemDetail), /different titles/);
  assert.match(String(m.problemDetail), /app-store links under site titles/);
  // …and the collector files it as failed, i.e. never compared
  assert.deepEqual(classifySnapshot({ rows: [], depth: 100, totalCount: null, providerError: "suspicious_links" }),
    { status: "failed", problem: "suspicious_links" });
});

test("assessSerpIntegrity leaves normal answers alone", async () => {
  const { assessSerpIntegrity } = await import("../seo/aparserSerp");
  const clean = Array.from({ length: 10 }, (_, i) => ({ link: `https://s${i}.gr/`, anchor: `Site ${i}` }));
  assert.equal(assessSerpIntegrity(clean), null);
  // one repeat with the same title among 10 — Google does that across pages
  assert.equal(assessSerpIntegrity([...clean.slice(0, 9), { link: "https://s0.gr/", anchor: "Site 0" }]), null);
  // genuine app listings
  assert.equal(assessSerpIntegrity([
    { link: "https://play.google.com/store/apps/details?id=a", anchor: "NV Casino – Apps on Google Play" },
    { link: "https://apps.apple.com/gr/app/x/id1", anchor: "NV Casino στο App Store" },
    { link: "https://play.google.com/store/apps/details?id=b", anchor: "Slots - Εφαρμογές στο Google Play" },
    ...clean.slice(0, 5),
  ]), null);
  // a single odd store row is not enough on its own
  assert.equal(assessSerpIntegrity([{ link: "https://play.google.com/store/apps/details?id=a", anchor: "Casino review" }, ...clean]), null);
  assert.equal(assessSerpIntegrity([]), null);
  // one link with two different titles is
  assert.match(String(assessSerpIntegrity([...clean, { link: "https://s1.gr/", anchor: "Something else" }])), /different titles/);
});

test("a missing parser preset is told apart from a missing thread config", () => {
  assert.equal(isMissingParserPreset("Preset 'opengcs' not exists"), true);
  assert.equal(isMissingParserPreset("preset opengcs not found"), true);
  assert.equal(isMissingParserPreset("configPreset 'my' not exists"), false);
  assert.equal(isMissingParserPreset("Auth failed"), false);
  assert.equal(isMissingParserPreset(undefined), false);
});

test("the SERP call sends the project's parser preset, default when blank", async () => {
  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ success: 1, data: { results: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const { runSerp } = await import("../seo/serp");
    await runSerp("aparser", "pw", "nv casino", { gl: "gr", hl: "el", num: 10, baseUrl: "http://127.0.0.1:9091", aparserPreset: "opengsc" });
    await runSerp("aparser", "pw", "nv casino", { gl: "gr", hl: "el", num: 10, baseUrl: "http://127.0.0.1:9091", aparserPreset: "  " });
  } finally {
    globalThis.fetch = realFetch;
  }
  const presets = sent.filter((b) => b.action === "oneRequest").map((b) => (b.data as Record<string, unknown>).preset);
  assert.deepEqual(presets.slice(0, 1), ["opengsc"]);
  assert.equal(presets[presets.length - 1], "default");
});

test("a link A-Parser shifted onto the row before a direct link is dropped, its position kept", async () => {
  const { readFileSync } = await import("node:fs");
  const { mapAparserSerp, shiftedGotoRows, serpItems } = await import("../seo/aparserSerp");
  const row = JSON.parse(readFileSync(new URL("./__fixtures__/aparser-serp-goto-shift-live.json", import.meta.url), "utf8"));
  assert.deepEqual([...shiftedGotoRows(serpItems(row.serp))], [4, 8]);
  const m = mapAparserSerp(row, 30);
  assert.equal(m.problem, null, m.problemDetail);
  assert.deepEqual(m.repaired, [5, 9]);
  assert.equal(m.results.length, 18);
  const at = (p: number) => m.results.find((r) => r.position === p);
  assert.equal(at(5), undefined);
  assert.equal(at(6)?.title, "NV Casino - Apps on Google Play");
  assert.equal(at(7)?.domain, "sigma.world");
  assert.equal(at(20)?.domain, "riolasvegas.com");
  // no review title is left pointing at an app listing
  assert.ok(!m.results.some((r) => /play\.google/.test(r.url) && !/app/i.test(r.title)));
});

test("a page with most links shifted is still rejected", async () => {
  const { mapAparserSerp } = await import("../seo/aparserSerp");
  const G = "https://www.google.com/goto?url=CAESx";
  const flat: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    flat.push(`https://play.google.com/store/apps/details?id=a${i}`, `Review site ${i}`, "s", 0, "", "", G);
    flat.push(`https://play.google.com/store/apps/details?id=a${i}`, `App ${i}`, "s", 0, "", "", "");
  }
  const m = mapAparserSerp({ success: 1, totalcount: "100", serp: flat }, 30);
  assert.equal(m.problem, "suspicious_links");
  assert.match(String(m.problemDetail), /mis-resolved/);
});

test("the covered depth of a take with a repaired hole is its last position", async () => {
  const { coveredDepth } = await import("./store");
  assert.equal(coveredDepth([{ position: 1 }, { position: 2 }, { position: 4 }]), 4);
  assert.equal(coveredDepth([{ position: 1 }, { position: 2 }]), 2);
  assert.equal(coveredDepth([]), 0);
});
