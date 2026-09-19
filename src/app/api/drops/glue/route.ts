import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { buildGluePlan } from "@/lib/drops/glue/generate";
import { parsePage } from "@/lib/drops/glue/parse";
import { validateCluster } from "@/lib/drops/glue/validate";
import { detectCloaking, fetchClusterPages, MAX_URLS, withFindings } from "@/lib/drops/glue/fetchPages";
import type { GlueMode, GluePlan, GlueSpec } from "@/lib/drops/glue/types";

export const dynamic = "force-dynamic";

/**
 * The glue card's two verbs. `plan` is pure: it builds the annotation blocks for both sides
 * with no network and no database. `check` fetches the live cluster through safeFetch (URLs
 * come from a form, so the SSRF guard is the whole point of routing through it), parses each
 * page and runs the validator; `ua: "both"` adds the Googlebot pass and folds the
 * cloaking diff into the same report. Both are owner-only like every other drops route.
 */

const MAX_ALTERNATES = 12;
const UA_VALUES = new Set(["browser", "googlebot", "both"]);
const MODES = new Set(["cluster", "funnel"]);

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const action = new URL(req.url).searchParams.get("action");
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    if (action === "plan") return plan(body);
    if (action === "check") return check(body);
    return NextResponse.json({ error: "bad_action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

function plan(body: Record<string, unknown>): NextResponse {
  const mode = body.mode;
  if (typeof mode !== "string" || !MODES.has(mode)) {
    return NextResponse.json({ error: "bad_mode" }, { status: 400 });
  }
  if (typeof body.dropUrl !== "string" || !body.dropUrl.trim()) {
    return NextResponse.json({ error: "bad_drop_url" }, { status: 400 });
  }
  const rawAlts = Array.isArray(body.alternates) ? body.alternates : [];
  if (!rawAlts.length || rawAlts.length > MAX_ALTERNATES) {
    return NextResponse.json({ error: "bad_alternates" }, { status: 400 });
  }
  const alternates: { hreflang: string; url: string }[] = [];
  for (const a of rawAlts) {
    if (!a || typeof a !== "object") {
      return NextResponse.json({ error: "bad_alternates" }, { status: 400 });
    }
    const hreflang = (a as Record<string, unknown>).hreflang;
    const url = (a as Record<string, unknown>).url;
    if (typeof hreflang !== "string" || typeof url !== "string") {
      return NextResponse.json({ error: "bad_alternates" }, { status: 400 });
    }
    alternates.push({ hreflang, url });
  }
  const spec: GlueSpec = {
    mode: mode as GlueMode,
    dropUrl: body.dropUrl,
    alternates,
  };
  if (typeof body.dropHtmlLang === "string" && body.dropHtmlLang.trim()) {
    spec.dropHtmlLang = body.dropHtmlLang;
  }
  if (typeof body.xDefault === "string" && body.xDefault.trim()) {
    spec.xDefault = body.xDefault;
  }

  // The generator reports its own complaints as notes (locale_fixed, url_not_absolute, …)
  // instead of failing — the plan comes back even with blockers in it, and the UI colours
  // them. That is deliberate: a fixable input must not look like a dead form.
  return NextResponse.json({ plan: buildGluePlan(spec) });
}

async function check(body: Record<string, unknown>): Promise<NextResponse> {
  const mode = body.mode;
  if (typeof mode !== "string" || !MODES.has(mode)) {
    return NextResponse.json({ error: "bad_mode" }, { status: 400 });
  }
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string" && isHttpUrl(u))
    : [];
  if (!urls.length) return NextResponse.json({ error: "no_urls" }, { status: 400 });
  if (urls.length > MAX_URLS) {
    return NextResponse.json({ error: "too_many_urls", max: MAX_URLS }, { status: 400 });
  }
  const ua = typeof body.ua === "string" && UA_VALUES.has(body.ua) ? body.ua : "browser";
  // The plan rides along when the check starts from a generated one; validateCluster then
  // also diffs the live pages against it, which is how a swapped canonical gets caught.
  let plan: GluePlan | undefined;
  if (body.plan && typeof body.plan === "object" && Array.isArray((body.plan as GluePlan).pages)) {
    const pages = (body.plan as GluePlan).pages;
    if (pages.length > MAX_ALTERNATES + 1) {
      return NextResponse.json({ error: "bad_plan" }, { status: 400 });
    }
    plan = body.plan as GluePlan;
  } else if (body.plan !== undefined) {
    return NextResponse.json({ error: "bad_plan" }, { status: 400 });
  }

  return NextResponse.json(await runCheck(urls, mode as GlueMode, ua, plan));
}

async function runCheck(
  urls: string[],
  mode: GlueMode,
  ua: string,
  plan: GluePlan | undefined,
) {
  const pages = await fetchClusterPages(urls, { ua: "browser" });
  const facts = pages.map(parsePage);
  let report = validateCluster(facts, { mode, plan });

  let botFacts: ReturnType<typeof parsePage>[] | undefined;
  if (ua === "googlebot" || ua === "both") {
    const botPages = await fetchClusterPages(urls, { ua: "googlebot" });
    botFacts = botPages.map(parsePage);
    if (ua === "googlebot") {
      report = validateCluster(botFacts, { mode, plan });
    } else {
      report = withFindings(report, detectCloaking(facts, botFacts));
    }
  }

  return { report, facts, botFacts };
}
