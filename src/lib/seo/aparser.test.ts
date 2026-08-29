import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseBaseUrl, parserResultProblem, redactBaseUrl } from "./aparser";

// Two things are worth testing in this module, and neither is the happy path.
//
// The first is the URL, because it is the only field in the app a user types that the SERVER
// then connects to. The second is `parserResultProblem`, because it is the one place that
// decides whether "A-Parser answered, and the answer was empty" means the search engine said
// zero or means the proxy never got there — and getting that wrong does not raise an error
// anywhere, it just writes a plausible, wrong number into a rank history.

// ─── normaliseBaseUrl ────────────────────────────────────────────────────────

test("the three things people actually paste all mean the same instance", () => {
  const forms = [
    "http://192.168.1.50:9091",
    "http://192.168.1.50:9091/",
    "http://192.168.1.50:9091/API",
    "192.168.1.50:9091",
  ];
  for (const f of forms) {
    const r = normaliseBaseUrl(f);
    assert.ok("url" in r, `${f} was rejected`);
    assert.equal(r.url, "http://192.168.1.50:9091");
  }
});

test("a bare host gets A-Parser's own default port rather than the browser's", () => {
  const r = normaliseBaseUrl("scraper.lan");
  assert.ok("url" in r);
  // Not port 80: nothing about "scraper.lan" says web server, and 9091 is what the product
  // listens on out of the box. A silent :80 would fail with a connection error that names the
  // host and not the reason.
  assert.equal(r.url, "http://scraper.lan:9091");
});

test("https keeps its implicit port instead of gaining 9091", () => {
  const r = normaliseBaseUrl("https://parser.example.com");
  assert.ok("url" in r);
  assert.equal(r.url, "https://parser.example.com");
});

test("credentials in the URL are refused, not quietly stripped", () => {
  // Stripping would produce an authentication failure whose cause is invisible: the user typed
  // a password, the app dropped half of it, and the error talks about the API password instead.
  const r = normaliseBaseUrl("http://admin:hunter2@192.168.1.50:9091");
  assert.ok("problem" in r);
  assert.equal(r.problem, "credentials_in_url");
});

test("non-HTTP schemes and empty input are named separately", () => {
  const ftp = normaliseBaseUrl("ftp://192.168.1.50");
  assert.ok("problem" in ftp);
  assert.equal(ftp.problem, "bad_protocol");

  const blank = normaliseBaseUrl("   ");
  assert.ok("problem" in blank);
  assert.equal(blank.problem, "empty");
});

test("redaction leaves host and port and nothing else", () => {
  assert.equal(redactBaseUrl("http://192.168.1.50:9091"), "192.168.1.50:9091");
  assert.equal(redactBaseUrl("not a url"), "a-parser");
});

// ─── parserResultProblem ─────────────────────────────────────────────────────

test("a normal SERP row passes", () => {
  assert.equal(parserResultProblem({ success: 1, serp: [{ link: "https://a.example" }], totalcount: "1200" }), null);
});

test("an empty SERP with no evidence of a real page is an error, not an empty result", () => {
  // This is the burnt-proxy case. Returning it as "no results" is what makes a rank chart show
  // the whole project dropping out of the top 100 on the day the proxy pool dies.
  assert.equal(parserResultProblem({ success: 1, serp: [] }), "aparser_blocked_or_empty");
});

test("an empty SERP the engine itself reported as zero is a legitimate empty result", () => {
  assert.equal(parserResultProblem({ success: 1, serp: [], totalcount: "0" }), null);
  assert.equal(parserResultProblem({ success: 1, serp: [], totalcount: 0 }), null);
});

test("a per-query failure is caught even though the API envelope said success", () => {
  assert.equal(parserResultProblem({ success: 0, serp: [{ link: "https://a.example" }] }), "aparser_parser_failed");
});

test("content keys are per-parser, so a chat answer is judged on its own fields", () => {
  // FreeAI::ChatGPT has no `serp`; judging it on one would call every successful answer blocked.
  assert.equal(parserResultProblem({ success: 1, answer: "text" }, ["answer", "sources"]), null);
  assert.equal(parserResultProblem({ success: 1, answer: "" }, ["answer", "sources"]), "aparser_blocked_or_empty");
});

test("a missing row is a problem rather than a crash", () => {
  assert.equal(parserResultProblem(null), "aparser_no_result");
  assert.equal(parserResultProblem(undefined), "aparser_no_result");
});

test("a row that only carries resultString counts as empty", () => {
  // The formatted string is never the evidence: it is rendered from the preset's own template,
  // so a non-empty one proves nothing about whether the parse reached a search engine.
  assert.equal(parserResultProblem({ success: 1, serp: [], resultString: "query: nothing\n" }), "aparser_blocked_or_empty");
});
