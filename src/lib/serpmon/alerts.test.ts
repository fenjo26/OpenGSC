import assert from "node:assert/strict";
import test from "node:test";
import { stormAlertText } from "./alerts";
import type { RunSummary } from "./types";

const run: RunSummary = {
  id: "run1", trigger: "schedule", status: "done",
  startedAt: "2026-09-15T00:00:00.000Z", finishedAt: "2026-09-15T00:10:00.000Z",
  planned: 40, ok: 38, partial: 1, failed: 1, compared: 38,
  volatility: 0.41, volTop10: 0.3, shareHigh: 0.55,
  stormScore: 3.77, storm: true, calibrating: false, error: null,
};

const keywords = ["red query", "orange query", "yellow query", "green query", "blue query", "purple query", "black query"];
const hosts = [
  { host: "host-one.com", enters: 4, exits: 1 },
  { host: "host-two.com", enters: 2, exits: 2 },
  { host: "host-three.com", enters: 1, exits: 3 },
  { host: "host-four.com", enters: 1, exits: 0 },
  { host: "host-five.com", enters: 0, exits: 1 },
  { host: "host-six.com", enters: 0, exits: 1 },
  { host: "host-seven.com", enters: 0, exits: 1 },
];

for (const lang of ["en", "ru"]) {
  test(`stormAlertText (${lang}): project, score with one decimal, the 55% share`, () => {
    const text = stormAlertText(lang, { project: "LatAm casino", run, topKeywords: keywords, topHosts: hosts });
    assert.ok(text.includes("LatAm casino"), "project name");
    assert.ok(text.includes("3.8"), "storm score with 1 decimal");
    assert.ok(text.includes("55%"), "share above usual churn");
  });

  test(`stormAlertText (${lang}): at most 5 keywords and 5 hosts`, () => {
    const text = stormAlertText(lang, { project: "LatAm casino", run, topKeywords: keywords, topHosts: hosts });
    for (const kw of keywords.slice(0, 5)) assert.ok(text.includes(kw), `keyword ${kw}`);
    for (const kw of keywords.slice(5)) assert.ok(!text.includes(kw), `keyword ${kw} must not be listed`);
    for (const h of hosts.slice(0, 5)) assert.ok(text.includes(h.host), `host ${h.host}`);
    for (const h of hosts.slice(5)) assert.ok(!text.includes(h.host), `host ${h.host} must not be listed`);
  });
}

test("stormAlertText: shorter lists are fine", () => {
  const text = stormAlertText("en", {
    project: "Small market", run,
    topKeywords: ["only one kw"],
    topHosts: [{ host: "lonely-host.com", enters: 2, exits: 0 }],
  });
  assert.ok(text.includes("Small market"));
  assert.ok(text.includes("only one kw"));
  assert.ok(text.includes("lonely-host.com"));
});

test("stormAlertText: empty lists do not crash and still carry project and score", () => {
  for (const lang of ["en", "ru", "de", "zh"]) {
    const text = stormAlertText(lang, { project: "Bare project", run, topKeywords: [], topHosts: [] });
    assert.ok(text.includes("Bare project"));
    assert.ok(text.includes("3.8"));
    assert.equal(text.includes("undefined"), false);
  }
});

test("stormAlertText: a run without a storm score does not crash", () => {
  const text = stormAlertText("en", { project: "No score", run: { ...run, stormScore: null, shareHigh: null }, topKeywords: [], topHosts: [] });
  assert.ok(text.includes("No score"));
  assert.equal(text.includes("undefined"), false);
});
