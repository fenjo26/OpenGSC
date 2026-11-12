import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { dayExpr } from "@/lib/db/raw";
import { buildChain, moveConflict, recovery, detectTrafficMoves, normalizeReason, redirectTarget, siteRootUrl, type MoveCandidate } from "@/lib/siteMoves/chain";
import { safeFetch } from "@/lib/security/safeFetch";
import { listUserMoves, insertMove, deleteMove, dailyClicks, tableMissing } from "@/lib/siteMoves/store";

// Site moves — a whole site moving to another Search Console property (a new domain after a block,
// a subdomain that is its own property). See src/lib/siteMoves/chain.ts for the chain rules.
//
//   GET    ?siteId=    the chain through this site: its sites in order, the moves with recovery
//                      figures, a stitched per-day clicks series (one column per site), and move
//                      suggestions involving this site.
//   POST   { fromSiteId, toSiteId, date, reason, redirect301, note }
//   DELETE ?id=

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/**
 * Where this site's homepage ends up after redirects, as one of the user's other sites. One GET,
 * short timeout, small body cap — a probe, not a crawl. Any failure (timeout, TLS, a block page
 * from this server's network) is "no evidence", never an error the modal has to show.
 */
async function probeRedirect(siteUrl: string, sites: { id: string; url: string }[]): Promise<string | null> {
  const root = siteRootUrl(siteUrl);
  if (!root) return null;
  try {
    const res = await safeFetch(root, { method: "GET", redirect: "follow", timeoutMs: 6000, maxBytes: 32768, maxRedirects: 5 });
    return res.redirected ? redirectTarget(siteUrl, res.url, sites) : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const siteId = new URL(req.url).searchParams.get("siteId") || "";
  if (!siteId) return NextResponse.json({ error: "no_site" }, { status: 400 });

  const userSites = await prisma.site.findMany({ where: { userId }, select: { id: true, url: true }, orderBy: { url: "asc" } });
  if (!userSites.some(s => s.id === siteId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const urlOf = new Map(userSites.map(s => [s.id, s.url]));

  try {
    const moves = await listUserMoves(userId);
    if (moves === null) return NextResponse.json({ needsDbPush: true, userSites });

    const today = iso(new Date());
    const chain = buildChain(moves, siteId);
    const earliest = chain.moves.length ? chain.moves[0].date : today;
    // 90 days before the first move gives a baseline and some context; a single site shows 180.
    const from = chain.moves.length ? addDays(earliest, -90) : addDays(today, -180);

    // Suggestions need everyone's last ~150 days; the chain needs its own sites from `from`.
    // One query covers both when the windows overlap, which is the common case.
    const detectFrom = addDays(today, -150);
    const allIds = userSites.map(s => s.id);
    const daily = await dailyClicks(allIds, from < detectFrom ? from : detectFrom, dayExpr("date"));

    const movesOut = chain.moves.map(m => ({
      ...m,
      fromUrl: urlOf.get(m.fromSiteId) ?? m.fromSiteId,
      toUrl: urlOf.get(m.toSiteId) ?? m.toSiteId,
      recovery: recovery(daily.get(m.fromSiteId) ?? [], daily.get(m.toSiteId) ?? [], m.date, today),
    }));

    // Stitched series: one row per day, one column per site in the chain. The modal stacks them,
    // so the top edge is the brand's total and the colours show which domain carried it when.
    const byDay = new Map<string, Record<string, number | string>>();
    for (let d = from; d <= today; d = addDays(d, 1)) byDay.set(d, { date: d });
    for (const id of chain.sites) {
      for (const r of daily.get(id) ?? []) {
        const row = byDay.get(r.day);
        if (row) row[id] = r.clicks;
      }
    }
    for (const row of byDay.values()) for (const id of chain.sites) if (row[id] == null) row[id] = 0;

    const traffic = detectTrafficMoves(daily, today)
      .filter(c => (c.fromSiteId === siteId || c.toSiteId === siteId) && !moveConflict(moves, c.fromSiteId, c.toSiteId));
    // A homepage that 301s to another of the user's sites is the strongest evidence there is. Only
    // probed while this site has no move out yet — once linked there is nothing to suggest. The
    // redirect says THAT it moved, not WHEN: the date comes from the traffic detector when it saw
    // the same pair, otherwise it is left empty and the modal asks for it.
    const candidates: (MoveCandidate | (Omit<MoveCandidate, "date"> & { date: string | null }))[] = [...traffic];
    if (!moves.some(m => m.fromSiteId === siteId)) {
      const target = await probeRedirect(urlOf.get(siteId)!, userSites);
      if (target && !moveConflict(moves, siteId, target)) {
        const seen = traffic.find(c => c.fromSiteId === siteId && c.toSiteId === target);
        const rest = candidates.filter(c => !(c.fromSiteId === siteId && c.toSiteId === target));
        candidates.length = 0;
        candidates.push({ fromSiteId: siteId, toSiteId: target, date: seen?.date ?? null, evidence: "redirect" }, ...rest);
      }
    }
    const suggestions = candidates.map(c => ({ ...c, fromUrl: urlOf.get(c.fromSiteId), toUrl: urlOf.get(c.toSiteId) }));

    return NextResponse.json({
      chain: chain.sites.map(id => ({ id, url: urlOf.get(id) ?? id })),
      moves: movesOut,
      series: [...byDay.values()],
      suggestions,
      userSites,
    });
  } catch (e) {
    console.error("[site-moves:get]", e);
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const fromSiteId = String(b.fromSiteId || "");
  const toSiteId = String(b.toSiteId || "");
  const date = String(b.date || "");
  if (!fromSiteId || !toSiteId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return NextResponse.json({ error: "bad_date" }, { status: 400 });
  }
  const owned = await prisma.site.count({ where: { userId, id: { in: [fromSiteId, toSiteId] } } });
  if (owned !== (fromSiteId === toSiteId ? 1 : 2)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const moves = await listUserMoves(userId);
    if (moves === null) return NextResponse.json({ error: "needs_db_push" }, { status: 503 });
    const conflict = moveConflict(moves, fromSiteId, toSiteId);
    if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
    const id = await insertMove(userId, {
      fromSiteId, toSiteId, date,
      reason: normalizeReason(b.reason),
      redirect301: !!b.redirect301,
      note: b.note ? String(b.note).slice(0, 500) : null,
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    if (tableMissing(e)) return NextResponse.json({ error: "needs_db_push" }, { status: 503 });
    console.error("[site-moves:post]", e);
    return NextResponse.json({ error: "save_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "no_id" }, { status: 400 });
  try {
    await deleteMove(userId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[site-moves:delete]", e);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
