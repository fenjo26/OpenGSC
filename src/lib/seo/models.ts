// Picking a sensible OpenAI model without hardcoding this month's model id.
//
// Every place that named a model literally — `"gpt-5"` in the GEO page, in geoClient's stored
// default, in the AEO checker — went stale the day OpenAI shipped the next generation, and went
// stale silently: the id still resolves, the call still succeeds, and the tool quietly runs on
// an older model than the browser the user is comparing it against. For a tool whose entire job
// is "what does ChatGPT say today", that is not a cosmetic problem.
//
// So the live `/v1/models` list (fetched with the user's own key) is the source of truth, and
// this module only knows how to *rank* what came back: newest generation first, then by tier.
// The literal ids below are a last resort for when there is no key to list models with.

export type ModelOpt = { id: string; label: string };

// Only reached when the user has no OpenAI key configured, so the picker has nothing to list.
// Ordered best-first. Update when convenient; nothing depends on it being current.
export const OPENAI_FALLBACK_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5"];

/** Same, for the mechanical passes whose output is parsed rather than read. */
export const OPENAI_FALLBACK_CHEAP = "gpt-5.6-luna";

// Size/price tier within a generation. OpenAI has used two naming schemes — the sun/earth/moon
// trio (sol > terra > luna) and the plain mini/nano suffixes — so both are scored here, largest
// first. An id with no tier suffix is the full-size model.
const TIER_WEIGHT: [RegExp, number][] = [
  [/(^|[-_])sol([-_]|$)/i, 4],
  [/(^|[-_])terra([-_]|$)/i, 3],
  [/(^|[-_])luna([-_]|$)/i, 1],
  [/(^|[-_])nano([-_]|$)/i, 0],
  [/(^|[-_])mini([-_]|$)/i, 1],
];

function tierOf(id: string): number {
  for (const [re, w] of TIER_WEIGHT) if (re.test(id)) return w;
  return 4; // no suffix — the full-size model of its generation
}

// "gpt-5.6-sol" → 5.6, "gpt-4o" → 4, "o3" → 3. Dated snapshots ("gpt-5.6-sol-2026-07-09")
// score the same as their alias, and the tie is broken by preferring the shorter id so the
// stable alias wins over a pinned snapshot.
function generationOf(id: string): number {
  const gpt = /^gpt-(\d+(?:\.\d+)?)/i.exec(id);
  if (gpt) return parseFloat(gpt[1]);
  const o = /^o(\d+)/i.exec(id);
  if (o) return parseFloat(o[1]);
  return 0;
}

// Preview/experimental snapshots are real models but a poor default — they get deprecated on
// their own schedule and are not what a user comparing against ChatGPT is served.
function isPreview(id: string): boolean {
  return /(preview|alpha|beta|latest-experimental)/i.test(id);
}

/** Sort a model list best-first: newest generation, then largest tier, then stable alias. */
export function rankModels(models: ModelOpt[]): ModelOpt[] {
  return [...models].sort((a, b) => {
    const pa = isPreview(a.id) ? 1 : 0, pb = isPreview(b.id) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const ga = generationOf(a.id), gb = generationOf(b.id);
    if (ga !== gb) return gb - ga;
    const ta = tierOf(a.id), tb = tierOf(b.id);
    if (ta !== tb) return tb - ta;
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;
    return a.id.localeCompare(b.id);
  });
}

export type ModelTier = "quality" | "balanced" | "cheap";

/**
 * The model to select when the user has not chosen one.
 *
 * `quality` takes the best available — right for a one-off deep audit. `balanced` steps down one
 * tier inside the newest generation, which is right for anything run across many rows: it is the
 * everyday model, so it is also the closest match to what a normal ChatGPT user is served.
 * `cheap` takes the smallest tier of that generation, for mechanical passes whose output is
 * parsed rather than read.
 *
 * Note that all three stay inside the newest generation. Reaching back to an older, smaller
 * model to save money is a decision with a quality cliff in it, and not one to make on the
 * user's behalf without saying so.
 */
export function defaultModel(models: ModelOpt[], prefer: ModelTier = "balanced"): string {
  const ranked = rankModels(models);
  if (!ranked.length) {
    if (prefer === "quality") return OPENAI_FALLBACK_MODELS[0];
    if (prefer === "cheap") return OPENAI_FALLBACK_CHEAP;
    return OPENAI_FALLBACK_MODELS[1] ?? OPENAI_FALLBACK_MODELS[0];
  }
  if (prefer === "quality") return ranked[0].id;

  const topGen = generationOf(ranked[0].id);
  const sameGen = ranked.filter(m => generationOf(m.id) === topGen);
  if (prefer === "cheap") return sameGen[sameGen.length - 1].id;

  // Second-largest tier in the newest generation, if that generation has more than one tier.
  const stepped = sameGen.find(m => tierOf(m.id) < tierOf(ranked[0].id));
  return (stepped ?? ranked[0]).id;
}

/** Keep a stored/explicit choice if the account still offers it, else fall back to the default. */
export function resolveModel(stored: string | null | undefined, models: ModelOpt[], prefer: ModelTier = "balanced"): string {
  if (stored && models.some(m => m.id === stored)) return stored;
  if (stored && !models.length) return stored;
  return defaultModel(models, prefer);
}
