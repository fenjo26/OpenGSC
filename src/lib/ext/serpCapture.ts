// wave-ext E5 — browser SERP captures: validation, storage and the shapes the SERP Monitor
// "Browser captures" tab reads.
//
// A capture never touches SerpSnapshot/SerpKeyword.last*/SerpProjectHost/SerpChange — that
// isolation is the whole point of the separate table (see the model comment in schema.prisma).
// Rows reuse the SerpUrl/SerpHost dictionaries via ensureUrls, so the domain catalogue and
// enrichment keep working on captured hosts.

import { prisma } from "@/lib/prisma";
import { hostOfUrl } from "@/lib/serpmon/hosts";
import { normaliseKeyword } from "@/lib/serpmon/keywords";
import { ensureUrls, loadUrlHostMaps, expandRowsJson, urlHash } from "@/lib/serpmon/store";
import { enrichPendingHosts } from "@/lib/serpmon/enrich";
import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { diffKeyword } from "@/lib/serpmon/diff";
import { ignorePredicate, parseHostList } from "@/lib/serpmon/hosts";
import { CAPTURE_FEATURES, EXT_CAPTURE_DEDUPE_MS, EXT_CAPTURE_ROWS_MAX, EXT_SNIPPET_MAX, EXT_TITLE_MAX, type CaptureRequest, type CaptureResponse } from "./types";
import type { HostChange } from "@/lib/serpmon/types";

const ENGINE_RE = /^www\.google\.[a-z]{2,3}(\.[a-z]{2})?$/;
const FEATURES_SET = new Set<string>(CAPTURE_FEATURES);

/** Pure validation/normalisation of the client body. `keyword` is the normalised query. */
export function validateCapture(body: unknown):
  { ok: true; value: CaptureRequest & { keyword: string } } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const keyword = normaliseKeyword(String(b.query ?? ""));
  if (!keyword) return { ok: false, error: "invalid_query" };
  const engineHost = String(b.engineHost ?? "").trim().toLowerCase();
  if (!ENGINE_RE.test(engineHost)) return { ok: false, error: "invalid_engine" };
  const country = String(b.country ?? "").trim().toLowerCase();
  const lang = String(b.lang ?? "").trim().toLowerCase();
  const device = b.device === "mobile" ? "mobile" : "desktop";

  const page = Number(b.page);
  const startPosRaw = Number(b.startPos);
  if (!Number.isInteger(page) || page < 1 || page > 10) return { ok: false, error: "invalid_page" };
  if (!Number.isInteger(startPosRaw) || startPosRaw < 1 || startPosRaw > 100) return { ok: false, error: "invalid_start" };

  const rawResults = Array.isArray(b.results) ? b.results : [];
  const seen = new Set<string>();
  const results: (CaptureRequest["results"][number] & { clientPos: number | null })[] = [];
  for (const entry of rawResults.slice(0, EXT_CAPTURE_ROWS_MAX)) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const url = String(r.url ?? "");
    let host = "";
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) continue;
      host = hostOfUrl(u.href) ?? "";
      if (!host) continue;
    } catch {
      continue; // invalid URLs are dropped, not fatal — the rest of the page is still worth saving
    }
    if (seen.has(url)) continue; // sitelinks duplicate — the first position wins
    seen.add(url);
    // approx rows are never trusted: whatever URL the client sent, only the host of it is
    // breadcrumb-grade truth, so the row stores the host ROOT. Same-host approx rows then
    // dedupe to one entry at its first position — the honest reading of that SERP shape.
    const approx = r.approx === true;
    let finalUrl = url;
    if (approx) {
      try { finalUrl = new URL(url).origin + "/"; } catch { continue; }
      if (seen.has(finalUrl)) continue;
      seen.add(finalUrl);
    }
    // the client's own numbering: kept when the whole surviving sequence is sane (below).
    // DOM-order positions with holes are the truth this client sends — the overlay numbers
    // before its dedupe, the same convention automated snapshots use for rows whose link
    // could not be resolved (shiftedGotoRows keeps the slot taken).
    const rawPos = Number(r.position);
    const clientPos = Number.isInteger(rawPos) && rawPos >= startPosRaw && rawPos <= startPosRaw + 500 ? rawPos : null;
    results.push({
      position: 0,
      url: finalUrl,
      title: String(r.title ?? "").slice(0, EXT_TITLE_MAX),
      snippet: String(r.snippet ?? "").slice(0, EXT_SNIPPET_MAX),
      approx,
      clientPos,
    });
  }
  if (!results.length) return { ok: false, error: "no_results" };
  // Client positions survive verbatim — holes included — when every row has one and they are
  // strictly increasing. Only a broken sequence (junk, non-increasing) falls back to a
  // sequential renumber from startPos; the renumber must never silently shift hosts up past
  // what the page actually showed (three collapsed same-host rows are two taken slots, not
  // zero — the diff engine compares against automated snapshots).
  const sane = results.every((r, i) =>
    r.clientPos != null && (i === 0 || results[i - 1].clientPos! < r.clientPos));
  if (sane) {
    results.forEach(r => { r.position = r.clientPos!; });
  } else {
    results.forEach((r, i) => { r.position = startPosRaw + i; });
  }


  const features = (Array.isArray(b.features) ? b.features : [])
    .map(f => String(f))
    .filter(f => FEATURES_SET.has(f));

  return {
    ok: true,
    value: {
      query: keyword,
      keyword,
      engineHost,
      country,
      lang,
      device,
      page,
      startPos: startPosRaw,
      results: results.map(({ clientPos, ...rest }) => rest),
      features: [...new Set(features)],
      note: String(b.note ?? "").slice(0, 300),
    },
  };
}

/** Upsert into SerpCapture (same user+keyword+engineHost+page within EXT_CAPTURE_DEDUPE_MS →
 *  update), filling the SerpUrl/SerpHost dictionaries and fire-and-forget-enriching hosts the
 *  catalogue has never seen. */
export async function saveCapture(userId: string, input: CaptureRequest & { keyword: string }): Promise<CaptureResponse> {
  // which hosts exist BEFORE the dictionaries are filled — the newHosts count
  const beforeHosts = await prisma.serpHost.findMany({
    where: { host: { in: input.results.map(r => hostOfUrl(r.url) ?? "").filter(Boolean) } },
    select: { host: true },
  });
  const knownBefore = new Set(beforeHosts.map(h => h.host));

  const urlIds = await ensureUrls(input.results.map(r => ({ url: r.url, host: hostOfUrl(r.url) ?? "", title: r.title })));

  // the project that tracks this keyword in the same market (both known), active keyword first
  const projects = await prisma.serpProject.findMany({
    where: { userId, country: input.country, lang: input.lang },
    select: { id: true },
  });
  let projectId: string | null = null;
  let keywordId: string | null = null;
  if (projects.length && input.country && input.lang) {
    const keywords = await prisma.serpKeyword.findMany({
      where: { keyword: input.keyword, projectId: { in: projects.map(p => p.id) } },
      orderBy: [{ active: "desc" }, { lastOkAt: "desc" }],
      select: { id: true, projectId: true },
    });
    if (keywords.length) {
      keywordId = keywords[0].id;
      projectId = keywords[0].projectId;
    }
  }

  const rowsJson = JSON.stringify(input.results.map(r => [r.position, urlIds.get(urlHash(r.url)) ?? 0]));
  const snippetsJson = JSON.stringify(input.results.map(r => ({
    position: r.position, title: r.title, snippet: r.snippet,
  })));
  const since = new Date(Date.now() - EXT_CAPTURE_DEDUPE_MS);
  const dup = await prisma.serpCapture.findFirst({
    where: { userId, keyword: input.keyword, engineHost: input.engineHost, page: input.page, capturedAt: { gte: since } },
    orderBy: { capturedAt: "desc" },
  });

  let captureId: string;
  let updated: boolean;
  const data = {
    userId,
    projectId,
    keywordId,
    keyword: input.keyword,
    engineHost: input.engineHost,
    country: input.country,
    lang: input.lang,
    device: input.device,
    page: input.page,
    startPos: input.startPos,
    got: input.results.length,
    rows: rowsJson,
    features: JSON.stringify(input.features),
    snippets: snippetsJson,
    note: input.note ?? "",
  };
  if (dup) {
    await prisma.serpCapture.update({ where: { id: dup.id }, data });
    captureId = dup.id;
    updated = true;
  } else {
    const created = await prisma.serpCapture.create({ data });
    captureId = created.id;
    updated = false;
  }

  // new hosts enrich themselves in the background — the user does not wait for RDAP
  const freshHosts = [...new Set(input.results.map(r => hostOfUrl(r.url) ?? "").filter(Boolean))]
    .filter(h => !knownBefore.has(h));
  if (freshHosts.length) {
    const freshRows = await prisma.serpHost.findMany({ where: { host: { in: freshHosts } }, select: { id: true } });
    if (freshRows.length) {
      void resolveCaptureBodies(userId).then(captureBodies =>
        withCallContext({ userId, feature: "serpmon-cron", captureBodies }, () =>
        enrichPendingHosts({ hostIds: freshRows.map(r => r.id), limit: 20, deadline: Date.now() + 15_000, what: "both" }),
      )).catch(() => { /* enrichment is opportunistic */ });
    }
  }

  return { ok: true, captureId, updated, projectId, keywordId, newHosts: freshHosts.length };
}

export interface CaptureListItem {
  id: string; keyword: string; engineHost: string; country: string; lang: string;
  page: number; got: number; capturedAt: string; projectId: string | null; keywordId: string | null;
  features: string[];
}

export interface CaptureView extends CaptureListItem {
  rows: { position: number; url: string; host: string; title: string; snippet: string }[];
  compare: null | { snapshotId: string; takenAt: string; depth: number; changes: HostChange[] };
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toListItem(c: {
  id: string; keyword: string; engineHost: string; country: string; lang: string;
  page: number; got: number; capturedAt: Date; projectId: string | null; keywordId: string | null; features: string;
}): CaptureListItem {
  return {
    id: c.id,
    keyword: c.keyword,
    engineHost: c.engineHost,
    country: c.country,
    lang: c.lang,
    page: c.page,
    got: c.got,
    capturedAt: c.capturedAt.toISOString(),
    projectId: c.projectId,
    keywordId: c.keywordId,
    features: parseJsonArray(c.features).map(String),
  };
}

export async function listCaptures(userId: string, q: { projectId?: string; keyword?: string; limit: number }): Promise<CaptureListItem[]> {
  const keyword = q.keyword ? normaliseKeyword(q.keyword) : undefined;
  const rows = await prisma.serpCapture.findMany({
    where: {
      userId,
      ...(q.projectId ? { OR: [{ projectId: q.projectId }, { projectId: null }] } : {}),
      ...(keyword ? { keyword } : {}),
    },
    orderBy: { capturedAt: "desc" },
    take: Math.min(100, Math.max(1, q.limit || 20)),
  });
  return rows.map(toListItem);
}

export async function captureView(userId: string, id: string, compare?: "nearest" | string): Promise<CaptureView | null> {
  const c = await prisma.serpCapture.findFirst({ where: { id, userId } });
  if (!c) return null;
  const base = toListItem(c);

  // rows: [position, urlId][] → display rows with hosts and snippets
  const maps = await loadUrlHostMaps(parseRowPairs(c.rows));
  const snippetByPosition = new Map<number, { title: string; snippet: string }>();
  for (const s of parseJsonArray(c.snippets)) {
    const entry = (s ?? {}) as { position?: unknown; title?: unknown; snippet?: unknown };
    const pos = Number(entry.position);
    if (Number.isInteger(pos)) {
      snippetByPosition.set(pos, { title: String(entry.title ?? ""), snippet: String(entry.snippet ?? "") });
    }
  }
  const rows = expandRowsJson(c.rows, maps).map(r => ({
    ...r,
    title: snippetByPosition.get(r.position)?.title || r.title,
    snippet: snippetByPosition.get(r.position)?.snippet || "",
  }));

  let compareOut: CaptureView["compare"] = null;
  if (compare && c.keywordId) {
    let snapshotId: string | null = null;
    if (compare !== "nearest") {
      snapshotId = compare;
    } else {
      const snap = await prisma.serpSnapshot.findFirst({
        where: { keywordId: c.keywordId, status: { in: ["ok", "partial"] } },
        orderBy: { takenAt: "desc" },
        select: { id: true },
      });
      // nearest by |takenAt - capturedAt|: the query above is a cheap proxy when the capture is
      // the newest thing; do it honestly instead with a two-sided look.
      const newer = await prisma.serpSnapshot.findFirst({
        where: { keywordId: c.keywordId, status: { in: ["ok", "partial"] }, takenAt: { gte: c.capturedAt } },
        orderBy: { takenAt: "asc" },
        select: { id: true, takenAt: true },
      });
      const older = await prisma.serpSnapshot.findFirst({
        where: { keywordId: c.keywordId, status: { in: ["ok", "partial"] }, takenAt: { lt: c.capturedAt } },
        orderBy: { takenAt: "desc" },
        select: { id: true, takenAt: true },
      });
      const pick = [newer, older].filter(Boolean).sort((a, b) =>
        Math.abs(a!.takenAt.getTime() - c.capturedAt.getTime()) - Math.abs(b!.takenAt.getTime() - c.capturedAt.getTime()))[0];
      snapshotId = pick ? pick.id : (snap?.id ?? null);
    }
    if (snapshotId) {
      const snapshot = await prisma.serpSnapshot.findFirst({
        where: { id: snapshotId, keyword: { project: { userId } } },
        select: { id: true, takenAt: true, depth: true, rows: true },
      });
      if (snapshot) {
        const project = c.projectId
          ? await prisma.serpProject.findFirst({ where: { id: c.projectId, userId }, select: { ignoreHosts: true } })
          : null;
        const ignore = ignorePredicate(project ? parseHostList(project.ignoreHosts) : []);
        const snapMaps = await loadUrlHostMaps(parseRowPairs(snapshot.rows));
        const snapRows = expandRowsJson(snapshot.rows, snapMaps);
        const depth = Math.max(...rows.map(r => r.position), 10);
        const diff = diffKeyword(snapRows, rows, { depth, ignore });
        compareOut = {
          snapshotId: snapshot.id,
          takenAt: snapshot.takenAt.toISOString(),
          depth: snapshot.depth,
          changes: diff.changes,
        };
      }
    }
  }

  return { ...base, rows, compare: compareOut };
}

export async function deleteCapture(userId: string, id: string): Promise<boolean> {
  const r = await prisma.serpCapture.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

/** [position, urlId][] from a stored rows JSON, typed. */
function parseRowPairs(rowsJson: string): number[] {
  return parseJsonArray(rowsJson)
    .map(pair => Array.isArray(pair) ? Number(pair[1]) : NaN)
    .filter(n => Number.isInteger(n) && n > 0);
}
