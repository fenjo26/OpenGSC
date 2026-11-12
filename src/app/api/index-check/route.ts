import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  createRun, estimateRun, listRuns, type RunSource,
} from "@/lib/indexing/checkQueue";

// Mass index-check runs (/index-check) — one user action → N URLs checked sequentially in the
// background against a paid provider (site: SERP or XML River's direct endpoint).
//
//   GET                    — the runs list (history block of the page).
//   POST { provider, source, confirm? }  — without confirm: collect + price, NOT ONE provider
//        call; with confirm: create the run and kick the pump. Source shapes:
//          { kind: "sites", siteIds: string[], filter?: "all" | "pending" | "google_not_indexed" }
//          { kind: "urls", urls: string[] }
//          { kind: "donors" }
//
// Same two-click contract as /api/indexing/serp-check (CONTRACT §0.5): the first click shows
// the budget, the second spends it.

function parseSource(b: Record<string, unknown>): RunSource | null {
  const src = (b.source ?? {}) as Record<string, unknown>;
  const kind = String(src.kind ?? "");
  if (kind === "urls") {
    const urls = Array.isArray(src.urls) ? src.urls.map((u: unknown) => String(u ?? "").trim()).filter(Boolean) : [];
    return { kind: "urls", urls };
  }
  if (kind === "donors") return { kind: "donors" };
  if (kind === "sites") {
    const siteIds = Array.isArray(src.siteIds) ? src.siteIds.map((x: unknown) => String(x ?? "")).filter(Boolean) : [];
    const rawFilter = String(src.filter ?? "pending");
    const filter = rawFilter === "all" || rawFilter === "google_not_indexed" ? rawFilter : "pending";
    return { kind: "sites", siteIds, filter };
  }
  return null;
}

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const runs = await listRuns(userId);
  return NextResponse.json({ runs });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const providerWanted = String(b.provider ?? "");
  const source = parseSource(b ?? {});
  if (!source) return NextResponse.json({ error: "bad_source" }, { status: 400 });

  try {
    if (b.confirm !== true) {
      const est = await estimateRun(userId, providerWanted, source);
      if (!est.ok) {
        return NextResponse.json({ error: est.error, collected: est.collected, estimate: est.estimate }, { status: 400 });
      }
      return NextResponse.json(est);
    }
    const out = await createRun(userId, providerWanted, source, {
      name: typeof b.name === "string" ? b.name : undefined,
      cap: b.cap,
      pauseAfterErrors: typeof b.pauseAfterErrors === "number" ? b.pauseAfterErrors : undefined,
    });
    if (!out.ok) {
      const status =
        out.error === "cap_exceeded" ? 429 :
        out.error === "run_active" ? 409 :
        400;
      return NextResponse.json({ error: out.error, detail: out.detail }, { status });
    }
    return NextResponse.json(out);
  } catch (e) {
    // Pre-`db push` instances lack the tables: that is notMigrated, not a 500 (same detector
    // philosophy as serp-check's route).
    const msg = String((e as { message?: string })?.message ?? "");
    if (/SerpCheck|does not exist|no such table|no such column/i.test(msg)) {
      return NextResponse.json({ notMigrated: true }, { status: 503 });
    }
    console.error("[index-check:create]", e);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}
