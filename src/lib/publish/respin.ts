// Respin — one structured AI call that adapts a finished post for one publishing platform.
//
// This is an ADAPTATION, not a rewrite: the contract (below) pins facts, structure and links,
// because the published post is about to become a donor page for the money site — a respin
// that silently dropped the link or "improved" a price would sabotage the exact loop this
// wave exists to feed. Platforms that need no adaptation (WordPress is the money site itself)
// get guidance that says keep it essentially as-is, so the model polishes at most.
//
// Credentials resolve on the "respin" task slot (lib/seo/keys.ts union, Settings → per-task
// AI): the call is small and mechanical, so a user running an expensive writer for `text`
// can point respin at a cheap model without touching anything else. The caller resolves and
// passes creds in — the UI route reads the server-side settings snapshot via
// resolveAiCreds(userId, {}, "respin") exactly like the drops-history route does for its own
// cheap task; the MCP tool uses resolveAiCreds(userId, args, "respin") so an agent can
// override per call. maxTokens follows the writer's own budget rule (contentTokens) so a
// long article can never be truncated mid-adaptation while a short one stays cheap.

import { contentTokens } from "@/lib/llm";

export interface RespinInput {
  platform: string;
  sourceTitle: string;
  sourceMarkdown: string;
  /** The money site's host — the one whose links must survive verbatim. */
  projectDomain: string;
}

export interface RespinResult {
  title: string;
  body: string;
}

/** Same signature as lib/llm's fetchLLM so tests (and only tests) can stub the model. */
export type RespinLlm = (
  prompt: string,
  provider: string,
  apiKey: string,
  maxTokens: number,
  modelOverride?: string,
  baseUrl?: string,
) => Promise<string | null>;

export interface RespinCreds {
  aiProvider: string;
  aiApiKey: string;
  model?: string;
  aiBaseUrl?: string;
}

// Short per-platform guidance. WordPress is the money site's own CMS — the honest instruction
// is "keep it"; the later-wave developer platforms get their tone named here when they land.
const PLATFORM_GUIDANCE: Record<string, string> = {
  wordpress: "This post is published on the project's own WordPress (the money site itself). Keep the text essentially unchanged: you may lightly tighten the title, but do not restructure, shorten or re-voice the body.",
};
const GENERIC_GUIDANCE =
  "Adapt the post for this platform's audience: tone, greeting style and length conventions may change. Keep every fact, every heading's meaning and every link exactly as in the source.";

export function buildRespinPrompt(input: RespinInput): string {
  const guidance = PLATFORM_GUIDANCE[input.platform] ?? GENERIC_GUIDANCE;
  const words = input.sourceMarkdown.trim().split(/\s+/).filter(Boolean).length;
  return [
    `You adapt an already-finished SEO article for publication on: ${input.platform}.`,
    `The project's own domain is ${input.projectDomain} — links pointing at it are the point of the publication and MUST survive verbatim.`,
    "",
    `Platform guidance: ${guidance}`,
    "",
    "Hard rules:",
    "1. PRESERVE all facts, numbers, names and claims. You are adapting, not rewriting: nothing new may be asserted.",
    "2. PRESERVE the heading structure (same sections, same order, same or equivalent headings).",
    "3. PRESERVE every markdown link [text](url) exactly as given, especially any pointing at " + input.projectDomain + ". Never invent, move or delete links.",
    "4. Keep the output in markdown, same language as the source.",
    "",
    `Source title: ${input.sourceTitle}`,
    "",
    "Source article:",
    input.sourceMarkdown,
    "",
    `Reply with JSON only, no prose around it: {"title": "<adapted title, max 70 chars>", "body": "<the full adapted article in markdown>"}. The body must be the complete article (about ${words} words), not a summary.`,
  ].join("\n");
}

/**
 * The model's reply to title+body. The reply may arrive fenced or with prose around the JSON
 * (same reality the drops history parser handles) — anything that does not parse into a
 * usable {title, body} returns null, and the CALLER must treat that as a failure. Falling
 * back to the un-adapted source here would publish something the user explicitly asked to
 * have adapted, labelled as adapted.
 */
export function parseRespinReply(raw: string | null): RespinResult | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { title?: unknown; body?: unknown };
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 200) : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!title || body.length < 50) return null;
    return { title, body };
  } catch {
    return null;
  }
}

/** One respin. Throws honest errors ("no key", "provider failed", "unparseable reply"). */
export async function respinPost(input: RespinInput, creds: RespinCreds, fetchLLM: RespinLlm): Promise<RespinResult> {
  if (!creds.aiApiKey) throw new Error("no_ai_creds: configure an AI provider for the respin task (Settings → SEO Tools)");
  const words = input.sourceMarkdown.trim().split(/\s+/).filter(Boolean).length;
  // The adapted body is about as long as the source, so the token budget scales with the
  // source exactly like the writer's does (words × 8, floored) — a floor of 1024 keeps a
  // short post cheap while a long one gets the room its length implies.
  const maxTokens = Math.min(16_000, Math.max(1024, contentTokens(words, 1024)));
  const raw = await fetchLLM(
    buildRespinPrompt(input),
    creds.aiProvider,
    creds.aiApiKey,
    maxTokens,
    creds.model,
    creds.aiBaseUrl,
  );
  const parsed = parseRespinReply(raw);
  if (!parsed) {
    // Long-call hygiene note: fetchLLM owns the retry/timeout ladder, and its error is kept
    // verbatim here so a hung or moderated provider reports as itself, not as a parse bug.
    throw new Error(
      raw
        ? `respin_unparseable: the model reply was not usable JSON with a title and a full body (${String(raw).slice(0, 160)})`
        : "respin_no_reply: the AI provider returned no text",
    );
  }
  return parsed;
}
