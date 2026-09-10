import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { parseManualVerdicts } from "@/lib/drops/manualVerdicts";
import { recordAvailabilityResults, schemaMissing } from "@/lib/drops/store";
import type { AvailabilityResult } from "@/lib/drops/types";

export const dynamic = "force-dynamic";

/** One paste is one batch; beyond this the user is importing a catalogue, not a result set. */
const MAX_ROWS = 5000;

/**
 * Verdicts checked outside and brought back — a registrar panel, or the registry's own web form
 * driven by the user's own tool. The reason this route exists is `.gr`: no RDAP, no working
 * public WHOIS, so the built-in stage can never answer, and without a way back in those rows sit
 * in `no_registry` forever.
 *
 * The verdicts land in the same fields the automatic check writes, with `via: "manual"` and
 * `corroborated: false` — always. One source is one source, and the whole module is built on
 * one source not being enough to paint a domain green.
 */
export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const raw = typeof body?.raw === "string" ? body.raw : "";
    const { rows, skipped } = parseManualVerdicts(raw);
    if (!rows.length) return NextResponse.json({ error: "no_verdicts", skipped }, { status: 400 });
    if (rows.length > MAX_ROWS) {
      return NextResponse.json({ error: "too_many_rows", max: MAX_ROWS }, { status: 400 });
    }

    const results = new Map<string, AvailabilityResult>();
    for (const r of rows) {
      results.set(r.domain, r.verdict === "available"
        ? { ok: true, status: "available", http: 0, via: "manual", corroborated: false }
        : { ok: true, status: "registered", http: 0, via: "manual" });
    }

    // Domains not in this catalogue simply match nothing — the writer is scoped by owner and
    // domain, so a stray line in the file cannot create a row or touch someone else's.
    const written = await recordAvailabilityResults(userId, results);
    return NextResponse.json({ ...written, submitted: rows.length, skipped });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
