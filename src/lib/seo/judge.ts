// Independent QA judge — the shared "should this be saved?" call for every content pipeline.
//
// The rewrite pipeline shipped two "completed" results that were not articles at all (85
// words of the model's planning notes; a 94-word stub that copied a booking form and stopped
// mid-sentence), and the text pipeline shipped one with its own volume-check notes inside the
// article. Every measurement in those pipelines assumes it is looking at the artifact it
// expects; the judge is the one check that does not assume — a fresh-context model call that
// answers a single question about the finished artifact.
//
// Verdicts:
//   publish      — save it.
//   reject       — fail the result with the blockers; the caller must NOT save it as completed.
//   unavailable  — the judge CALL itself failed (network, provider). Infra flakiness must not
//                  burn a finished, paid generation, so the caller ships and reports the state.
//
// One judge, two question shapes: articles (rewrite, text) get publishability; outlines get
// structural completeness — a bad outline poisons everything downstream of it, and JSON that
// parses is not JSON that covers the keyword.

import { fetchLLM } from "@/lib/llm";

export interface JudgeContext {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export type JudgeVerdict = "publish" | "reject" | "unavailable";
export interface JudgeOutcome { verdict: JudgeVerdict; blockers?: string[] }

const stripToJson = (raw: string) => raw.trim().replace(/^[^{]*/, "").replace(/[^}]*$/, "");

async function callJudge(prompt: string, ctx: JudgeContext): Promise<JudgeOutcome> {
  try {
    const raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 700, ctx.model, ctx.baseUrl);
    const j = JSON.parse(stripToJson((raw ?? "").replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "")));
    if (j?.verdict === "reject") {
      return { verdict: "reject", blockers: (Array.isArray(j.blockers) ? j.blockers : []).map(String).slice(0, 5) };
    }
    if (j?.verdict === "publish") return { verdict: "publish" };
    return { verdict: "unavailable" };
  } catch {
    return { verdict: "unavailable" };
  }
}

/**
 * Article judge — for the rewrite and text pipelines. The question is deliberately narrow:
 * completeness and publishability, never style or SEO quality (those are the writer's job and
 * a matter of taste; a judge with opinions rejects good work).
 */
export function judgeArticle(
  draft: string,
  ctx: JudgeContext,
  opts: { sourceExcerpt?: string; language?: string } = {},
): Promise<JudgeOutcome> {
  const sourceBlock = opts.sourceExcerpt
    ? `\n\nSOURCE (first 4000 characters, for comparison):\n${opts.sourceExcerpt.slice(0, 4000)}`
    : "";
  // With a source present this is a REWRITE: fidelity is the contract, so furniture the source
  // itself contains (the site's own CTA buttons, booking blocks the scraper kept) is not a
  // blocker — the rewriter was told to preserve the source. Only furniture the draft introduced
  // on its own is a rejection. Without a source this is a generated article: the strict rule
  // below applies in full.
  const furnitureLine = opts.sourceExcerpt
    ? `- it introduces page furniture (menus, form confirmations, buttons) that does NOT appear in the source\n`
    : `- it copies page furniture (menus, booking/contact-form confirmations, thank-you messages, buttons)\n`;
  const langLine = opts.language ? `The article must be written in: ${opts.language}. Reject if it is in another language.\n` : "";
  return callJudge(
    `You are a strict QA reviewer. A tool generated a web article; below is the finished draft ` +
    `that is about to be saved as a completed result. Decide whether it is a COMPLETE, PUBLISHABLE article.\n\n` +
    `Reject it if ANY of these hold:\n` +
    `- it is not an article at all (planning notes, number lists, scratch, JSON, an outline)\n` +
    `- it is truncated (ends mid-sentence or mid-word) or clearly missing sections it announced\n` +
    `${furnitureLine}` +
    `- it contains the generator's own self-check or planning lines (word counts, section budgets)\n` +
    `- it is written in a different language than required\n\n` +
    `Do NOT judge style, quality or SEO — only completeness and publishability.\n` +
    `${langLine}Return STRICT JSON, nothing else: {"verdict":"publish"} or {"verdict":"reject","blockers":["short reason", "..."]}\n\n` +
    `DRAFT (full):${sourceBlock ? "" : "\n"}${draft}${sourceBlock}`,
    ctx,
  );
}

/**
 * Outline judge — for the outline pipeline. A parsed outline can still be structurally hollow:
 * headings unrelated to the keyword, duplicated sections, empty guidance. The judge sees a
 * COMPACT view (meta + headings + FAQ), never the facts bank — the bank is reference material,
 * not structure, and sending it would both cost tokens and tempt the judge to review facts.
 */
export function judgeOutline(
  outline: any,
  ctx: JudgeContext,
  opts: { keyword: string; language?: string; country?: string },
): Promise<JudgeOutcome> {
  const secs = Array.isArray(outline?.sections) ? outline.sections : [];
  const compact = {
    meta: outline?.meta ?? {},
    headings: secs.map((s: any) => ({ level: s?.h_level, heading: s?.heading, words: s?.word_count })),
    faq: Array.isArray(outline?.faq) ? outline.faq.map((f: any) => f?.question ?? f) : [],
  };
  const langLine = opts.language ? `The headings must be in: ${opts.language}. ` : "";
  return callJudge(
    `You are a strict QA reviewer for SEO article outlines. An outline was generated for the ` +
    `search query "${opts.keyword}"${opts.country ? ` (market: ${opts.country})` : ""}. Below is its ` +
    `structure as compact JSON. Decide whether it is a COMPLETE, USABLE outline.\n\n` +
    `Reject it if ANY of these hold:\n` +
    `- headings are unrelated to the query, or the structure does not cover what the query asks for\n` +
    `- duplicate or near-duplicate sections\n` +
    `- obviously too thin for a real article (a couple of headings and nothing else)\n` +
    `- headings in the wrong language (${langLine}reject otherwise)\n\n` +
    `Do NOT judge wording style or keyword placement — only structural completeness and coverage.\n` +
    `Return STRICT JSON, nothing else: {"verdict":"publish"} or {"verdict":"reject","blockers":["short reason", "..."]}\n\n` +
    `OUTLINE STRUCTURE:\n${JSON.stringify(compact).slice(0, 12000)}`,
    ctx,
  );
}
