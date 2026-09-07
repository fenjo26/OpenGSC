import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { setHistoryVerdict, schemaMissing, storedWaybackTimestamps } from "@/lib/drops/store";
import { fetchSnapshotTimestamps, type WaybackFetch } from "@/lib/drops/wayback";
import { analyseDomainHistory } from "@/lib/drops/history";
import { fetchLLM } from "@/lib/llm";
import { resolveAiCreds } from "@/lib/mcp/shared";

export const dynamic = "force-dynamic";

/**
 * The AI history pass ("Пересчитать данные + AI") for hand-picked rows.
 *
 * Deliberately small and synchronous: at most five rows per call, two in flight, one model call
 * each — the whole request keeps the ~45s budget every long drops operation lives under. Bulk
 * AI verdicts over a whole run are exactly what the plan refuses to build: this pass spends the
 * owner's LLM credits, so it runs on rows a person chose, behind a confirm, and never on a list.
 */
const MAX_ROWS = 5;
const DEADLINE_MS = 40_000;

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const ids = (Array.isArray(body?.ids) ? body.ids : [])
      .filter((v: unknown): v is string => typeof v === "string")
      .slice(0, MAX_ROWS);
    if (!ids.length) return NextResponse.json({ error: "no_rows" }, { status: 400 });

    const rows = (await (prisma as any).dropCandidate.findMany({
      where: { userId, id: { in: ids } },
      select: { id: true, domain: true },
    })) as { id: string; domain: string }[];
    if (!rows.length) return NextResponse.json({ results: [] });
    // The dedicated drops-history slot (Settings → per-task AI), falling back through the
    // usual chain — this pass is small and mechanical, so it does not have to run on the
    // expensive writer the main SEO provider may be set to.
    const creds = await resolveAiCreds(userId, {}, "dropsHistory");
    if (!creds.aiApiKey) {
      return NextResponse.json({ error: "no_ai_creds" }, { status: 400 });
    }

    const deadline = Date.now() + DEADLINE_MS;
    const results: { id: string; domain: string; verdict?: string; note?: string; error?: string }[] = [];
    let cursor = 0;

    const worker = async (uid: string) => {
      while (cursor < rows.length && Date.now() < deadline) {
        const row = rows[cursor++];
        try {
          // A fresh Wayback pass already sitting on the row wins: its first/last captures are
          // the ends this pass needs, and skipping CDX for it is one fewer request against the
          // endpoint the archive throttles this server's IP for.
          const stored = await storedWaybackTimestamps(uid, row.domain);
          const snapshots: WaybackFetch = stored
            ? { ok: true, timestamps: stored }
            : await fetchSnapshotTimestamps(row.domain);
          if (!snapshots.ok) {
            results.push({ id: row.id, domain: row.domain, error: snapshots.reason === "throttled" ? "wayback_throttled" : "wayback_unreachable" });
            continue;
          }
          const verdict = await analyseDomainHistory(row.domain, snapshots.timestamps, {
            aiProvider: creds.aiProvider, aiApiKey: creds.aiApiKey, model: creds.model, aiBaseUrl: creds.aiBaseUrl,
          }, fetchLLM);
          if (!verdict) {
            results.push({ id: row.id, domain: row.domain, error: "not_a_domain" });
            continue;
          }
          await setHistoryVerdict(uid, row.domain, verdict.verdict, verdict.note);
          results.push({ id: row.id, domain: row.domain, verdict: verdict.verdict, note: verdict.note });
        } catch (e) {
          results.push({ id: row.id, domain: row.domain, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, rows.length) }, () => worker(userId)));
    // Rows the deadline never let start sit at the tail of the list; they are reported, not
    // silently dropped — a silent gap would read as "the AI decided nothing was wrong".
    for (let i = results.length; i < rows.length; i++) {
      results.push({ id: rows[i].id, domain: rows[i].domain, error: "deadline" });
    }

    return NextResponse.json({ results });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
