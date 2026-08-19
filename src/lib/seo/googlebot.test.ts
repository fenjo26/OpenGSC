import assert from "node:assert/strict";
import test from "node:test";
import { diffViews, parseSeoSignals, type ViewResult } from "./googlebot";

// Minimal ViewResult factory — only the fields diffViews actually reads.
function view(p: Partial<ViewResult> & { bodyText: string }): ViewResult {
  const words = p.bodyText.split(/\s+/).filter(Boolean).length;
  return {
    ua: "test",
    ok: true,
    hops: [],
    finalUrl: "https://example.com/",
    finalStatus: 200,
    headers: {},
    signals: { hreflang: [], title: "", jsRedirects: [], indexable: true, indexableReasons: [] },
    bodyHash: "",
    wordCount: words,
    htmlRaw: "",
    ...p,
    bodyText: p.bodyText,
  };
}

const ARTICLE = Array.from({ length: 45 }, (_, i) =>
  `paragraph ${i} about licensed operators payout rates and responsible play in canada`).join(" ");

test("Cloudflare email obfuscation alone is not cloaking", () => {
  // The exact shape that produced six false "bot-only" findings in a competing tool: the crawler
  // gets the address, the browser gets Cloudflare's placeholder. Identical page otherwise.
  const gb = view({ bodyText: `${ARTICLE} contact support@example.com for help` });
  const br = view({ bodyText: `${ARTICLE} contact [email protected] for help` });

  const d = diffViews(gb, br, { noiseFloor: 0 });
  assert.equal(d.verdict, "clean");
  assert.equal(d.score, 0);
  assert.equal(d.similarity, 1);
});

test("drift within the page's own measured variance is not charged", () => {
  // Page rotates one line per request. The baseline fetches measured that same rotation, so the
  // bot-vs-user delta carries no information the noise floor doesn't already explain.
  const gb = view({ bodyText: `${ARTICLE} featured game today is diamond rush jackpot` });
  const br = view({ bodyText: `${ARTICLE} featured game today is golden temple jackpot` });

  const measuredNoise = 1 - (gb.bodyText === br.bodyText ? 1 : diffViews(gb, br, { noiseFloor: 0 }).similarity!);
  const withoutFloor = diffViews(gb, br, { noiseFloor: 0 });
  const withFloor = diffViews(gb, br, { noiseFloor: measuredNoise });

  assert.ok(withoutFloor.score > 0, "a bare comparison does flag the rotation");
  assert.equal(withFloor.score, 0, "once the page's own variance is known, it stops being evidence");
  assert.equal(withFloor.verdict, "clean");
});

test("a swapped page is still caught with the noise floor applied", () => {
  const gb = view({ bodyText: ARTICLE });
  const br = view({ bodyText: Array.from({ length: 45 }, (_, i) => `line ${i} claim five thousand bonus two hundred free spins now`).join(" ") });

  // Even granting an implausibly noisy page, a full content swap clears the floor.
  const d = diffViews(gb, br, { noiseFloor: 0.3 });
  assert.ok(d.score >= 20, `expected a real signal, got ${d.score}`);
  assert.notEqual(d.verdict, "clean");
});

test("a device-template difference is not charged as an audience difference", () => {
  const mobileCopy = `${ARTICLE} tap to open the app menu`;
  const desktopCopy = `${ARTICLE} use the sidebar to browse all categories and providers`;
  const gb = view({ bodyText: mobileCopy });            // Googlebot smartphone → mobile template
  const desktopBrowser = view({ bodyText: desktopCopy }); // default browser view → desktop template
  const mobileBrowser = view({ bodyText: mobileCopy });   // control: a real mobile browser

  const withoutControl = diffViews(gb, desktopBrowser, { noiseFloor: 0 });
  const withControl = diffViews(gb, desktopBrowser, { noiseFloor: 0, deviceControl: mobileBrowser });

  assert.ok(withoutControl.score > 0);
  assert.equal(withControl.score, 0);
});

test("a redirect served only to one side is cloaking; the same redirect for both is a doorway note", () => {
  const withJs = (target: string) => ({ hreflang: [], title: "", jsRedirects: [target], indexable: true, indexableReasons: [] });

  const oneSided = diffViews(
    view({ bodyText: ARTICLE, signals: withJs("https://example.com/maf/") }),
    view({ bodyText: ARTICLE }),
  );
  assert.ok(oneSided.score >= 25);
  assert.notEqual(oneSided.verdict, "clean");

  const bothSides = diffViews(
    view({ bodyText: ARTICLE, signals: withJs("https://example.com/maf/") }),
    view({ bodyText: ARTICLE, signals: withJs("https://example.com/maf/") }),
  );
  // Not cloaking — but the indexed URL is not where a visitor lands, and that must not vanish.
  assert.equal(bothSides.verdict, "clean");
  assert.equal(bothSides.score, 0);
  assert.match(bothSides.notes?.join(" ") ?? "", /\/maf\//);
});

test("different final hosts outweigh everything else", () => {
  const d = diffViews(
    view({ bodyText: ARTICLE, finalUrl: "https://example.com/" }),
    view({ bodyText: ARTICLE, finalUrl: "https://offer.partner-track.net/land" }),
  );
  assert.equal(d.verdict, "cloaking");
  assert.ok(d.score >= 50);
});

test("one JS redirect written across several branches is one finding, not five", () => {
  const html = `<html><body><script>
    if (a) { window.location = "/maf/"; }
    else if (b) { location.href = "/maf/"; }
    else { location.replace("/maf/"); }
  </script></body></html>`;
  assert.deepEqual(parseSeoSignals("https://example.com/", html).jsRedirects, ["https://example.com/maf/"]);
});
