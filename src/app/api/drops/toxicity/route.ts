import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { parseCandidateFilter, schemaMissing, setToxVetoArmed, toxVetoArmed } from "@/lib/drops/store";
import { runToxSlice } from "@/lib/drops/toxicity/stage";

export const dynamic = "force-dynamic";

/**
 * The free toxicity stage, UI side — one bounded slice per call (see stage.ts for what a
 * slice does and why the writes are shadow-mode). `anchorsOnly` classifies the whole
 * catalogue with zero network requests. POST {action:"arm"} flips the phase-2 flag that
 * wires a `toxic` verdict into the spam_history veto — off by default, on only after the
 * verdicts have been eyeballed.
 */
export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    if (body?.action === "arm") {
      await setToxVetoArmed(userId, body.armed === true);
      return NextResponse.json({ armed: body.armed === true });
    }

    const runId = typeof body?.runId === "string" && body.runId ? body.runId : undefined;
    const domains = Array.isArray(body?.domains)
      ? body.domains.filter((d: unknown): d is string => typeof d === "string").slice(0, 25)
      : undefined;
    const filter = !domains?.length && body?.filter && typeof body.filter === "object"
      ? parseCandidateFilter(body.filter as Record<string, unknown>)
      : undefined;

    return NextResponse.json(await runToxSlice(userId, {
      runId,
      domains,
      filter,
      anchorsOnly: body?.anchorsOnly === true,
      batch: Number(body?.batch) || undefined,
    }));
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** GET ?domain= — the card: the stored verdict plus the snapshot events the classifier saw.
 *  Without a domain it answers just {armed} — the catalogue's shadow-mode plate. */
export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const domain = new URL(req.url).searchParams.get("domain")?.trim().toLowerCase();
    if (!domain) return NextResponse.json({ armed: await toxVetoArmed(userId) });

    const { prisma } = await import("@/lib/prisma");
    const row = (await prisma.dropCandidate.findFirst({
      where: { userId, domain },
      select: { id: true, historyVerdict: true, historyNote: true, historyAt: true },
    })) as { id: string; historyVerdict: string | null; historyNote: string | null; historyAt: Date | null } | null;
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const events = (await prisma.dropEvent.findMany({
      where: { candidateId: row.id, type: "tox_snapshot" },
      orderBy: { createdAt: "asc" },
      take: 5,
    })) as { message: string }[];

    return NextResponse.json({
      verdict: row.historyVerdict,
      note: row.historyNote,
      at: row.historyAt,
      /** The free classifier's notes always start with `score N` — the AI pass writes prose. */
      source: /^score \d+/.test(row.historyNote ?? "") ? "free" : "ai",
      snapshots: events.map(e => { try { return JSON.parse(e.message); } catch { return null; } }).filter(Boolean),
      armed: await toxVetoArmed(userId),
    });
  } catch {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
