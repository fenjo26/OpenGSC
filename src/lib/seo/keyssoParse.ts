/* eslint-disable @typescript-eslint/no-explicit-any -- this module's whole job is reading untyped gateway JSON */
// Keys.so (Yandex/Runet SEO data) — the pure half: response parsing, field mapping and the
// retry plan. No imports, no network, so every rule here is unit-tested without a gateway.
//
// Three facts about the API shape everything below:
//
// 1. **Field names are not pinned.** Both the official docs and the GroupBuySEO gateway docs
//    call their sample fields "illustrative". Every row is therefore read through `ksPick`,
//    which tries the plausible names case-insensitively, and the raw row always travels along
//    in `payload` — a renamed column degrades to an em dash, never to a wrong number.
// 2. **HTTP 202 is not an error.** It means "the report is being built, ask again", and it is
//    not billed. It is polled with its own back-off, separate from the 429/5xx retry.
// 3. **Billing is per request, not per row.** One credit per 2xx GET whatever `per_page` is,
//    so totals are read from the pagination envelope of a one-row page.

/** Read one field across the names it may ship under, case-insensitively. */
export function ksPick(row: Record<string, any> | null | undefined, ...names: string[]): any {
  if (!row || typeof row !== "object") return null;
  const lower = new Map(Object.keys(row).map(k => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k != null && row[k] !== "" && row[k] != null) return row[k];
  }
  return null;
}

const ksNum = (v: any): number | null => {
  if (v == null || v === "") return null;
  const n = Number(typeof v === "string" ? v.replace(/[\s,]/g, "") : v);
  return Number.isFinite(n) ? n : null;
};

export interface KeyssoEnvelope {
  rows: Record<string, any>[];
  total: number | null;
  page: number | null;
  lastPage: number | null;
}

/**
 * The list envelope `{ current_page, per_page, last_page, total, data[] }`. A bare array is
 * accepted too (some reports answer without the wrapper), with `total` left unknown rather
 * than guessed from the page length.
 */
export function parseKeyssoEnvelope(body: any): KeyssoEnvelope {
  if (Array.isArray(body)) return { rows: body.filter(r => r && typeof r === "object"), total: null, page: null, lastPage: null };
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body?.items) ? body.items : [];
  return {
    rows: data.filter((r: any) => r && typeof r === "object"),
    total: ksNum(ksPick(body, "total", "count", "total_count")),
    page: ksNum(ksPick(body, "current_page", "page")),
    lastPage: ksNum(ksPick(body, "last_page", "pages", "total_pages")),
  };
}

/**
 * `domain_dashboard` → the shared domain shape. Only `dr` maps to a shared column: Keys.so's
 * visibility (`vis`) and top-50 count (`it50`) are Yandex measures with no Ahrefs counterpart,
 * so `orgTraffic`/`orgKeywords` stay null and those figures ride in `payload` under their own
 * names. Inventing an equivalence would put Yandex numbers in a Google column.
 */
export function mapKeyssoDashboard(body: any): { dr: number | null; vis: number | null; it50: number | null; raw: any } {
  const d = body?.data && !Array.isArray(body.data) ? body.data : body;
  return {
    dr: ksNum(ksPick(d, "dr", "domain_dr", "domainRank", "domain_rank")),
    vis: ksNum(ksPick(d, "vis", "visibility")),
    it50: ksNum(ksPick(d, "it50", "top50", "keys50")),
    raw: d ?? null,
  };
}

export interface KeyssoRefDomain {
  refDomain: string;
  dr: number | null;
  linksToTarget: number | null;
  /** null when the row carries no follow flag — the percentage then stays honestly unknown. */
  nofollow: boolean | null;
  firstSeen: string;
  ip: string;
}

const cleanHost = (v: any) => String(v ?? "").trim().toLowerCase()
  .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

/** One `links/backlinks-domains` row, or null when it names no domain. */
export function mapKeyssoRefDomain(r: Record<string, any>): KeyssoRefDomain | null {
  const refDomain = cleanHost(ksPick(r, "domain", "donor", "donor_domain", "source_domain", "name", "host", "url"));
  if (!refDomain.includes(".")) return null;
  const nf = ksPick(r, "nofollow", "is_nofollow");
  const df = ksPick(r, "dofollow", "is_dofollow");
  const nofollow = nf != null ? Boolean(Number(nf)) : df != null ? !Number(df) : null;
  return {
    refDomain,
    dr: ksNum(ksPick(r, "dr", "donor_dr", "domain_dr")),
    linksToTarget: ksNum(ksPick(r, "links", "backlinks", "links_count", "count", "cnt")),
    nofollow,
    firstSeen: String(ksPick(r, "first_seen", "firstSeen", "date_first", "first_date", "created_at", "date") ?? ""),
    ip: String(ksPick(r, "ip") ?? ""),
  };
}

/**
 * Remaining credits from `/limits/all`. The gateway fills the official limits object with its
 * own balance; `apiRequest` is the documented counter, but its exact nesting is not, so the
 * key is searched at any depth and may be a number or an object carrying one.
 */
export function keyssoRemainingCredits(body: any): number | null {
  const seen = new Set<any>();
  const walk = (v: any, depth: number): number | null => {
    if (!v || typeof v !== "object" || depth > 4 || seen.has(v)) return null;
    seen.add(v);
    for (const [k, val] of Object.entries(v)) {
      if (k.toLowerCase() !== "apirequest") continue;
      const direct = ksNum(val);
      if (direct != null) return direct;
      const inner = ksNum(ksPick(val as any, "remaining", "left", "available", "value", "count"));
      if (inner != null) return inner;
    }
    for (const val of Object.values(v)) {
      const hit = walk(val, depth + 1);
      if (hit != null) return hit;
    }
    return null;
  };
  return walk(body, 0);
}

/**
 * Error text in the module-wide `<provider> <status>: <message>` form, so
 * `gatewayStatusFromError` diagnoses Keys.so refusals (401 key, 402 out of credits, 429…)
 * with no Keys.so branch anywhere downstream.
 */
export function keyssoErrorText(status: number, body: string): string {
  let msg = body.slice(0, 300);
  try { const j = JSON.parse(body); if (j && typeof j.message === "string") msg = j.message; } catch { /* plain text */ }
  return `keysso ${status}: ${msg}`.trim();
}

/** Back-off for 202 ("not ready yet"): 3 s, 6 s, 12 s, 24 s — then give up. */
export const KEYSSO_202_DELAYS_MS = [3000, 6000, 12000, 24000];
/** Retries for 429/5xx on top of the first attempt. */
export const KEYSSO_ERROR_RETRIES = 2;

/**
 * What to do after a response. `pending` counts 202s seen so far, `failures` 429/5xx so far.
 * Pure, so the whole retry policy is pinned by tests rather than by reading a loop.
 */
export function keyssoNextStep(
  status: number, pending: number, failures: number,
): { action: "done" } | { action: "wait"; ms: number; kind: "pending" | "retry" } | { action: "give_up"; reason: string } {
  if (status === 202) {
    if (pending >= KEYSSO_202_DELAYS_MS.length) return { action: "give_up", reason: "keysso 202: report not ready" };
    return { action: "wait", ms: KEYSSO_202_DELAYS_MS[pending], kind: "pending" };
  }
  if (status === 429 || status >= 500) {
    if (failures >= KEYSSO_ERROR_RETRIES) return { action: "done" };
    return { action: "wait", ms: 800 * 2 ** failures, kind: "retry" };
  }
  return { action: "done" };
}

// ─── Yandex AI answers (`organic/ai-answers`, `organic/ai-concurents`) ─────────
//
// `ai_answer` arrives as HTML (Keys.so's own rendering, with `<a href>` source links). It is
// never rendered: only the source hosts are read out of it, in order, so the panel can say
// where in the answer's sources this site sits. Showing the answer text would mean shipping
// third-party HTML into the page for very little — the question and the cited URL are the fact.

export interface KeyssoAiAnswer {
  query: string;
  /** Wordstat broad frequency (`ws`) and exact-phrase frequency (`wsk`). */
  ws: number | null;
  wsk: number | null;
  /** This site's first cited URL in the answer, and its 1-based place among the source hosts. */
  url: string;
  rank: number | null;
  /** Distinct source hosts in answer order, capped — enough to see who stands beside us. */
  sources: string[];
}

const SOURCE_CAP = 8;

/** Hosts of every `href` in an answer, deduplicated, in order of appearance. */
export function keyssoAnswerSources(html: string): { host: string; url: string }[] {
  const out: { host: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of String(html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const url = m[1];
    const host = cleanHost(url);
    if (!host.includes(".") || seen.has(host)) continue;
    seen.add(host);
    out.push({ host, url });
  }
  return out;
}

const sameSite = (host: string, own: string) => host === own || host.endsWith(`.${own}`);

export function mapKeyssoAiAnswer(r: Record<string, any>, ownDomain: string): KeyssoAiAnswer | null {
  const query = String(ksPick(r, "word", "query", "query_text", "keyword") ?? "").trim();
  if (!query) return null;
  const own = cleanHost(ownDomain);
  const sources = keyssoAnswerSources(String(ksPick(r, "ai_answer", "query_answer", "answer") ?? ""));
  const idx = sources.findIndex(s => sameSite(s.host, own));
  return {
    query,
    ws: ksNum(ksPick(r, "ws")),
    wsk: ksNum(ksPick(r, "wsk")),
    url: idx >= 0 ? sources[idx].url : "",
    rank: idx >= 0 ? idx + 1 : null,
    sources: sources.slice(0, SOURCE_CAP).map(s => s.host),
  };
}

export interface KeyssoAiCompetitor {
  domain: string;
  /** Queries whose AI answers cite both this competitor and the site (`cnt`). */
  shared: number | null;
  /** All queries whose AI answers cite the competitor (`queries_in_ai_answers`). */
  aiQueries: number | null;
}

export function mapKeyssoAiCompetitor(r: Record<string, any>): KeyssoAiCompetitor | null {
  const domain = cleanHost(ksPick(r, "name", "domain"));
  if (!domain.includes(".")) return null;
  return {
    domain,
    shared: ksNum(ksPick(r, "cnt", "common", "shared")),
    aiQueries: ksNum(ksPick(r, "queries_in_ai_answers", "ai_queries")),
  };
}
