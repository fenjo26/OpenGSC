import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";
import {
  goanyTransparencyDomain, goanyTransparencyKeyword, goanyDomainSearch, goanyDomainTitles,
  goanyDomainStatistics, goanyDomainImageAds, goanyTitleCountries,
} from "@/lib/seo/goanyapi";

// POST /api/ads-intel { domain, section, fetch?, title?, shareToken? }
//
// The Ads tab's backend: Google Ads Transparency intelligence for one domain, served from
// GoAnyAPI in independently-priced sections. `overview` (advertisers + hostId) costs 9
// credits; `titles`, `statistics`, `images` cost 5 each; `countries` is 5 per title and needs
// that title in the body. Sections cache separately — detailing the tab never re-buys the
// overview — under a 7-day TTL, because ad campaigns change on campaign timescales, not daily.
//
// Guests on a share link read whatever is cached and never spend: the owner's credits are not
// theirs. The key travels in the x-goanyapi-key header, per the app convention that SEO keys
// live in the browser they were typed into.

const TTL_MS = 7 * 24 * 3600 * 1000;

const SECTIONS = ["overview", "titles", "statistics", "images", "countries", "keyword"] as const;
type Section = typeof SECTIONS[number];

const normDomain = (d: string) =>
  d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").split("/")[0];

// Google Ads caps weekly statistics at 48 buckets; ~330 days stays inside it with slack, and
// titles older than the window are lost to the provider anyway — a bounded window is the
// honest shape of this data, not a choice made for us.
const range = () => {
  const fmt = (d: Date, compact = false) => {
    const p = (n: number) => String(n).padStart(2, "0");
    const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return compact ? base.replace(/-/g, "") : base;
  };
  const end = new Date();
  const start = new Date(end.getTime() + 330 * -24 * 3600 * 1000);
  return { start: fmt(start), end: fmt(end), startC: fmt(start, true), endC: fmt(end, true) };
};

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");

  const b = await req.json().catch(() => ({}));
  const shareToken = String(b.shareToken ?? "");
  const section = SECTIONS.includes(b.section) ? b.section as Section : null;
  if (!section) return NextResponse.json({ error: "bad_section" }, { status: 400 });

  // The target domain: an explicit one wins — the Ads tab is a research tool and the domain
  // the user typed (a competitor) is the point. The site row is the fallback for a plain tab
  // open, never an override: this endpoint's spends are deliberate per call, keyed to the
  // domain in the request body.
  let domain = normDomain(String(b.domain ?? ""));
  if ((!domain || !domain.includes(".")) && b.siteId && userId) {
    const site = await prisma.site.findFirst({ where: { id: String(b.siteId), userId }, select: { url: true } });
    if (site) domain = normDomain(site.url.replace(/^sc-domain:/, ""));
  }
  if (!domain || !domain.includes(".")) return NextResponse.json({ error: "bad_domain" }, { status: 400 });

  let isGuest = false;
  if (!userId) {
    if (!shareToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const site = await prisma.site.findFirst({ where: { shareToken, shareEnabled: true }, select: { url: true } });
    if (!site) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    isGuest = true;
  }

  const apiKey = (req.headers.get("x-goanyapi-key") || "").trim();
  const wantFetch = !!b.fetch && !isGuest;

  const readCache = async (sectionName: Section = section, key = "") => {
    try {
      const rows: any[] = await rawQuery(
        `SELECT payload, checkedAt FROM "AdIntelCache" WHERE domain = ? AND section = ? AND key = ?`,
        domain, sectionName, key);
      const hit = rows?.[0];
      if (!hit) return null;
      let payload: unknown = null;
      try { payload = JSON.parse(hit.payload); } catch { return null; }
      return { payload, checkedAt: hit.checkedAt, fresh: Date.now() - new Date(hit.checkedAt).getTime() < TTL_MS };
    } catch { return null; }
  };

  const writeCache = async (payload: unknown, key = "") => {
    try {
      await runUpsert({
        table: "AdIntelCache",
        conflict: ["domain", "section", "key"],
        values: { domain, section, key, payload: JSON.stringify(payload), checkedAt: new Date().toISOString() },
        update: { payload: "set", checkedAt: "set" },
      });
    } catch { /* cache best-effort — the answer is paid for and returned either way */ }
  };

  const cacheKey = section === "countries"
    ? String(b.title ?? "").trim()
    : section === "keyword"
      ? String(b.keyword ?? "").trim().toLowerCase()
      : "";
  if (section === "countries" && !cacheKey) return NextResponse.json({ error: "bad_title" }, { status: 400 });
  if (section === "keyword" && !cacheKey) return NextResponse.json({ error: "bad_keyword" }, { status: 400 });

  const cached = await readCache(section, cacheKey);
  if (!wantFetch) {
    return NextResponse.json({
      domain, section, ...(cached ? { ...cached, cached: true } : { payload: null, cached: false }),
    });
  }
  if (cached?.fresh) {
    return NextResponse.json({ domain, section, ...cached, cached: true });
  }
  if (!apiKey) return NextResponse.json({ error: "no_key" }, { status: 400 });

  // `titles` et al. hang off the hostId that only the overview pull produces. Auto-fetching it
  // here would spend 9 surprise credits; naming the prerequisite keeps the spend deliberate.
  let hostId: number | null = null;
  if (section !== "overview" && section !== "keyword") {
    const overview = await readCache("overview");
    const payload = overview?.payload as { hostId?: number } | null | undefined;
    hostId = payload?.hostId != null ? Number(payload.hostId) : null;
    if (hostId == null) return NextResponse.json({ error: "load_overview_first" }, { status: 409 });
  }

  const { start, end, startC, endC } = range();
  const dates = section === "countries"
    ? { startDay: startC, endDay: endC }
    : section === "titles" || section === "images"
      ? { startDay: startC, endDay: endC }
      : { startDay: start, endDay: end };

  let payload: unknown = null;
  let credits = 0;
  let remaining: number | null = null;

  if (section === "overview") {
    const [adv, host] = await Promise.all([
      goanyTransparencyDomain(apiKey, domain),
      goanyDomainSearch(apiKey, domain),
    ]);
    if (!adv.data && !host.data) {
      return NextResponse.json({ error: adv.error ?? host.error ?? "no_data", provider: "goanyapi" }, { status: 502 });
    }
    payload = {
      advertisers: adv.data ?? [],
      hostId: host.data?.id ?? null,
      host: host.data?.host ?? null,
      note: host.data ? undefined : (host.error ?? "domain_search_empty"),
    };
    credits = (adv.credits ?? 0) + (host.credits ?? 0);
    remaining = adv.remaining ?? host.remaining;
  } else if (section === "titles") {
    const r = await goanyDomainTitles(apiKey, hostId!, dates.startDay, dates.endDay);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data", provider: "goanyapi" }, { status: 502 });
    payload = r.data;
    credits = r.credits;
    remaining = r.remaining;
  } else if (section === "statistics") {
    const r = await goanyDomainStatistics(apiKey, hostId!, dates.startDay, dates.endDay);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data", provider: "goanyapi" }, { status: 502 });
    payload = r.data;
    credits = r.credits;
    remaining = r.remaining;
  } else if (section === "images") {
    const r = await goanyDomainImageAds(apiKey, hostId!, dates.startDay, dates.endDay);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data", provider: "goanyapi" }, { status: 502 });
    payload = r.data;
    credits = r.credits;
    remaining = r.remaining;
  } else if (section === "keyword") {
    const r = await goanyTransparencyKeyword(apiKey, cacheKey);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data", provider: "goanyapi" }, { status: 502 });
    payload = r.data;
    credits = r.credits;
    remaining = r.remaining;
  } else {
    const r = await goanyTitleCountries(apiKey, hostId ?? 0, cacheKey, dates.startDay, dates.endDay);
    if (!r.data) return NextResponse.json({ error: r.error ?? "no_data", provider: "goanyapi" }, { status: 502 });
    payload = r.data;
    credits = r.credits;
    remaining = r.remaining;
  }

  await writeCache(payload, cacheKey);
  return NextResponse.json({
    domain, section, ...(cacheKey ? { title: cacheKey } : {}),
    payload, cached: false, checkedAt: new Date().toISOString(),
    credits, remainingCredits: remaining,
  });
}
