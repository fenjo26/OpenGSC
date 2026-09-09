// Semrush Traffic Analytics (TA) — estimated traffic for any domain, from the same gateway
// and key that serve the Semrush metrics reports.
//
// The second traffic provider, next to GoAnyAPI (`goanyapi.ts`). GoAnyAPI answers one request
// with everything; Semrush TA is report-per-call — summary, monthly series and channel split
// are three calls — but each costs 1 unit (≈ $0.00006), and the figures arrive with a monthly
// series GoAnyAPI has to be asked for separately. Both normalize into the same
// {@link DomainTraffic} shape, so the cache, the chip and the MCP tool cannot tell the
// vendors apart — except through the `provider` field, which is the point: the chip labels
// its source and the store keeps one row per provider.
//
// TA is path-based (`/analytics/ta/api/v3/<report>`), answers CSV with `;` delimiters, and
// signals failure through HTTP status plus its own ERROR vocabulary — the same numeric codes
// the backlinks reports use, restated here in HTTP terms the UI already diagnoses. Column
// names are read case-insensitively across the spellings the TA vocabulary has used; a column
// that never arrives leaves its field null rather than inventing a zero.
//
// Two documented quirks this module honours:
//   • the geo report returns macro-regions (NA, EMEA…), not countries — so it is simply not
//     called, and `topCountries` stays empty instead of filled with the wrong semantics;
//   • TA data lags ~2 months, so `period` (the month the figures describe) always travels
//     with the answer and the UI shows it.

import { loggedFetch, type CallHandle } from "@/lib/providerLog/log";
import type { DomainTraffic, TrafficMonth, TrafficCountry, TrafficKeyword, TrafficSources } from "./goanyapi";

export interface TaCreds { apiKey: string; baseUrl?: string }

export interface TaResult {
  data: DomainTraffic | null;
  /** TA reports bill ~1 unit per request; the sum across the calls actually made. */
  units: number;
  error?: string;
}

const DEFAULT_BASE = "https://api-semrush.groupbuyseo.org";
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Read one CSV row field across the names it may ship under, case-insensitively. */
export function taPick(row: Record<string, any>, ...names: string[]): any {
  const lower = new Map(Object.keys(row).map(k => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k != null && row[k] !== "" && row[k] != null) return row[k];
  }
  return null;
}

/** TA answers CSV with `;` separators — same convention as the standard SEO reports. */
export function parseTaCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0].split(";");
  return lines.slice(1).map(line => {
    const cells = line.split(";");
    return Object.fromEntries(head.map((h, i) => [h.trim(), (cells[i] ?? "").trim()]));
  });
}

/** Monthly visits series, chronological — everything downstream draws it as a trend. */
export function parseTaMonthly(rows: Record<string, any>[]): TrafficMonth[] {
  return rows
    .map(r => ({
      month: String(taPick(r, "display_date", "date", "month") ?? "").slice(0, 7),
      visits: num(taPick(r, "visits")) ?? 0,
    }))
    .filter(m => /^\d{4}-\d{2}$/.test(m.month))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Channel shares. Rows carry a channel name and either a share or raw visits — when only
 * visits arrive, the share is computed against the summary's total, because every consumer
 * of {@link TrafficSources} expects fractions summing to ~1.
 *
 * Mapping order matters: "Paid Search" contains "search", "Generative AI" contains nothing
 * safe to substring-match after the others have run — so the specific channels are matched
 * before their generic parents, and GenAI (the reason this data is wired at all) first.
 */
export function parseTaSources(rows: Record<string, any>[], totalVisits: number | null): TrafficSources {
  const out: TrafficSources = {
    direct: null, search: null, searchPaid: null, social: null, socialPaid: null,
    referrals: null, mail: null, displayAds: null, affiliate: null, genAI: null,
  };
  const slot = (channel: string): keyof TrafficSources | null => {
    const c = channel.toLowerCase();
    if (/generative|gen\s*ai|ai\s*chat/.test(c)) return "genAI";
    if (/paid\s*search|search\s*paid|ppc|adwords/.test(c)) return "searchPaid";
    if (/organic\s*search|search\s*organic|^search$/.test(c)) return "search";
    if (/paid\s*social|social\s*paid|sponsored\s*social/.test(c)) return "socialPaid";
    if (/social/.test(c)) return "social";
    if (/referral/.test(c)) return "referrals";
    if (/e-?mail/.test(c)) return "mail";
    if (/display/.test(c)) return "displayAds";
    if (/affiliate/.test(c)) return "affiliate";
    if (/direct/.test(c)) return "direct";
    return null;
  };
  const shareOf = (r: Record<string, any>): number | null => {
    const share = num(taPick(r, "share", "visits_share", "share_percent", "percent", "visits_percentage"));
    if (share != null) return share <= 1 ? share : share / 100;
    const visits = num(taPick(r, "visits"));
    if (visits != null && totalVisits) return visits / totalVisits;
    return null;
  };
  for (const r of rows) {
    const channel = String(taPick(r, "traffic_channel", "channel", "source") ?? "");
    if (!channel) continue;
    const key = slot(channel);
    if (key && out[key] == null) out[key] = shareOf(r);
  }
  return out;
}

async function taCall(
  creds: TaCreds, report: string, params: Record<string, string>,
): Promise<{ rows: Record<string, any>[]; error?: string }> {
  const base = (creds.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const search = new URLSearchParams({ key: creds.apiKey, ...params });
  let res: Response;
  let call: CallHandle;
  try {
    ({ res, call } = await loggedFetch(
      `${base}/analytics/ta/api/v3/${report}?${search}`,
      { headers: { Accept: "text/plain, application/json" }, signal: AbortSignal.timeout(45_000) },
      { provider: "semrush", attempt: 1 },
    ));
  } catch (e: any) {
    return { rows: [], error: `semrush network: ${e?.cause?.code || e?.message || "fetch failed"}` };
  }
  const text = (await res.text().catch(() => "")).trim();
  if (!res.ok) {
    // 401 bad key, 403 not enough units, 429 rate limit — the documented TA statuses,
    // restated in the HTTP vocabulary the notices already diagnose.
    const status = res.status === 403 ? 402 : res.status;
    const error = `semrush ${status}: ${text.slice(0, 300) || res.statusText}`;
    call.finish({ error });
    return { rows: [], error };
  }
  if (/^ERROR/i.test(text)) {
    const code = /^ERROR\s*(\d+)/i.exec(text)?.[1] ?? "";
    const status = code === "401" ? 401 : code === "132" ? 402 : code === "50" ? 200 : 400;
    if (status === 200) { call.finish(); return { rows: [] }; } // NOTHING FOUND = no data, a valid answer
    const error = `semrush ${status}: ${text.slice(0, 300)}`;
    call.finish({ error });
    return { rows: [], error };
  }
  call.finish();
  return { rows: parseTaCsv(text) };
}

/**
 * Traffic estimates for one domain: the summary report plus two one-unit companions (monthly
 * series, channel split). Every report is allowed to come back empty independently — a domain
 * the TA index has not seen yields a null there, never a fabricated zero, and a domain with
 * no data at all yields `data: null` with the reason.
 */
export async function semrushTraffic(creds: TaCreds, domain: string): Promise<TaResult> {
  if (!creds.apiKey?.trim()) return { data: null, units: 0, error: "no_key" };

  const summary = await taCall(creds, "summary", { targets: domain });
  if (summary.error) return { data: null, units: 0, error: summary.error };
  const row = summary.rows[0] ?? {};

  // The two companion reports run after the summary has proven the domain exists — spending
  // their units on a domain TA has never seen would buy two more copies of "empty".
  let units = summary.rows.length ? 1 : 0;
  const [monthlyRes, sourcesRes] = await Promise.all([
    taCall(creds, "summary_by_day", { target: domain, export_columns: "display_date,visits" }),
    taCall(creds, "sources", { target: domain }),
  ]);
  if (monthlyRes.rows.length) units += 1;
  if (sourcesRes.rows.length) units += 1;

  const visits = num(taPick(row, "visits"));
  const monthly = parseTaMonthly(monthlyRes.rows);
  const data: DomainTraffic = {
    provider: "semrush",
    domain,
    siteName: null,
    title: null,
    description: null,
    period: monthly.at(-1)?.month ?? null,
    visits: visits ?? monthly.at(-1)?.visits ?? null,
    bounceRate: num(taPick(row, "bounce_rate")),
    timeOnSite: num(taPick(row, "avg_visit_duration", "average_visit_duration")),
    pagesPerVisit: num(taPick(row, "pages_per_visit", "pages_per_visit_avg")),
    globalRank: num(taPick(row, "rank")),
    countryCode: null,
    countryRank: null,
    monthly,
    sources: parseTaSources(sourcesRes.rows, visits),
    topCountries: [] as TrafficCountry[],
    topKeywords: [] as TrafficKeyword[],
  };

  const hasAnything = data.visits != null || monthly.length > 0 || Object.values(data.sources).some(v => v != null);
  if (!hasAnything) {
    return { data: null, units, error: summary.rows.length ? "no_data" : undefined };
  }
  return { data, units };
}
