// Site moves across Search Console properties — another domain, or a subdomain that is its own
// URL-prefix property. Pure module: the chain walk, cycle guard, recovery maths and the move
// detector are shared by the route, the modal and tests.
//
// A chain is linear on purpose: each site has at most one move out and one move in. That is how
// grey-niche operators actually move (A blocked → B, B blocked → C), and it keeps "the brand's
// traffic over time" a single, unambiguous line.

export const MOVE_REASONS = ["block_regulator", "block_isp", "google_penalty", "rebrand", "other"] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

export function normalizeReason(v: unknown): MoveReason {
  return (MOVE_REASONS as readonly string[]).includes(String(v)) ? (v as MoveReason) : "other";
}

export interface SiteMoveRow {
  id: string;
  fromSiteId: string;
  toSiteId: string;
  /** YYYY-MM-DD */
  date: string;
  reason: MoveReason;
  redirect301: boolean;
  note: string | null;
}

/** Ordered site ids of the chain through `siteId`, and the moves between them (moves[i] links
 *  sites[i] → sites[i+1]). A site in no chain is a chain of one. */
export function buildChain(moves: SiteMoveRow[], siteId: string): { sites: string[]; moves: SiteMoveRow[] } {
  const out = new Map(moves.map(m => [m.fromSiteId, m]));
  const inn = new Map(moves.map(m => [m.toSiteId, m]));
  const seen = new Set<string>([siteId]);
  let head = siteId;
  for (let m = inn.get(head); m && !seen.has(m.fromSiteId); m = inn.get(head)) {
    head = m.fromSiteId;
    seen.add(head);
  }
  const sites = [head];
  const chainMoves: SiteMoveRow[] = [];
  const walked = new Set([head]);
  for (let m = out.get(head); m && !walked.has(m.toSiteId); m = out.get(sites[sites.length - 1])) {
    chainMoves.push(m);
    sites.push(m.toSiteId);
    walked.add(m.toSiteId);
  }
  return { sites, moves: chainMoves };
}

/** Why a new move from → to cannot be added, or null when it can. */
export function moveConflict(moves: SiteMoveRow[], fromSiteId: string, toSiteId: string): "same_site" | "has_outgoing" | "has_incoming" | "cycle" | null {
  if (fromSiteId === toSiteId) return "same_site";
  if (moves.some(m => m.fromSiteId === fromSiteId)) return "has_outgoing";
  if (moves.some(m => m.toSiteId === toSiteId)) return "has_incoming";
  // Adding from → to closes a loop when `from` is already reachable from `to`.
  const out = new Map(moves.map(m => [m.fromSiteId, m.toSiteId]));
  const seen = new Set<string>();
  for (let cur: string | undefined = toSiteId; cur && !seen.has(cur); cur = out.get(cur)) {
    if (cur === fromSiteId) return "cycle";
    seen.add(cur);
  }
  return null;
}

export interface DayClicks { day: string; clicks: number }

const addDay = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Recovery {
  /** Old site's average daily clicks over the baseline window before the move. */
  baseline: number;
  /** Days after the move until the new site's 7-day median first reached 50% / 80% of baseline;
   *  null while not reached. */
  daysTo50: number | null;
  daysTo80: number | null;
  /** New site's last-7-days median as a % of baseline; null without a baseline. */
  nowPct: number | null;
  /** Days of new-site data after the move — how much there is to judge on. */
  daysObserved: number;
}

/**
 * How the new site caught up with the old one. The baseline is the OLD site's traffic before the
 * move (what the brand had), the progress is the NEW site's 7-day MEDIAN after it — a median, not
 * a mean, so one spike day (a viral post, a bot burst) cannot mark the move as recovered. Missing days are zeros: a day Search Console has
 * no row for is a day with no clicks, and treating it as absent would let a thin series look
 * better than it is.
 */
export function recovery(oldDaily: DayClicks[], newDaily: DayClicks[], moveDay: string, today: string, baselineDays = 28): Recovery {
  const oldBy = new Map(oldDaily.map(d => [d.day, d.clicks]));
  const newBy = new Map(newDaily.map(d => [d.day, d.clicks]));
  let sum = 0;
  for (let i = 1; i <= baselineDays; i++) sum += oldBy.get(addDay(moveDay, -i)) ?? 0;
  const baseline = sum / baselineDays;

  const daysObserved = Math.max(0, Math.round((+new Date(`${today}T00:00:00Z`) - +new Date(`${moveDay}T00:00:00Z`)) / 86400000) + 1);
  let daysTo50: number | null = null, daysTo80: number | null = null;
  const win: number[] = [];
  let avg = 0;
  for (let i = 0; i < daysObserved; i++) {
    win.push(newBy.get(addDay(moveDay, i)) ?? 0);
    if (win.length > 7) win.shift();
    avg = median(win);
    if (baseline > 0 && win.length === 7) {
      if (daysTo50 == null && avg >= baseline * 0.5) daysTo50 = i;
      if (daysTo80 == null && avg >= baseline * 0.8) daysTo80 = i;
    }
  }
  return {
    baseline: Math.round(baseline * 10) / 10,
    daysTo50, daysTo80,
    nowPct: baseline > 0 && daysObserved >= 7 ? Math.round((avg / baseline) * 100) : null,
    daysObserved,
  };
}

export interface MoveCandidate { fromSiteId: string; toSiteId: string; date: string; evidence: "redirect" | "traffic" }

/**
 * Traffic-shaped move suggestions: A loses most of its clicks while B, which had next to nothing
 * before, starts getting them within a fortnight of that drop. Only a suggestion — the operator
 * confirms, because a seasonal site and a new launch in the same week look the same.
 *
 * `series` maps site id → daily clicks (any order). `today` anchors the windows.
 */
export function detectTrafficMoves(series: Map<string, DayClicks[]>, today: string, opts = { minBaseline: 10, dropTo: 0.4, window: 14 }): MoveCandidate[] {
  const avg = (by: Map<string, number>, from: string, days: number) => {
    let s = 0;
    for (let i = 0; i < days; i++) s += by.get(addDay(from, i)) ?? 0;
    return s / days;
  };
  const maps = new Map([...series].map(([id, rows]) => [id, new Map(rows.map(r => [r.day, r.clicks]))]));
  const firstDay = (by: Map<string, number>) => [...by.entries()].filter(([, c]) => c > 0).map(([d]) => d).sort()[0] ?? null;

  // A drop day for A: the earliest day in the last 120 where the next `window` days average below
  // dropTo × the 28 days before it.
  const drops: { id: string; day: string }[] = [];
  for (const [id, by] of maps) {
    for (let back = 120; back >= opts.window; back--) {
      const day = addDay(today, -back);
      const before = avg(by, addDay(day, -28), 28);
      if (before < opts.minBaseline) continue;
      if (avg(by, day, opts.window) <= before * opts.dropTo) { drops.push({ id, day }); break; }
    }
  }
  const out: MoveCandidate[] = [];
  for (const d of drops) {
    for (const [id, by] of maps) {
      if (id === d.id) continue;
      const start = firstDay(by);
      if (!start) continue;
      const gap = Math.abs((+new Date(`${start}T00:00:00Z`) - +new Date(`${d.day}T00:00:00Z`)) / 86400000);
      // B must be new around the drop and actually pick traffic up afterwards.
      if (gap <= opts.window && avg(by, d.day, opts.window) >= 1) {
        out.push({ fromSiteId: d.id, toSiteId: id, date: d.day, evidence: "traffic" });
      }
    }
  }
  return out;
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/** Host a stored Site.url stands for: "sc-domain:x.com" → x.com, "https://www.x.com/" → x.com. */
export function siteHost(siteUrl: string): string | null {
  const s = String(siteUrl || "").trim();
  if (/^sc-domain:/i.test(s)) return bareHost(s.replace(/^sc-domain:/i, "")) || null;
  try { return bareHost(new URL(s).hostname); } catch { return null; }
}

/** Homepage to probe for a redirect: the property's own URL, or https://<domain>/ for sc-domain:. */
export function siteRootUrl(siteUrl: string): string | null {
  const s = String(siteUrl || "").trim();
  if (/^sc-domain:/i.test(s)) {
    const h = s.replace(/^sc-domain:/i, "").replace(/\.$/, "");
    return h ? `https://${h}/` : null;
  }
  try { const u = new URL(s); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return null; }
}

/**
 * Which of the user's other sites a homepage ended up on after its redirects, if any. Same host
 * (www, a trailing dot, http→https) is not a move. A redirect to a subdomain of the same domain
 * IS one when that subdomain is a separate site in OpenGSC — that is exactly the separate-property
 * case E3 exists for.
 */
export function redirectTarget(fromSiteUrl: string, finalUrl: string, sites: { id: string; url: string }[]): string | null {
  const from = siteHost(fromSiteUrl);
  let to: string;
  try { to = bareHost(new URL(finalUrl).hostname); } catch { return null; }
  if (!from || to === from) return null;
  return sites.find(s => siteHost(s.url) === to)?.id ?? null;
}
