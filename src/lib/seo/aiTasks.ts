// Which AI job runs where — one registry, so the settings screen and the tool pages cannot
// disagree about it.
//
// They already did. Settings → SEO Tools offered per-task overrides for four tasks; the code
// read five (`landing` was readable but not writable) and the Links tool quietly ran on the
// `analysis` task without saying so anywhere. A user with three providers configured had no way
// to answer "which one is about to spend my money on this button" except by reading the source.
//
// So the mapping lives here, both directions, and both surfaces render it:
//   • the SEO Tools header names the tasks the current page will run, with what they resolve to
//   • Settings → SEO Tools builds its table from this list, including "used by"
//
// Adding a tool without adding it here is still possible — but then the tool shows up nowhere
// in the header, which is a visible omission rather than a silent one.

import type { SeoTask } from "@/lib/seo/keys";

export interface AiTaskDef {
  id: SeoTask;
  /** i18n key: short name, e.g. "Article text". */
  labelKey: string;
  /** i18n key: what this task actually sends to a model. */
  descKey: string;
  /**
   * What to pick when the user has expressed no preference — never a model id, only an
   * intention. `quality` for one-off deep work, `balanced` for the everyday case, `cheap` for
   * mechanical passes whose output is parsed rather than read.
   */
  tier: "quality" | "balanced" | "cheap";
}

export const AI_TASKS: AiTaskDef[] = [
  { id: "outline",  labelKey: "seoTaskOutline",  descKey: "seoTaskOutlineDesc",  tier: "quality" },
  { id: "text",     labelKey: "seoTaskText",     descKey: "seoTaskTextDesc",     tier: "quality" },
  { id: "landing",  labelKey: "seoTaskLanding",  descKey: "seoTaskLandingDesc",  tier: "quality" },
  { id: "analysis", labelKey: "seoTaskAnalysis", descKey: "seoTaskAnalysisDesc", tier: "balanced" },
  { id: "policy",   labelKey: "seoTaskPolicy",   descKey: "seoTaskPolicyDesc",   tier: "balanced" },
  { id: "utility",  labelKey: "seoTaskUtility",  descKey: "seoTaskUtilityDesc",  tier: "cheap" },
];

export const AI_TASK_BY_ID: Record<string, AiTaskDef> =
  Object.fromEntries(AI_TASKS.map(t => [t.id, t]));

// Tasks each tool page runs, most prominent first — the header badge labels itself with the
// first one. A page listing two tasks is not a mistake: the Outline tool drafts the structure on
// `outline` and then writes the body on `text`, and those can legitimately be different models.
export const PATH_TASKS: Record<string, SeoTask[]> = {
  "/seo-tools/outline":  ["outline", "text"],
  "/seo-tools/cluster":  ["outline"],
  "/seo-tools/text":     ["text"],
  "/seo-tools/rewrite":  ["text"],
  "/seo-tools/humanize": ["text"],
  "/seo-tools/landing":  ["landing"],
  "/seo-tools/analysis": ["analysis"],
  "/seo-tools/links":    ["analysis"],
  "/seo-tools/policy":   ["policy"],
  // The GEO audit picks its own search model on the page; the second, structured pass that turns
  // the search trace into a report runs on `utility`. Listing it keeps that pass visible instead
  // of leaving it as an unexplained line on the OpenAI bill.
  "/seo-tools/geo":      ["utility"],
};

export function tasksForPath(pathname: string): AiTaskDef[] {
  return (PATH_TASKS[pathname] ?? []).map(id => AI_TASK_BY_ID[id]).filter(Boolean);
}

/** Tool paths that run a given task — the "used by" column in settings. */
export function pathsForTask(task: SeoTask): string[] {
  return Object.entries(PATH_TASKS).filter(([, ids]) => ids.includes(task)).map(([p]) => p);
}
