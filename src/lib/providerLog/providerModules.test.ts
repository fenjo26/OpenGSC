// Every module that talks to a paid provider must talk to it through `loggedFetch`.
//
// This is a coverage test, not a behaviour one, and it exists because the failure it guards
// against is silent: a call that skips the logger writes no row, raises nothing, and shows up
// only as money spent that the log cannot account for. Nothing else in the suite can see that.
//
// It is an ENUMERATION, maintained by hand, and that is the point rather than a shortcut. A tree
// scan over `src/lib` and `src/app/api` would match `fetch(` in comments, in strings, and in the
// many legitimate unpaid calls this app makes — crawling a customer's own site, asking our own
// API — so it would fail the build for reasons that are not bugs, and the first response to that
// would be to weaken it. Listing the modules instead means **adding a provider means adding a
// line here, and that is the moment someone decides whether it is a paid call.**
//
// Comments are stripped before the check so the word `fetch(` inside prose is not an offender,
// and so a call commented out is not one either.
//
// A module on this list may still hold an outbound call that nobody is billed for — the Wayback
// index is the live example. Mark that exact line with `providerLog-exempt:` in a `//` comment
// and say why; the line is then ignored. The marker has to be on the calling line, so the
// justification sits where the decision is, not in a table someone reads years later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The modules that talk to a paid provider, and which providers each one reports.
 *
 * The provider names are here because they are the other half of the decision: adding a line
 * means naming the account that gets billed, and a module whose provider nobody can name is a
 * module nobody has checked.
 */
const PROVIDER_MODULES: { file: string; providers: string }[] = [
  { file: "src/lib/llm.ts", providers: "anthropic, openai, gemini, openrouter, zai, deepseek, qwen, kimi, cheaperinference, kie, custom" },
  { file: "src/lib/seo/serp.ts", providers: "serper, dataforseo, scrapingrobot" },
  { file: "src/lib/seo/goanyapi.ts", providers: "goanyapi" },
  { file: "src/lib/seo/geo.ts", providers: "gemini, openai, kie" },
  { file: "src/lib/seo/contentAnalysis.ts", providers: "dataforseo" },
  { file: "src/lib/seo/googlebot.ts", providers: "firecrawl" },
  { file: "src/lib/seo/backlinksApi.ts", providers: "ahrefs" },
  { file: "src/lib/seo/metrics.ts", providers: "ahrefs, semrush" },
  { file: "src/lib/seo/demand.ts", providers: "dataforseo" },
  { file: "src/lib/seo/aeo.ts", providers: "openai, perplexity, anthropic, xai" },
  { file: "src/lib/seo/llmMentions.ts", providers: "dataforseo" },
  { file: "src/lib/seo/kieImages.ts", providers: "kie" },
  { file: "src/lib/seo/zaiImages.ts", providers: "zai" },
  { file: "src/app/api/seo/models/route.ts", providers: "anthropic, zai, openai, openrouter, cheaperinference, gemini, kimi, deepseek" },
  { file: "src/app/api/linkwatch/run/route.ts", providers: "ahrefs" },
  { file: "src/app/api/indexing/neural/route.ts", providers: "neuralindexer" },
  { file: "src/app/api/indexing/neural/check/route.ts", providers: "neuralindexer" },
  { file: "src/app/api/indexing/neural/status/route.ts", providers: "neuralindexer" },
  { file: "src/app/api/indexing/submit/route.ts", providers: "2index" },
  { file: "src/app/api/indexing/xmlriver/route.ts", providers: "xmlriver" },
  { file: "src/app/api/backlinks/check-xr/route.ts", providers: "xmlriver" },
  { file: "src/app/api/settings/api-keys/validate/route.ts", providers: "xmlriver" },
];


// A-Parser (`src/lib/seo/aparser.ts`, `src/lib/seo/geoAparser.ts`) is absent because it is
// self-hosted: the calls go to the user's own machine and nobody is billed for them, so there is
// no spend for a row to account for. If that ever changes — a hosted instance, a metered build —
// they belong on the list above like anything else.
//
// `src/lib/seo/scrape.ts` is deliberately absent. Its Firecrawl calls ARE wrapped, but most of
// its fetches are of the customer's own target websites: holding the whole file to this rule
// would demand logging a crawl as a provider call and fill the table with the thing it is not
// about. `geoClient.ts`, `jobs.ts` and `history.ts` are absent for the mirror-image reason —
// they call our own API, not a provider.

const EXEMPT_MARKER = /\/\/[^\n]*providerLog-exempt:/;

/**
 * A call to the global `fetch`, and not to something whose name merely ends in it.
 *
 * The leading class rules out `loggedFetch(`, `safeFetch(` and any `x.fetch(` method call; a
 * bare `fetch(` at the start of a line is matched by the `^` alternative.
 */
const BARE_FETCH = /(^|[^A-Za-z0-9_.$])fetch\s*\(/;

/**
 * The same call reached through the global object, which the rule above cannot see.
 *
 * Excluding every `x.fetch(` is what keeps a genuine method call — a client object with its own
 * fetch — from failing the build, and it is also a hole: `globalThis.fetch(` and `window.fetch(`
 * are the global function under another name and would have sailed straight through. These four
 * identifiers are not objects that happen to have a `fetch` method; they ARE the global object,
 * so naming them explicitly closes the hole without reopening the false positives.
 */
const GLOBAL_FETCH = /\b(?:globalThis|window|self|global)\s*\.\s*fetch\s*\(/;

const isDirectFetch = (line: string): boolean => BARE_FETCH.test(line) || GLOBAL_FETCH.test(line);

/**
 * Strip comments, keeping the line count intact so an offender can be reported by line.
 *
 * Block comments collapse to spaces rather than disappearing. Line comments are stripped only
 * where the `//` is not preceded by a colon, because `"https://…"` inside a call argument is not
 * a comment and blanking the rest of that line would hide the call that follows it.
 */
function codeLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (EXEMPT_MARKER.test(line) ? "" : line.replace(/(^|[^:])\/\/.*$/, "$1")));
}

function directFetchesIn(file: string): string[] {
  const out: string[] = [];
  codeLines(readFileSync(file, "utf8")).forEach((line, i) => {
    if (isDirectFetch(line)) out.push(`${file}:${i + 1}  ${line.trim()}`);
  });
  return out;
}

test("every provider module goes through the logger", () => {
  const offenders = PROVIDER_MODULES.flatMap(m => directFetchesIn(m.file));
  assert.deepEqual(
    offenders, [],
    `these still call fetch directly — wrap them in loggedFetch, or mark the line ` +
    `"providerLog-exempt: <why>" if nobody is billed for it:\n${offenders.join("\n")}`,
  );
});

test("the enumeration itself is checkable", () => {
  // Every listed path must exist. A rename that silently drops a module off the list is the one
  // way this test can pass while covering less than it says it does.
  for (const { file, providers } of PROVIDER_MODULES) {
    assert.doesNotThrow(() => readFileSync(file, "utf8"), `${file} is listed but unreadable`);
    assert.ok(providers.trim().length > 0, `${file} is listed with no provider named`);
  }
});

test("the scanner sees a real call and ignores the things that look like one", () => {
  // Pinned because every assertion above depends on it, and a scanner that matched nothing would
  // report a clean list forever.
  const seen = (src: string) => codeLines(src).some(isDirectFetch);

  assert.equal(seen("const r = await fetch(url);"), true);
  assert.equal(seen("fetch(url);"), true);
  assert.equal(seen('await fetch("https://api.example.com/v1", init);'), true, "a URL is not a comment");
  assert.equal(seen("const r = await globalThis.fetch(url);"), true, "the global under another name");
  assert.equal(seen("const r = await window.fetch(url);"), true, "and another");

  assert.equal(seen("const r = await loggedFetch(url, init, o);"), false);
  assert.equal(seen("const r = await safeFetch(url, init);"), false);
  assert.equal(seen("const r = await client.fetch(url);"), false);
  assert.equal(seen("// we used to await fetch(url) here"), false);
  assert.equal(seen("/*\n * await fetch(url)\n */"), false);
  assert.equal(seen("await fetch(url); // providerLog-exempt: free index lookup"), false);
});
