// Events OpenGSC already knows about because it did them — published posts, content operations
// that went live, PBN links placed to this site, URLs sent to an indexer. Derived on every read,
// exactly like link purchases: nothing is copied into Annotation, so a deleted post or a re-run
// cannot leave a stale or duplicated marker behind.
//
// Each source is read on its own and any failure drops only that source — an instance missing a
// table (no db push yet, a module never used) still gets the others.

import { prisma } from "@/lib/prisma";
import type { EventType } from "./events";

export interface AutoEvent {
  /** "auto:<source>:<key>" — the UI treats the prefix as read-only. */
  id: string;
  /** YYYY-MM-DD (UTC) */
  day: string;
  title: string;
  description: string | null;
  eventType: EventType;
  /** Page scope; empty = whole site. */
  urls: string[];
  /** Kept off the dashboard chart when true — high-frequency events belong in the list only. */
  listOnly: boolean;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const hostOf = (u: string) => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};
const siteHost = (siteUrl: string) =>
  /^sc-domain:/i.test(siteUrl) ? siteUrl.replace(/^sc-domain:/i, "").toLowerCase().replace(/^www\./, "") : hostOf(siteUrl);

/** A target URL belongs to this site when its host is the site's host — or, for a domain
 *  property, any subdomain of it. */
function belongs(url: string, siteUrl: string): boolean {
  const h = hostOf(url), s = siteHost(siteUrl);
  if (!h || !s) return false;
  return h === s || (/^sc-domain:/i.test(siteUrl) && h.endsWith(`.${s}`));
}

export async function autoEventsForSite(siteId: string, userId: string, sinceDay: string): Promise<AutoEvent[]> {
  const since = new Date(`${sinceDay}T00:00:00Z`);
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { url: true } });
  if (!site) return [];
  const out: AutoEvent[] = [];

  // Posts published through a blog connection of this site.
  try {
    const posts = await prisma.publishedPost.findMany({
      where: { siteId, status: "published", publishedAt: { gte: since } },
      select: { id: true, title: true, remoteUrl: true, publishedAt: true },
      orderBy: { publishedAt: "desc" },
      take: 200,
    });
    for (const p of posts) {
      if (!p.publishedAt) continue;
      out.push({
        id: `auto:post:${p.id}`, day: dayOf(p.publishedAt), title: p.title || p.remoteUrl,
        description: p.remoteUrl || null, eventType: "content_update",
        urls: p.remoteUrl ? [p.remoteUrl] : [], listOnly: false,
      });
    }
  } catch { /* source unavailable */ }

  // Content operations (the editorial pipeline) that reached "live" for this site.
  try {
    const ops = await prisma.contentOperation.findMany({
      where: { siteId, userId, liveAt: { gte: since } },
      select: { id: true, title: true, operationType: true, targetUrl: true, liveAt: true },
      take: 200,
    });
    for (const o of ops) {
      if (!o.liveAt) continue;
      out.push({
        id: `auto:op:${o.id}`, day: dayOf(o.liveAt), title: o.title,
        description: o.operationType === "update" ? "content update" : "new page",
        eventType: "content_update", urls: o.targetUrl ? [o.targetUrl] : [], listOnly: false,
      });
    }
  } catch { /* source unavailable */ }

  // PBN links placed to this site — one event per PBN domain per day, scoped to the target pages.
  try {
    const links = await prisma.pbnLink.findMany({
      where: { status: "placed", createdAt: { gte: since }, site: { userId } },
      select: { targetUrl: true, createdAt: true, site: { select: { domain: true } } },
      take: 5000,
    });
    const groups = new Map<string, { day: string; domain: string; urls: Set<string>; n: number }>();
    for (const l of links) {
      if (!belongs(l.targetUrl, site.url)) continue;
      const day = dayOf(l.createdAt);
      const key = `${day}|${l.site.domain}`;
      const g = groups.get(key) ?? { day, domain: l.site.domain, urls: new Set<string>(), n: 0 };
      g.urls.add(l.targetUrl); g.n++;
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      out.push({
        id: `auto:pbn:${key}`, day: g.day, title: `PBN ${g.domain} · ${g.n}`,
        description: null, eventType: "links", urls: [...g.urls], listOnly: false,
      });
    }
  } catch { /* source unavailable */ }

  // URLs sent to an indexer — one event per day, list only (it can happen every day).
  try {
    const ops = await prisma.indexingOperation.findMany({
      where: { siteId, type: { in: ["neural_submit", "2index_submit"] }, createdAt: { gte: since } },
      select: { createdAt: true, urlCount: true },
      take: 2000,
    });
    const perDay = new Map<string, number>();
    for (const o of ops) perDay.set(dayOf(o.createdAt), (perDay.get(dayOf(o.createdAt)) ?? 0) + (o.urlCount ?? 0));
    for (const [day, n] of perDay) {
      out.push({
        id: `auto:index:${day}`, day, title: `Indexer · ${n} URL`,
        description: null, eventType: "tech", urls: [], listOnly: true,
      });
    }
  } catch { /* source unavailable */ }

  return out;
}
