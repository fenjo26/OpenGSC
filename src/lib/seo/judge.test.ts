import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeArticle, judgeOutline, type JudgeContext } from "./judge";

// The judge is a model call, so what is testable here is the PROMPT it sends — and that is the
// part that broke things. Two rules in it fight the rest of the pipeline:
//
//   • the writing prompts REQUIRE square-bracket placeholders where real data is missing, and the
//     mechanics gate re-inserts a dropped [[WIDGET]] immediately before the judge runs — while
//     the judge's first reject criterion is "not an article (planning notes, scratch)";
//   • the author's instruction routinely REMOVES a section on purpose, and the judge's main
//     rejection is "does not cover what the query asks for".
//
// Both end the same way: a correct, paid result thrown away for being correct. These assert the
// prompt says otherwise. The provider is stubbed, so no network and no credits.

/** Captures the prompt instead of calling a provider. Restore with the returned `done`. */
function capture(reply = '{"verdict":"publish"}'): { ctx: JudgeContext; prompt: () => string; done: () => void } {
  let seen = "";
  const g = globalThis as unknown as { fetch: typeof fetch };
  const real = g.fetch;
  g.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    seen = String(init.body ?? "");
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: reply } }] }),
      text: async () => reply,
    } as unknown as Response;
  }) as typeof fetch;
  return {
    ctx: { provider: "openai", apiKey: "sk-test", model: "gpt-test" },
    prompt: () => seen,
    done: () => { g.fetch = real; },
  };
}

test("the article judge is told square-bracket placeholders are deliberate", async () => {
  const c = capture();
  await judgeArticle("# T\n\n## S\n\nBook here: [[TRANSFER_WIDGET]]\n\n[ЗАПОЛНИТЬ ВРУЧНУЮ: лицензия]", c.ctx, { language: "en" });
  const p = c.prompt();
  c.done();
  assert.equal(p.includes("ALWAYS ") && p.includes("intentional"), true, "the judge was not told placeholders are expected");
  assert.equal(p.includes("[[NAME]]"), true);
});

test("the article judge is told which omissions the author asked for", async () => {
  const c = capture();
  await judgeArticle("# T\n\n## S\n\nbody", c.ctx, {
    language: "en", constraints: "Do not give the reverse route its own section.",
  });
  const p = c.prompt();
  c.done();
  assert.equal(p.includes("Do not give the reverse route its own section."), true);
  assert.equal(p.includes("deliberate"), true);
});

test("the article judge stays silent about constraints when there are none", async () => {
  const c = capture();
  await judgeArticle("# T\n\n## S\n\nbody", c.ctx, { language: "en" });
  const p = c.prompt();
  c.done();
  assert.equal(p.includes("The author imposed these constraints"), false);
});

test("the outline judge is told which sections were excluded on purpose", async () => {
  const c = capture();
  await judgeOutline(
    { meta: {}, sections: [{ h_level: "H2", heading: "Getting there" }], faq: [] },
    c.ctx,
    { keyword: "piraeus to athens airport", language: "en", constraints: "No section about the reverse direction." },
  );
  const p = c.prompt();
  c.done();
  assert.equal(p.includes("No section about the reverse direction."), true);
  assert.equal(p.includes("not a coverage gap"), true);
});

// ─── The structural fix: uncertainty has somewhere to go that is not the bin ──────────

test("a soft finding is reported and the result still ships", async () => {
  const c = capture('{"verdict":"publish","concerns":["an odd bracketed token in section 3"]}');
  const out = await judgeArticle("# T\n\n## S\n\nbody", c.ctx, { language: "en" });
  c.done();
  assert.equal(out.verdict, "publish");
  assert.deepEqual(out.concerns, ["an odd bracketed token in section 3"]);
});

test("a reject with a named blocker still fails the result", async () => {
  const c = capture('{"verdict":"reject","blockers":["ends mid-sentence"]}');
  const out = await judgeArticle("# T\n\n## S\n\nbody that stops", c.ctx, { language: "en" });
  c.done();
  assert.equal(out.verdict, "reject");
  assert.deepEqual(out.blockers, ["ends mid-sentence"]);
});

test("a reject that names no defect does not destroy the work", async () => {
  // The failure this guards is a paid article discarded on a verdict the reviewer declined to
  // justify. The doubt is kept — as a concern — and the article survives.
  const c = capture('{"verdict":"reject","blockers":[]}');
  const out = await judgeArticle("# T\n\n## S\n\nbody", c.ctx, { language: "en" });
  c.done();
  assert.equal(out.verdict, "publish");
  assert.equal(out.concerns?.some(x => /named no specific defect/.test(x)), true);
});

test("the judges are told that unrecognised is not the same as broken", async () => {
  const a = capture();
  await judgeArticle("# T\n\n## S\n\nbody", a.ctx, { language: "en" });
  const ap = a.prompt(); a.done();
  const o = capture();
  await judgeOutline({ meta: {}, sections: [{ h_level: "H2", heading: "H" }], faq: [] }, o.ctx, { keyword: "k" });
  const op = o.prompt(); o.done();
  // The rule that stops the next deliberate artifact becoming a silently failed job. It must be
  // in BOTH prompts — patching one judge is how this became a recurring bug in the first place.
  for (const [name, p] of [["article", ap], ["outline", op]] as const) {
    assert.equal(p.includes("CONCERN, not a blocker"), true, `${name} judge may still reject what it merely does not recognise`);
    assert.equal(p.includes("Never reject without naming the blocker"), true, `${name} judge may still reject without a reason`);
  }
});
