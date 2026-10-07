import test from "node:test";
import assert from "node:assert/strict";
import { buildRespinPrompt, parseRespinReply, respinPost, type RespinLlm } from "./respin";

// The model is stubbed the way judge.test.ts stubs its provider: the injected fetchLLM
// captures the prompt and returns a canned reply, so these tests pin the PROMPT (the part
// that must not drift) and the parsing (the part that must not publish garbage). No network,
// no credits.

const INPUT = {
  platform: "wordpress",
  sourceTitle: "Athens airport transfer guide",
  sourceMarkdown: "# Athens airport transfer guide\n\nThe fixed rate is **54 EUR**. See [prices](https://money.example.com/prices).",
  projectDomain: "money.example.com",
};

const CREDS = { aiProvider: "openai", aiApiKey: "sk-test", model: "gpt-test" };

const GOOD_REPLY = JSON.stringify({
  title: "Athens airport transfer guide",
  body: "# Athens airport transfer guide\n\nThe fixed rate is **54 EUR**. See [prices](https://money.example.com/prices).",
});

test("the prompt pins facts, structure and the money-site links", () => {
  const p = buildRespinPrompt(INPUT);
  assert.ok(p.includes("money.example.com"), "names the project domain whose links must survive");
  assert.ok(p.includes("PRESERVE all facts"), "facts are pinned");
  assert.ok(p.includes("PRESERVE the heading structure"), "structure is pinned");
  assert.ok(p.includes("[text](url)"), "the link syntax rule is explicit");
  assert.ok(p.includes(INPUT.sourceTitle), "carries the source title");
  assert.ok(p.includes("54 EUR"), "carries the source body");
});

test("wordpress guidance says keep it — it is the money site's own CMS", () => {
  const p = buildRespinPrompt(INPUT);
  assert.ok(p.includes("Keep the text essentially unchanged"), "wordpress must not be re-voiced");
  // The platform is named in the prompt, not just implied by the guidance text.
  assert.ok(p.includes("wordpress"));
});

test("an unknown platform gets the generic adaptation guidance", () => {
  const p = buildRespinPrompt({ ...INPUT, platform: "devto" });
  assert.ok(p.includes("Adapt the post for this platform's audience"), p);
  assert.ok(!p.includes("essentially unchanged"));
});

test("parseRespinReply accepts plain and fenced JSON", () => {
  const plain = parseRespinReply(GOOD_REPLY);
  assert.equal(plain?.title, "Athens airport transfer guide");
  assert.ok(plain?.body.includes("54 EUR"));
  const fenced = parseRespinReply("```json\n" + GOOD_REPLY + "\n```");
  assert.equal(fenced?.title, plain?.title);
  const withProse = parseRespinReply(`Here you go:\n${GOOD_REPLY}\nHope that helps.`);
  assert.equal(withProse?.body, plain?.body);
});

test("parseRespinReply rejects what must never be published as a respin", () => {
  assert.equal(parseRespinReply(null), null, "no reply at all");
  assert.equal(parseRespinReply(""), null);
  assert.equal(parseRespinReply("no json here at all"), null, "prose without JSON");
  // A stub body is the failure mode that must not pass: the model "summarized" instead of
  // adapting, and publishing it would silently replace the article with a summary.
  assert.equal(parseRespinReply(JSON.stringify({ title: "t", body: "too short" })), null);
  assert.equal(parseRespinReply(JSON.stringify({ title: "no body field" })), null);
});

test("respinPost returns the parsed adaptation and passes creds through", async () => {
  let seen: { prompt: string; provider: string; key: string; model?: string } | null = null;
  const llm: RespinLlm = async (prompt, provider, apiKey, _maxTokens, model) => {
    seen = { prompt, provider, key: apiKey, model };
    return GOOD_REPLY;
  };
  const out = await respinPost(INPUT, CREDS, llm);
  assert.equal(out.title, "Athens airport transfer guide");
  assert.ok(out.body.includes("[prices](https://money.example.com/prices)"), "the money-site link survived");
  assert.equal(seen!.provider, "openai");
  assert.equal(seen!.key, "sk-test");
  assert.equal(seen!.model, "gpt-test");
  assert.ok(seen!.prompt.includes("Athens airport transfer guide"));
});

test("respinPost throws honest errors for no key, empty reply, unparseable reply", async () => {
  const ok: RespinLlm = async () => GOOD_REPLY;
  await assert.rejects(
    () => respinPost(INPUT, { aiProvider: "openai", aiApiKey: "" }, ok),
    /no_ai_creds/,
  );
  await assert.rejects(
    () => respinPost(INPUT, CREDS, async () => null),
    /respin_no_reply/,
  );
  await assert.rejects(
    () => respinPost(INPUT, CREDS, async () => "I could not adapt this one, sorry."),
    /respin_unparseable/,
  );
});

test("the token budget scales with the source length", async () => {
  const budgets: number[] = [];
  const capture: RespinLlm = async (_p, _pr, _k, maxTokens) => { budgets.push(maxTokens); return GOOD_REPLY; };
  await respinPost(INPUT, CREDS, capture);
  await respinPost({ ...INPUT, sourceMarkdown: "word ".repeat(4000).trim() }, CREDS, capture);
  // Same words×8 rule the writer uses, capped for the cheap slot — a long article gets room,
  // but never the writer's full 32k ceiling.
  assert.ok(budgets[0] >= 1024, "floor");
  assert.ok(budgets[1] > budgets[0], "scales with source length");
  assert.ok(budgets[1] <= 16_000, "capped");
});
