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
export interface JudgeOutcome {
  verdict: JudgeVerdict;
  /** Objective, unambiguous failures. These and only these fail the result. */
  blockers?: string[];
  /**
   * Everything the reviewer found questionable but could not be certain about — including
   * anything it does not recognise. Reported, never fatal.
   *
   * This split is the fix for a structural fault, not a nicety. The judge is fresh-context by
   * design: it has seen none of the prompts that produced the work, so it cannot distinguish
   * "this is broken" from "I do not know why this is here". With one verdict those collapsed
   * into the same output, and that output DESTROYED a finished, paid result. Twice in one week
   * that meant the pipeline rejecting itself for doing exactly what it was told — once over the
   * [ЗАПОЛНИТЬ ВРУЧНУЮ] markers its own writing prompt requires, once over a section the
   * author's instruction had deliberately removed. Each was patched by telling the judge about
   * that one artifact, which does not scale: the next deliberate artifact fails the same way,
   * silently, and the only symptom is a job that costs money and returns nothing.
   *
   * So uncertainty now has somewhere to go that is not the bin. A judge that cannot explain
   * something says so, the caller sees it, and the work survives.
   */
  concerns?: string[];
}

const stripToJson = (raw: string) => raw.trim().replace(/^[^{]*/, "").replace(/[^}]*$/, "");

const strList = (v: unknown) => (Array.isArray(v) ? v : []).map(String).map(x => x.trim()).filter(Boolean).slice(0, 5);

async function callJudge(prompt: string, ctx: JudgeContext): Promise<JudgeOutcome> {
  try {
    const raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 900, ctx.model, ctx.baseUrl);
    const j = JSON.parse(stripToJson((raw ?? "").replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "")));
    const concerns = strList(j?.concerns);
    const blockers = strList(j?.blockers);
    // The verdict is DERIVED from the blockers rather than trusted from the model. A reviewer
    // that returns "reject" with an empty blocker list is asking for work to be destroyed for a
    // reason it declined to name; that is a concern, and the result ships.
    if (j?.verdict === "reject" && blockers.length) {
      return { verdict: "reject", blockers, ...(concerns.length ? { concerns } : {}) };
    }
    if (j?.verdict === "reject" || j?.verdict === "publish") {
      const soft = j?.verdict === "reject" ? [...concerns, "the reviewer voted to reject but named no specific defect"] : concerns;
      return { verdict: "publish", ...(soft.length ? { concerns: soft.slice(0, 6) } : {}) };
    }
    return { verdict: "unavailable" };
  } catch {
    return { verdict: "unavailable" };
  }
}

/**
 * The one place that describes what a fresh reviewer will not recognise.
 *
 * Every pipeline on this instance deliberately emits things that look wrong out of context.
 * Rather than adding a line here each time one is invented — which is what failed — the rule is
 * stated as a category plus a default: unrecognised is not the same as broken.
 */
const DELIBERATE_ARTIFACTS =
  `This text was produced by a pipeline that deliberately emits some things a reviewer reading it ` +
  `cold would not recognise. Square-bracket markers are the clearest example and are ALWAYS ` +
  `intentional: [[NAME]] tokens are the author's own placeholders (a booking widget, a form), and ` +
  `[SOMETHING IN BRACKETS] marks a spot the pipeline was instructed to leave for manual completion ` +
  `instead of inventing a fact. They are part of the deliverable.\n` +
  `More generally: you cannot see the instructions this was written from, so you cannot tell a ` +
  `defect from a deliberate choice you were not told about. When you are not certain which one ` +
  `you are looking at, it is a CONCERN, not a blocker. Blockers are only for the objective ` +
  `failures listed above — things that are wrong no matter what anyone asked for.\n`;

/** Shared JSON contract. Blockers fail the result; concerns are reported and it ships. */
const VERDICT_FORMAT =
  `Return STRICT JSON, nothing else:\n` +
  `{"verdict":"publish","concerns":["..."]} — usable. Put anything you found questionable but ` +
  `cannot be sure about in "concerns" (omit the field if there is nothing).\n` +
  `{"verdict":"reject","blockers":["short reason"],"concerns":["..."]} — only when at least one ` +
  `objective failure above genuinely holds. Never reject without naming the blocker.\n`;

/**
 * Article judge — for the rewrite and text pipelines. The question is deliberately narrow:
 * completeness and publishability, never style or SEO quality (those are the writer's job and
 * a matter of taste; a judge with opinions rejects good work).
 */
export function judgeArticle(
  draft: string,
  ctx: JudgeContext,
  opts: { sourceExcerpt?: string; language?: string; constraints?: string } = {},
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
  // The author's own rules. "The structure does not cover X" is the wrong verdict when the author
  // explicitly said not to cover X — this names what was deliberate without revealing how the
  // article was written, so the judge stays independent on everything else.
  const constraintLine = opts.constraints?.trim()
    ? `\nThe author imposed these constraints on this page. Anything absent BECAUSE of them is ` +
      `deliberate and is not an omission — judge completeness within them:\n${opts.constraints.trim().slice(0, 2000)}\n`
    : "";
  return callJudge(
    `You are a strict QA reviewer. A tool generated a web article; below is the finished draft ` +
    `that is about to be saved as a completed result. Decide whether it is a COMPLETE, PUBLISHABLE article.\n\n` +
    `These are the OBJECTIVE FAILURES — the only things that may be blockers:\n` +
    `- it is not an article at all (planning notes, number lists, scratch, JSON, an outline)\n` +
    `- it is truncated (ends mid-sentence or mid-word) or clearly missing sections it announced\n` +
    `${furnitureLine}` +
    `- it contains the generator's own self-check or planning lines (word counts, section budgets)\n` +
    `- it is written in a different language than required\n\n` +
    `Do NOT judge style, quality or SEO — only completeness and publishability.\n` +
    `${DELIBERATE_ARTIFACTS}${constraintLine}` +
    `${langLine}${VERDICT_FORMAT}\n` +
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
  opts: { keyword: string; language?: string; country?: string; constraints?: string },
): Promise<JudgeOutcome> {
  const secs = Array.isArray(outline?.sections) ? outline.sections : [];
  const compact = {
    meta: outline?.meta ?? {},
    headings: secs.map((s: any) => ({ level: s?.h_level, heading: s?.heading, words: s?.word_count })),
    faq: Array.isArray(outline?.faq) ? outline.faq.map((f: any) => f?.question ?? f) : [],
  };
  const langLine = opts.language ? `The headings must be in: ${opts.language}. ` : "";
  // "The structure does not cover what the query asks for" is the outline judge's main rejection,
  // and it is the wrong one when the author's own rules removed the section it is looking for.
  // Without this an outline is rejected precisely for obeying the instruction — and a rejected
  // outline job is paid work discarded.
  const constraintLine = opts.constraints?.trim()
    ? `\nThe author imposed these constraints on this outline. A section missing BECAUSE of them is ` +
      `deliberate, not a coverage gap — judge completeness within them:\n${opts.constraints.trim().slice(0, 2000)}\n`
    : "";
  return callJudge(
    `You are a strict QA reviewer for SEO article outlines. An outline was generated for the ` +
    `search query "${opts.keyword}"${opts.country ? ` (market: ${opts.country})` : ""}. Below is its ` +
    `structure as compact JSON. Decide whether it is a COMPLETE, USABLE outline.\n\n` +
    `These are the OBJECTIVE FAILURES — the only things that may be blockers:\n` +
    `- headings are unrelated to the query, or the structure does not cover what the query asks for\n` +
    `- duplicate or near-duplicate sections\n` +
    `- obviously too thin for a real article (a couple of headings and nothing else)\n` +
    `- headings in the wrong language (${langLine}reject otherwise)\n\n` +
    `Do NOT judge wording style or keyword placement — only structural completeness and coverage.\n` +
    `${DELIBERATE_ARTIFACTS}${constraintLine}` +
    `${VERDICT_FORMAT}\n` +
    `OUTLINE STRUCTURE:\n${JSON.stringify(compact).slice(0, 12000)}`,
    ctx,
  );
}
