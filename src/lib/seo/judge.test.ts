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
function capture(): { ctx: JudgeContext; prompt: () => string; done: () => void } {
  let seen = "";
  const g = globalThis as unknown as { fetch: typeof fetch };
  const real = g.fetch;
  g.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    seen = String(init.body ?? "");
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"verdict":"publish"}' } }] }),
      text: async () => '{"verdict":"publish"}',
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
  assert.equal(p.includes("INTENTIONAL"), true, "the judge was not told placeholders are expected");
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
