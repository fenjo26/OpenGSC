/**
 * Server-log aggregation: one streaming pass collects raw counts, then `finalize` applies the
 * reverse-DNS verdicts and produces the stored summary.
 *
 * Why two steps: whether a "Googlebot" line is Google is only known after its IP has been looked
 * up, and looking up while streaming would serialise hundreds of DNS round trips. So lines from
 * crawlers that CAN be verified are kept per IP (day, status class and path counters), the unique
 * IPs are verified in parallel afterwards, and fake ones are dropped from every Googlebot figure.
 * Everything else is counted per family on the fly.
 *
 * Bounded memory: per-IP path counters stop growing at MAX_PATH_ENTRIES in total (later paths
 * still count in hits, days and statuses), and the stored path map is capped at STORED_PATHS.
 *
 * Pure.
 */
import { classifyUserAgent, familyById, type BotKind } from "./bots";

export type IpVerdict = "verified" | "fake" | "unknown";

const MAX_PATH_ENTRIES = 300_000;
export const STORED_PATHS = 20_000;
const TOP = 50;

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
const statusClass = (s: number): StatusClass => s >= 200 && s < 300 ? "2xx" : s < 400 && s >= 300 ? "3xx" : s >= 400 && s < 500 ? "4xx" : s >= 500 && s < 600 ? "5xx" : "other";
const day = (d: Date) => d.toISOString().slice(0, 10);

interface PathStat { hits: number; last: number; status: number }
interface IpBucket {
  family: string;
  hits: number;
  last: number;
  byDay: Map<string, number>;
  statuses: Map<StatusClass, number>;
  paths: Map<string, PathStat>;
}
interface FamilyBucket { hits: number; last: number; paths: Map<string, number> }

export interface LogFamilySummary {
  id: string;
  label: string;
  kind: BotKind;
  hits: number;
  /** Verifiable families only: hits from IPs whose reverse DNS confirmed the crawler. */
  verified?: number;
  /** Verifiable families only: hits from IPs that claimed the crawler but are not it. */
  fake?: number;
  /** Verifiable families only: IPs that could not be checked (DNS timeout, cap reached). */
  unverified?: number;
  lastSeen: string | null;
  /** Unverifiable families: their most requested paths. */
  topPaths?: { path: string; hits: number }[];
}

export interface LogSummary {
  version: 1;
  lines: number;
  parsed: number;
  skipped: number;
  from: string | null;
  to: string | null;
  /** Days between the first and last line, inclusive. */
  days: number;
  /** Lines from ordinary browsers (no bot user agent). */
  humanHits: number;
  families: LogFamilySummary[];
  /** Googlebot, fake IPs excluded (verified + unverifiable-for-now). */
  google: {
    hits: number;
    byDay: { date: string; hits: number }[];
    statuses: Record<StatusClass, number>;
    distinctPaths: number;
    topPaths: { path: string; hits: number; lastSeen: string; status: number }[];
    errorPaths: { path: string; hits: number; status: number }[];
    /** path → hits, for the audit join; capped at STORED_PATHS (most hit first). */
    paths: Record<string, number>;
    pathsTruncated: boolean;
  };
  /** A sample of IPs that claimed a verifiable crawler and failed the reverse-DNS check. */
  fakeIps: { ip: string; family: string; hits: number }[];
  /** false = reverse DNS did not work on the server; crawler claims are then all unverified. */
  dnsAvailable: boolean;
}

export class LogAggregator {
  lines = 0;
  parsed = 0;
  skipped = 0;
  humanHits = 0;
  from = Infinity;
  to = -Infinity;
  private ips = new Map<string, IpBucket>();
  private families = new Map<string, FamilyBucket>();
  private pathEntries = 0;

  /** Feed one parsed line (or null for a line that did not parse). */
  add(entry: { ip: string; time: Date; path: string; status: number; ua: string | null } | null): void {
    this.lines++;
    if (!entry) { this.skipped++; return; }
    this.parsed++;
    const t = entry.time.getTime();
    if (t < this.from) this.from = t;
    if (t > this.to) this.to = t;
    const family = classifyUserAgent(entry.ua);
    if (!family) { this.humanHits++; return; }
    if (family.rdns) {
      let b = this.ips.get(entry.ip);
      if (!b) {
        b = { family: family.id, hits: 0, last: 0, byDay: new Map(), statuses: new Map(), paths: new Map() };
        this.ips.set(entry.ip, b);
      }
      b.hits++;
      if (t > b.last) b.last = t;
      const d = day(entry.time);
      b.byDay.set(d, (b.byDay.get(d) ?? 0) + 1);
      const sc = statusClass(entry.status);
      b.statuses.set(sc, (b.statuses.get(sc) ?? 0) + 1);
      const p = b.paths.get(entry.path);
      if (p) {
        p.hits++;
        if (t >= p.last) { p.last = t; p.status = entry.status; }
      } else if (this.pathEntries < MAX_PATH_ENTRIES) {
        b.paths.set(entry.path, { hits: 1, last: t, status: entry.status });
        this.pathEntries++;
      }
      return;
    }
    let f = this.families.get(family.id);
    if (!f) { f = { hits: 0, last: 0, paths: new Map() }; this.families.set(family.id, f); }
    f.hits++;
    if (t > f.last) f.last = t;
    if (f.paths.size < 5000 || f.paths.has(entry.path)) f.paths.set(entry.path, (f.paths.get(entry.path) ?? 0) + 1);
  }

  /** The IPs that need a reverse-DNS verdict, most active first. */
  ipsToVerify(): { ip: string; family: string; hits: number }[] {
    return [...this.ips].map(([ip, b]) => ({ ip, family: b.family, hits: b.hits })).sort((a, b) => b.hits - a.hits);
  }

  finalize(verdicts: ReadonlyMap<string, IpVerdict>, opts: { dnsAvailable?: boolean } = {}): LogSummary {
    const iso = (t: number) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null);
    const families: LogFamilySummary[] = [];

    // Verifiable families, per IP.
    const byFamily = new Map<string, { hits: number; verified: number; fake: number; unverified: number; last: number }>();
    const fakeIps: LogSummary["fakeIps"] = [];
    const g = { hits: 0, byDay: new Map<string, number>(), statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 } as Record<StatusClass, number>, paths: new Map<string, PathStat>() };
    for (const [ip, b] of this.ips) {
      const verdict = verdicts.get(ip) ?? "unknown";
      const acc = byFamily.get(b.family) ?? { hits: 0, verified: 0, fake: 0, unverified: 0, last: 0 };
      acc.hits += b.hits;
      if (verdict === "verified") acc.verified += b.hits;
      else if (verdict === "fake") acc.fake += b.hits;
      else acc.unverified += b.hits;
      if (verdict !== "fake" && b.last > acc.last) acc.last = b.last;
      byFamily.set(b.family, acc);
      if (verdict === "fake") { fakeIps.push({ ip, family: b.family, hits: b.hits }); continue; }
      if (b.family !== "google") continue;
      g.hits += b.hits;
      for (const [d, n] of b.byDay) g.byDay.set(d, (g.byDay.get(d) ?? 0) + n);
      for (const [sc, n] of b.statuses) g.statuses[sc] += n;
      for (const [path, s] of b.paths) {
        const cur = g.paths.get(path);
        if (!cur) g.paths.set(path, { ...s });
        else {
          cur.hits += s.hits;
          if (s.last >= cur.last) { cur.last = s.last; cur.status = s.status; }
        }
      }
    }
    for (const [id, acc] of byFamily) {
      const fam = familyById(id);
      families.push({
        id, label: fam?.label ?? id, kind: fam?.kind ?? "search",
        hits: acc.hits, verified: acc.verified, fake: acc.fake, unverified: acc.unverified,
        lastSeen: iso(acc.last),
      });
    }
    for (const [id, f] of this.families) {
      const fam = familyById(id);
      families.push({
        id, label: fam?.label ?? id, kind: fam?.kind ?? "other", hits: f.hits, lastSeen: iso(f.last),
        topPaths: [...f.paths].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, hits]) => ({ path, hits })),
      });
    }
    const kindOrder: Record<BotKind, number> = { search: 0, ai: 1, seo: 2, other: 3 };
    families.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.hits - a.hits);

    const paths = [...g.paths].sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0]));
    const from = iso(this.from), to = iso(this.to);
    const days = from && to ? Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000) + 1 : 0;
    return {
      version: 1,
      lines: this.lines, parsed: this.parsed, skipped: this.skipped,
      from, to, days,
      humanHits: this.humanHits,
      families,
      google: {
        hits: g.hits,
        byDay: [...g.byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([date, hits]) => ({ date, hits })),
        statuses: g.statuses,
        distinctPaths: g.paths.size,
        topPaths: paths.slice(0, TOP).map(([path, s]) => ({ path, hits: s.hits, lastSeen: new Date(s.last).toISOString(), status: s.status })),
        errorPaths: paths.filter(([, s]) => s.status >= 400).slice(0, TOP).map(([path, s]) => ({ path, hits: s.hits, status: s.status })),
        paths: Object.fromEntries(paths.slice(0, STORED_PATHS).map(([path, s]) => [path, s.hits])),
        pathsTruncated: paths.length > STORED_PATHS,
      },
      fakeIps: fakeIps.sort((a, b) => b.hits - a.hits).slice(0, 10),
      dnsAvailable: opts.dnsAvailable ?? true,
    };
  }
}

/**
 * Key a request path the way the audit keys a crawled URL's path: trailing slash dropped (root
 * kept), query kept, fragment never present in logs. Lets the audit ask "did Googlebot request
 * this page" without caring about the host.
 */
export function logPathKey(pathOrUrl: string): string {
  let path = pathOrUrl;
  if (/^https?:\/\//i.test(path)) {
    try { const u = new URL(path); path = u.pathname + u.search; } catch { return ""; }
  }
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  const search = q >= 0 ? path.slice(q) : "";
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* keep as logged */ }
  const trimmed = decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
  return (trimmed || "/") + search;
}
