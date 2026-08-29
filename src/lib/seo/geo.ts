// GEO Audit engine — analyzes how AI search engines (ChatGPT-style agentic web search)
// perceive a niche for a given query: which brands/sources get surfaced and cited, what
// selection factors drive ranking, and where the coverage gaps are.
//
// Stage 1 (SEARCH): call OpenAI's Responses API with the built-in `web_search` tool and
//   answer the query the way a real user would. We then mine the raw tool trace
//   (search batches, opened pages, scanned sources) and the answer's url_citation
//   annotations — the same artifacts the screenshots are built from.
// Stage 2 (ANALYZE): a second, cheaper text pass reads the answer + citations and extracts
//   the qualitative layer (brands, tags, selection-factor notes, source-type classification,
//   key entities, insight prose).
// Stage 3 (DERIVE): everything numeric (metrics, trust signals, inclusion patterns, source
//   breakdown, leaderboard scores) is computed deterministically in code from the trace.

import { extractJson } from "@/lib/seo/prompts";
import { OPENAI_FALLBACK_MODELS, OPENAI_FALLBACK_CHEAP } from "@/lib/seo/models";
import { fetchLLMDetailed } from "@/lib/llm";
import { defaultModelFor } from "@/lib/providerDefaults";
import { runGeoAparser, GEO_APARSER_PARSER } from "@/lib/seo/geoAparser";

export type GeoResult = { ok: true; data: GeoReport } | { ok: false; error: string };

// ─── Public report shape (persisted as JSON, rendered by GeoAuditReport.tsx) ─────
export interface GeoReport {
  query: string;
  language: string;
  country: string;
  model: string;
  createdAt: number;
  classification: { intent: string; intentConfidence: number; stage: string; topic: string };
  metrics: {
    searchBatches: number;
    uniqueQueries: number;
    pagesOpened: number;
    sourcesScanned: number;
    uniqueDomains: number;
    citations: number;
    scannedToCitedPct: number;
    top3ConcentrationPct: number;
    dominantType: { type: string; label: string; pct: number };
  };
  batches: GeoBatch[];
  openPages: { rank: number; domain: string; path: string; url: string }[];
  brands: GeoBrand[];
  selectionFactors: { name: string; weight: string; items: { brand: string; note: string }[] }[];
  keyEntities: { category: string; items: { name: string; count: number; brands: string[] }[] }[];
  sourceTypes: { type: string; label: string; pct: number; cites: number; domains: number }[];
  trustSignals: GeoTrustRow[];
  inclusion: { stability: string; topCount: number; signals: GeoInclusionSignal[] };
  coverageGaps: {
    missingFactors: string[];
    missingEntities: string[];
    missingSourceTypes: { type: string; note: string }[];
  };
  insights: { userSearchBehavior: string; dominantSource: string; strategicEngagement: string; opportunityGaps: string };
  answer: { text: string; citations: { n: number; domain: string; url: string; title: string }[]; chars: number };
}

export interface GeoBatch { id: string; queries: string[]; scanned: number; cited: number }
export interface GeoBrand {
  rank: number; name: string; domain: string; dominant: boolean; mentions: number; score: number;
  tags: string[]; pricing: string; support: string; featureBreadth: string;
  surfacedIn: number[]; totalQueries: number;
}
export interface GeoTrustRow { domain: string; type: string; label: string; cited: boolean; opened: boolean; cites: number; trust: number }
export interface GeoInclusionSignal { kind: "required" | "boosting" | "absent"; type: string; label: string; text: string; cites: number; brands: number; domains: string[]; note?: string }

// ─── Source-type taxonomy ────────────────────────────────────────────────────────
const TYPE_LABEL: Record<string, string> = {
  official_site: "Official site",
  ecommerce: "E-commerce",
  review_aggregator: "Review aggregator",
  listicle_editorial: "Listicle / editorial",
  forum: "Forum",
  wikipedia: "Wikipedia",
  other: "Other",
};
const ALL_TYPES = Object.keys(TYPE_LABEL);

function domainOf(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h.toLowerCase();
  } catch {
    return String(url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}
function pathOf(url: string): string {
  try { const u = new URL(url); return (u.pathname || "/") + (u.search || ""); } catch { return "/"; }
}

// Heuristic source-type guess, used as a fallback / prior before the LLM classifies.
function heuristicType(domain: string): string {
  const d = domain.toLowerCase();
  if (/(^|\.)wikipedia\.org$/.test(d) || d.endsWith("wikidata.org")) return "wikipedia";
  if (/(reddit|quora|tripadvisor|stackexchange|stackoverflow|forum|discuss|community)\./.test(d) || d.includes("forum")) return "forum";
  if (/(booking\.com|getyourguide|viator|expedia|kiwitaxi|suntransfers|mytransfers|kayak|skyscanner|amazon|ebay|aliexpress|trip\.com|omio|busbud|rome2rio|welcomepickups)/.test(d)) return "ecommerce";
  return "other";
}

// ─── OpenAI Responses API: agentic web search ────────────────────────────────────
type RawTrace = {
  batches: { id: string; queries: string[]; sources: { url: string; domain: string }[] }[];
  opened: { url: string }[];
  scannedAll: { url: string; domain: string }[];
  answerText: string;
  citations: { url: string; title: string; domain: string }[];
  /**
   * Set only by engines that REPORT a model instead of being asked for one — today just
   * A-Parser, whose free ChatGPT session serves whatever it serves. Left undefined elsewhere,
   * where the model is the one the user picked and already travels separately.
   */
  model?: string;
};

function buildSearchInput(query: string, language: string, country: string): string {
  return [
    `A user in ${country.toUpperCase()} (language: ${language}) is searching for: "${query}".`,
    `Answer as a thorough, up-to-date AI assistant would for a real buyer/visitor.`,
    `Research the open web carefully: run several searches, open and read the most relevant pages,`,
    `compare the leading providers/options by price and concrete specifics, and cite every factual`,
    `claim with the source it came from. Prefer official sites, marketplaces, and primary sources.`,
    `Write the answer in ${language}. Be specific (names, prices, links).`,
  ].join(" ");
}

// "openai" hits OpenAI's own Responses API directly. "kie" routes the same request shape through
// kie.ai's `/codex/v1/responses` endpoint, which mirrors OpenAI's Responses API 1:1 (including the
// `web_search` tool) but bills against the user's kie.ai credits instead of a separate OpenAI key.
// "gemini" runs Google's own grounding search (`google_search` tool on generateContent) on the
// user's Gemini key — a different request shape whose grounding chunks map onto the same trace.
// "aparser" is the odd one out: not a vendor API at all, but the user's own A-Parser
// installation driving the public ChatGPT surface (lib/seo/aparser.ts). It carries no
// per-token cost, reports its model rather than accepting one, and answers with sources but
// not with the search steps that found them.
export type GeoEngine = "openai" | "kie" | "gemini" | "aparser";

// Upper bound for the search call, not a target. The audit row it feeds is allowed to sit
// "processing" for 20 minutes (stale_timeout in the geo route) while runAudit is fire-and-
// forget, so the cap only has to stay under that window with room for the ~2 min analysis
// stage — 15 minutes does. With streaming on, cutting the connection also stops the
// provider's generation server-side, so a runaway search costs waiting time, not the price
// of a full completion that gets thrown away.
const SEARCH_TIMEOUT_MS = 900_000;

// Gemini grounding: google_search grounds the answer and reports webSearchQueries (what it
// searched) plus groundingChunks (the pages it actually cited) — exactly the RawTrace shape the
// report assembles from. No open_page equivalent exists, so `opened` stays empty by design.
async function runGeminiGroundedSearch(
  query: string, language: string, country: string, model: string, apiKey: string, baseUrl?: string,
): Promise<RawTrace | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  const root = (baseUrl || "").replace(/\/+$/, "") || "https://generativelanguage.googleapis.com/v1beta";
  const input = buildSearchInput(query, language, country);
  try {
    const res = await fetch(`${root}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ctrl.signal,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: input }] }],
        tools: [{ google_search: {} }],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `gemini_${res.status}: ${t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}` };
    }
    const data = await res.json();
    const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
    const parts: any[] = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    let answerText = "";
    for (const p of parts) if (typeof p?.text === "string") answerText += p.text + "\n";
    const gm = cand?.groundingMetadata ?? {};
    const queries: string[] = Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries.map((q: any) => String(q)).filter(Boolean) : [];
    const seen = new Set<string>();
    const sources: { url: string; domain: string; title: string }[] = [];
    for (const c of Array.isArray(gm.groundingChunks) ? gm.groundingChunks : []) {
      const url = c?.web?.uri ?? "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, domain: domainOf(url), title: c?.web?.title ?? "" });
    }
    return {
      batches: queries.length ? [{ id: "g1", queries, sources: sources.map(s => ({ url: s.url, domain: s.domain })) }] : [],
      opened: [],
      scannedAll: sources.map(s => ({ url: s.url, domain: s.domain })),
      answerText: answerText.trim(),
      citations: sources,
    };
  } catch (e: any) {
    return { error: e?.name === "AbortError" ? `timeout_after_${Math.round(SEARCH_TIMEOUT_MS / 60_000)}m` : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// A-Parser (FreeAI::ChatGPT) — the request and response live in lib/seo/aparser.ts. Here the
// normalised answer is mapped onto RawTrace. `apiKey` is the instance password and `baseUrl`
// its API endpoint: this engine authenticates against the user's own machine, not a vendor.
//
// `opened` stays empty for the same reason it does on the Gemini engine (geo.ts above): the
// parser reports what the answer used, not the steps that found it. `batches` would be empty
// too — and that is not merely one missing panel. An empty batch list zeroes `uniqueQueries`
// and blanks every brand's coverage bar in the leaderboard, which reads as "surfaced for
// nothing" rather than "the queries were not observable". One synthetic batch carrying the
// audit's own query and the sources actually seen states precisely what is known, which is
// what the Gemini engine does with webSearchQueries.
async function runAparserSearch(
  query: string, language: string, country: string, password: string, apiUrl: string,
  preset?: string, configPreset?: string,
): Promise<RawTrace | { error: string }> {
  const input = buildSearchInput(query, language, country);
  const r = await runGeoAparser({ baseUrl: apiUrl, password, query: input, preset, configPreset, timeoutMs: SEARCH_TIMEOUT_MS });
  if ("error" in r) return r;

  const seen = new Set<string>();
  const scannedAll: { url: string; domain: string }[] = [];
  const citations: { url: string; title: string; domain: string }[] = [];
  for (const s of r.sources) {
    if (seen.has(s.link)) continue;
    seen.add(s.link);
    const row = { url: s.link, domain: domainOf(s.link) };
    scannedAll.push(row);
    // Anything not typed "citation" is a scanned-but-uncited source — exactly the set the
    // analysis prompt asks for, and the one the Responses API never exposes.
    if (s.type === "citation") citations.push({ url: s.link, title: s.anchor, domain: row.domain });
  }
  // A preset that prints only $answer puts us in the kie.ai situation: real sources named in
  // the prose with no metadata around them. The same fallback applies rather than a report of
  // zeros — and since those links are then the only sources observed, the scanned pool mirrors
  // them instead of claiming a wider one that was never seen.
  if (citations.length === 0 && r.answer) {
    for (const c of extractLinksFromText(r.answer)) {
      citations.push(c);
      if (!seen.has(c.url)) { seen.add(c.url); scannedAll.push({ url: c.url, domain: c.domain }); }
    }
  }
  return {
    batches: [{ id: "a1", queries: [query], sources: scannedAll.map(s => ({ url: s.url, domain: s.domain })) }],
    opened: [],
    scannedAll,
    answerText: r.answer,
    citations,
    model: r.model || undefined,
  };
}

async function runWebSearch(query: string, language: string, country: string, model: string, apiKey: string, engine: GeoEngine = "openai", baseUrl?: string, aparserPreset?: string, aparserConfig?: string): Promise<RawTrace | { error: string }> {
  if (engine === "gemini") return runGeminiGroundedSearch(query, language, country, model, apiKey, baseUrl);
  if (engine === "aparser") return runAparserSearch(query, language, country, apiKey, baseUrl ?? "", aparserPreset, aparserConfig);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  const input = buildSearchInput(query, language, country);
  // Gateway override (aiBaseUrl_openai and friends): a proxy key only authenticates against the
  // proxy, so the engine must follow the same endpoint-override convention as every other AI
  // call in the app. Without this a gateway key got posted to api.openai.com, which answers
  // with OpenAI's own "Incorrect API key provided" 401.
  const root = (baseUrl || "").replace(/\/+$/, "");
  const endpoint = root ? `${root}/responses`
    : engine === "kie" ? "https://api.kie.ai/codex/v1/responses"
    : "https://api.openai.com/v1/responses";
  // Every engine on this path speaks the OpenAI Responses wire format, so all of them stream.
  // SSE events arrive while the search runs, which keeps a proxy from killing a healthy
  // multi-minute call (Cloudflare's 524 cuts a silent non-streaming response at ~100s) — and
  // aborting a stream stops the generation server-side, so hitting the cap cancels the run
  // instead of paying for a completion that is then thrown away. The terminal
  // `response.completed` event carries the same object shape the non-streaming call returns;
  // kie.ai documents `stream: true` → SSE on its Responses mirror like OpenAI's own.
  const wantsStream = true;

  async function call(toolType: string) {
    return fetch(endpoint, {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: wantsStream,
        tools: [{ type: toolType }],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        input,
      }),
    });
  }

  // SSE reader for the Responses API: ignore progress events, take the terminal
  // response.completed (or surface response.failed/incomplete) — parseResponses then consumes
  // the exact same response object the non-streaming path gets.
  async function readSse(res: Response): Promise<{ data?: any; error?: string }> {
    const reader = res.body?.getReader();
    if (!reader) return { error: "no_stream_body" };
    const decoder = new TextDecoder();
    let buf = "";
    let final: any = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let ev: any;
          try { ev = JSON.parse(payload); } catch { continue; /* keepalive/partial line */ }
          if (ev?.type === "response.completed") { final = ev.response; break; }
          if (ev?.type === "response.failed" || ev?.type === "response.incomplete") {
            const why = ev.response?.error?.message || ev.response?.incomplete_details?.reason || ev.type;
            return { error: `stream ${ev.type}: ${String(why).slice(0, 200)}` };
          }
        }
        if (final) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    return final ? { data: final } : { error: "stream_ended_without_response" };
  }

  try {
    let res = await call("web_search");
    if (!res.ok) {
      const errText = await res.text();
      // Older OpenAI snapshots expose the tool as `web_search_preview`; retry once. kie.ai's unified
      // endpoint only documents `web_search`, so skip the retry there.
      if (engine === "openai" && (/web_search(?!_preview)/.test(errText) || /tool/i.test(errText))) {
        res = await call("web_search_preview");
      }
      if (!res.ok) {
        const t2 = res.ok ? "" : await res.text().catch(() => errText);
        // Cloudflare's 524 page is HTML noise — keep only the status, it already names the cause.
        return { error: `${engine}_${res.status}: ${(t2 || errText).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}` };
      }
    }
    if (wantsStream) {
      const sse = await readSse(res);
      if (sse.error) return { error: `openai_stream: ${sse.error}` };
      if (!sse.data) return { error: "openai_stream: no_response" };
      return parseResponses(sse.data);
    }
    const data = await res.json();
    return parseResponses(data);
  } catch (e: any) {
    return { error: e?.name === "AbortError" ? `timeout_after_${Math.round(SEARCH_TIMEOUT_MS / 60_000)}m` : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function parseResponses(data: any): RawTrace {
  const out: any[] = Array.isArray(data?.output) ? data.output : [];
  const batches: RawTrace["batches"] = [];
  const opened: { url: string }[] = [];
  const scannedAll: { url: string; domain: string }[] = [];
  let answerText = "";
  const citations: { url: string; title: string; domain: string }[] = [];

  for (const item of out) {
    if (item?.type === "web_search_call") {
      const action = item.action ?? {};
      const sources: { url: string; domain: string }[] = Array.isArray(action.sources)
        ? action.sources.map((s: any) => { const url = s?.url ?? s; return { url, domain: domainOf(url) }; }).filter((s: any) => s.url)
        : [];
      for (const s of sources) scannedAll.push(s);
      const atype = action.type ?? (action.query || action.queries ? "search" : action.url ? "open_page" : "");
      if (atype === "open_page" && action.url) {
        opened.push({ url: action.url });
      } else if (atype === "find" && action.url) {
        opened.push({ url: action.url });
      } else {
        // treat as a search batch
        const queries: string[] = action.queries
          ? action.queries.map((q: any) => String(q)).filter(Boolean)
          : action.query ? [String(action.query)] : [];
        batches.push({ id: item.id || `b${batches.length + 1}`, queries, sources });
      }
    } else if (item?.type === "message") {
      const content: any[] = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" || typeof c?.text === "string") {
          answerText += (c.text ?? "") + "\n";
          const anns: any[] = Array.isArray(c.annotations) ? c.annotations : [];
          for (const a of anns) {
            if (a?.type === "url_citation" && a.url) citations.push({ url: a.url, title: a.title ?? "", domain: domainOf(a.url) });
          }
        }
      }
    }
  }
  // Fallback: some responses surface the joined text on output_text.
  if (!answerText && typeof data?.output_text === "string") answerText = data.output_text;

  // Fallback citation extraction: OpenAI's real web_search tool attaches structured
  // `url_citation` annotations to the message, but kie.ai's proxy (and some other
  // OpenAI-compatible relays) just print plain links/URLs in the answer body with no
  // annotation metadata. Without this, every downstream metric (brands, trust signals,
  // source-type mix, top-3 concentration) silently collapses to zero even though the
  // answer clearly names real sources. Mine the text itself as a last resort.
  if (citations.length === 0 && answerText) {
    for (const c of extractLinksFromText(answerText)) citations.push(c);
  }

  return { batches, opened, scannedAll, answerText: answerText.trim(), citations };
}

function extractLinksFromText(text: string): { url: string; title: string; domain: string }[] {
  const seen = new Set<string>();
  const out: { url: string; title: string; domain: string }[] = [];
  const push = (rawUrl: string, title: string) => {
    const url = rawUrl.replace(/[),.;:!?\]]+$/g, "");
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: title.trim(), domain: domainOf(url) });
  };
  // Markdown links: [title](url)
  const mdRe = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text))) push(m[2], m[1]);
  // Bare URLs not already captured as markdown links.
  const bareRe = /https?:\/\/[^\s|)\]"'<>]+/g;
  while ((m = bareRe.exec(text))) push(m[0], "");
  return out.slice(0, 60);
}

// ─── Stage 2: qualitative analysis pass ──────────────────────────────────────────
function buildAnalysisPrompt(t: RawTrace, query: string, language: string, country: string): string {
  const citedDomains = Array.from(new Set(t.citations.map(c => c.domain)));
  const scannedDomains = Array.from(new Set(t.scannedAll.map(s => s.domain)));
  const citationList = t.citations.map((c, i) => `[${i + 1}] ${c.domain} — ${c.title || c.url}`).join("\n");

  return `You are a GEO (Generative Engine Optimization) analyst. Below is an AI assistant's answer to a real user query, plus the web sources it cited and scanned. Extract a STRICT JSON object (no prose, no markdown) describing how the niche is represented.

QUERY: "${query}"  (language: ${language}, country: ${country})

CITED SOURCES (in answer order):
${citationList || "(none)"}

CITED DOMAINS: ${citedDomains.join(", ") || "(none)"}
SCANNED-BUT-MAYBE-UNCITED DOMAINS: ${scannedDomains.slice(0, 60).join(", ") || "(none)"}

ANSWER:
"""
${t.answerText.slice(0, 9000)}
"""

Return JSON with EXACTLY this shape:
{
  "intent": "Commercial" | "Informational" | "Navigational" | "Transactional",
  "intentConfidence": 0.0-1.0,
  "stage": "Awareness" | "Consideration" | "Decision",
  "topic": "short_snake_case_topic",
  "brands": [
    {
      "name": "Brand display name",
      "domain": "primary domain from the cited sources",
      "tags": ["3 short attribute chips"],
      "pricing": "one sentence on its pricing angle",
      "support": "one sentence on its support/service angle",
      "featureBreadth": "one sentence on its feature breadth"
    }
  ],
  "domainTypes": { "domain.com": "official_site|ecommerce|review_aggregator|listicle_editorial|forum|wikipedia|other" },
  "keyEntities": [
    { "category": "Concepts" | "Products" | "Places" | "Organizations", "name": "Entity", "count": 1, "brands": ["Brand", "..."] }
  ],
  "insights": {
    "userSearchBehavior": "2-3 sentences on the search behavior the queries reveal",
    "dominantSource": "2-3 sentences on which source type dominates citations and why",
    "strategicEngagement": "2-3 sentences of the single highest-leverage action for a brand to get cited",
    "opportunityGaps": "2-3 sentences on under-covered source types competitors miss"
  },
  "coverageNotes": {
    "missingFactors": ["factors the answer never weighed, if any"],
    "missingEntities": ["entities absent but expected, if any"]
  }
}

Rules:
- ORDER "brands" by prominence in the answer (most prominent first). One entry per real brand/provider that appears as a bookable/usable option. Skip pure reference pages.
- "domainTypes" MUST include every CITED domain and every prominent scanned domain. official_site = a provider's own website; ecommerce = marketplace/aggregator/booking platform; review_aggregator = reviews/ratings hubs; listicle_editorial = blog/magazine "best of" articles; forum = reddit/quora/community; wikipedia = wikipedia/wikidata.
- Keep every string short. Language of notes: ${language}.`;
}

/**
 * Credentials for stage 2, when the user has configured a provider for the `utility` task.
 *
 * Stage 1 and stage 2 are different jobs and only one of them is fussy about who runs it. The
 * search pass needs a provider-hosted `web_search` tool, which is why this module knows about
 * OpenAI and kie.ai by name at all. The analysis pass just reads a trace and emits JSON — any
 * model can do it, and pinning it to whoever happened to run the search meant the cheap
 * mechanical half was billed at the searching provider's rates with no way to say otherwise.
 */
export interface GeoAnalysisCreds {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

async function runAnalysis(
  t: RawTrace, query: string, language: string, country: string,
  analysisModel: string, apiKey: string, engine: GeoEngine = "openai",
  creds?: GeoAnalysisCreds, baseUrl?: string,
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  const prompt = buildAnalysisPrompt(t, query, language, country);
  try {
    // Preferred path: the shared multi-provider client, so stage 2 obeys the per-task settings
    // like every other analysis step in the app — and inherits the things that client learned
    // the hard way, none of which the private fetch below has: retries on 429/5xx, and an empty
    // 200 reported as the provider-side failure it is rather than returned as a successful
    // empty answer for `extractJson` to blame on the JSON.
    //
    // `response_format: json_object` is not sent here, because it is an OpenAI-family parameter
    // and this path may be talking to anyone. The prompt already demands JSON and `extractJson`
    // already tolerates a fenced or prefixed reply — the same contract every other JSON step in
    // this codebase runs on.
    //
    // One thing to watch when picking the model: a reasoning model can spend the whole budget
    // thinking and return nothing. That now surfaces as a named error instead of a silent null,
    // and the model picker marks which models reason.
    if (creds?.provider && creds.apiKey) {
      const r = await fetchLLMDetailed(
        prompt, creds.provider, creds.apiKey, 8000, creds.model || undefined, creds.baseUrl, 0.2,
      );
      if (!r.text) {
        console.error("[GEO] analysis failed:", r.error ?? "no text");
        return null;
      }
      return extractJson(r.text);
    }
    if (engine === "aparser") {
      // Deliberate dead end. On this engine `apiKey` is an A-Parser password and `baseUrl` is
      // the user's own machine, so every fallback below would post that password to a vendor —
      // api.openai.com in the default branch. Stage 2 therefore runs only through the `utility`
      // credentials handled above; without them the audit ships with the deterministic half
      // only, exactly as it does for any other failed analysis, which is not fatal by design.
      console.error("[GEO] analysis skipped: aparser engine, no utility credentials configured");
      return null;
    }
    if (engine === "gemini") {
      // The Gemini engine's key only speaks generateContent — the shared client's gemini branch
      // is the correct unattended fallback (same as the creds path, on the search key).
      const r = await fetchLLMDetailed(prompt, "gemini", apiKey, 8000, analysisModel || undefined, baseUrl, 0.2);
      if (!r.text) {
        console.error("[GEO] analysis failed:", r.error ?? "no text");
        return null;
      }
      return extractJson(r.text);
    }
    if (engine === "kie") {
      // kie.ai publishes no /models listing and exposes a single documented id, so there is
      // nothing to pick from and nothing to rank — the shared provider default is the answer.
      // (It used to send `gpt-5-2`, an undocumented lighter id chosen for cost; a private id no
      // listing confirms is exactly the kind of guess that breaks silently.) Same Responses-API
      // endpoint as stage 1, minus the tools, with reasoning dialled down for a structured pass.
      const res = await fetch("https://api.kie.ai/codex/v1/responses", {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: defaultModelFor("kie"), stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          reasoning: { effort: "low" },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const out: any[] = Array.isArray(data?.output) ? data.output : [];
      let text = "";
      for (const item of out) {
        if (item?.type === "message") {
          for (const c of item.content ?? []) if (typeof c?.text === "string") text += c.text;
        }
      }
      return extractJson(text);
    }

    // Same gateway override as stage 1: without utility creds this fallback posts the engine's
    // key, and a gateway key against api.openai.com is a guaranteed 401 (and a silently hollow
    // report — a failed analysis is deliberately not a failed audit).
    const root = (baseUrl || "").replace(/\/+$/, "");
    const res = await fetch(root ? `${root}/chat/completions` : "https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: analysisModel,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        // Same Cloudflare 524 wall as stage 1: a structured 8000-token analysis can outlive a
        // gateway's time-to-first-byte window. Deltas start flowing immediately; [DONE] ends it.
        ...(root ? { stream: true } : {}),
      }),
    });
    if (!res.ok) return null;
    if (root) {
      const reader = res.body?.getReader();
      if (!reader) return null;
      const decoder = new TextDecoder();
      let buf = "";
      let text = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try { text += JSON.parse(payload)?.choices?.[0]?.delta?.content ?? ""; } catch { /* partial line */ }
          }
        }
      } catch { return null; } finally { try { await reader.cancel(); } catch { /* closed */ } }
      return text ? extractJson(text) : null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return extractJson(text);
  } catch { return null; } finally { clearTimeout(timer); }
}

// ─── Stage 3: derive metrics + analytics ─────────────────────────────────────────
function pct(n: number, d: number): number { return d > 0 ? Math.round((n / d) * 100) : 0; }

export function assembleReport(opts: {
  query: string; language: string; country: string; model: string; trace: RawTrace; analysis: any;
}): GeoReport {
  const { query, language, country, model, trace, analysis } = opts;
  const a = analysis ?? {};

  // Citation counts per domain.
  const citeCountByDomain = new Map<string, number>();
  for (const c of trace.citations) citeCountByDomain.set(c.domain, (citeCountByDomain.get(c.domain) ?? 0) + 1);
  const citedDomains = new Set(citeCountByDomain.keys());

  // Scanned (from search batches) and opened (deep reads).
  const scannedDomains = new Set(trace.scannedAll.map(s => s.domain));
  const openedDomains = new Set(trace.opened.map(o => domainOf(o.url)));
  const searchedDomains = scannedDomains; // appeared in a search result pool

  // Resolve a source type for every domain we know about.
  const typeMap: Record<string, string> = {};
  const llmTypes: Record<string, string> = (a.domainTypes && typeof a.domainTypes === "object") ? a.domainTypes : {};
  const allDomains = new Set<string>([...scannedDomains, ...citedDomains, ...openedDomains]);
  for (const d of allDomains) {
    const raw = String(llmTypes[d] || "").toLowerCase().replace(/[\s-]+/g, "_");
    typeMap[d] = ALL_TYPES.includes(raw) ? raw : heuristicType(d);
  }

  // ── Metrics ──
  const searchBatches = trace.batches.length;
  const uniqueQueries = new Set(trace.batches.flatMap(b => b.queries)).size;
  const pagesOpened = trace.opened.length;
  const sourcesScanned = trace.scannedAll.length;
  const uniqueDomains = scannedDomains.size;
  const citations = trace.citations.length;
  // Unique cited URLs vs scanned pool, capped at 100% (citations can repeat a URL).
  const uniqueCitedUrls = new Set(trace.citations.map(c => c.url)).size;
  const scannedToCitedPct = Math.min(100, pct(uniqueCitedUrls, sourcesScanned));

  // Top-3 concentration = share of citations held by the 3 most-cited domains.
  const sortedDomainCites = [...citeCountByDomain.entries()].sort((x, y) => y[1] - x[1]);
  const top3Cites = sortedDomainCites.slice(0, 3).reduce((s, [, n]) => s + n, 0);
  const top3ConcentrationPct = pct(top3Cites, citations);

  // ── Source types breakdown ──
  const citesByType = new Map<string, number>();
  const domainsByType = new Map<string, Set<string>>();
  for (const d of allDomains) {
    const ty = typeMap[d];
    if (!domainsByType.has(ty)) domainsByType.set(ty, new Set());
    domainsByType.get(ty)!.add(d);
  }
  for (const [d, n] of citeCountByDomain) {
    const ty = typeMap[d];
    citesByType.set(ty, (citesByType.get(ty) ?? 0) + n);
  }
  const sourceTypes = ALL_TYPES
    .map(ty => ({
      type: ty, label: TYPE_LABEL[ty],
      cites: citesByType.get(ty) ?? 0,
      domains: domainsByType.get(ty)?.size ?? 0,
      pct: pct(citesByType.get(ty) ?? 0, citations),
    }))
    .filter(s => s.domains > 0 || s.cites > 0)
    .sort((x, y) => y.cites - x.cites || y.domains - x.domains);

  const dominant = sourceTypes.find(s => s.cites > 0) ?? sourceTypes[0] ?? { type: "other", label: "Other", pct: 0 };

  // ── Brand leaderboard ──
  const rawBrands: any[] = Array.isArray(a.brands) ? a.brands : [];
  const queryCount = Math.max(uniqueQueries, 1);
  const brands: GeoBrand[] = rawBrands.slice(0, 12).map((b, i) => {
    const rank = i + 1;
    const base = 1 + 1 / rank;
    const score = rank === 1 ? base + 0.5 : base; // dominance bonus for #1
    const domain = String(b.domain || "").replace(/^www\./, "").toLowerCase();
    const cites = citeCountByDomain.get(domain) ?? 0;
    // Which search batches surfaced this brand's domain (1-indexed).
    const surfacedIn: number[] = [];
    trace.batches.forEach((batch, bi) => {
      if (batch.sources.some(s => s.domain === domain)) surfacedIn.push(bi + 1);
    });
    return {
      rank, name: String(b.name || domain || `Brand ${rank}`), domain, dominant: rank === 1,
      mentions: Math.max(cites, 1),
      score: Math.round(score * 100) / 100,
      tags: Array.isArray(b.tags) ? b.tags.slice(0, 3).map(String) : [],
      pricing: String(b.pricing || ""), support: String(b.support || ""), featureBreadth: String(b.featureBreadth || ""),
      surfacedIn, totalQueries: queryCount,
    };
  });

  // ── Selection factors (Pricing / Support / Feature breadth) from brand notes ──
  const factorDefs: { name: string; key: "pricing" | "support" | "featureBreadth" }[] = [
    { name: "Pricing", key: "pricing" }, { name: "Support", key: "support" }, { name: "Feature breadth", key: "featureBreadth" },
  ];
  const selectionFactors = factorDefs.map(f => {
    const items = brands.filter(b => b[f.key]).map(b => ({ brand: b.name, note: b[f.key] }));
    const weight = items.length >= Math.ceil(brands.length * 0.6) ? "High" : items.length >= 2 ? "Medium" : "Low";
    return { name: f.name, weight, items };
  }).filter(f => f.items.length > 0);

  // ── Key entities (grouped by category) ──
  const rawEntities: any[] = Array.isArray(a.keyEntities) ? a.keyEntities : [];
  const byCat = new Map<string, { name: string; count: number; brands: string[] }[]>();
  for (const e of rawEntities) {
    const cat = String(e.category || "Concepts");
    const brs = Array.isArray(e.brands) ? e.brands.map(String) : [];
    const resolvedBrands = brs.length === 1 && /^all$/i.test(brs[0]) ? brands.map(b => b.name) : brs;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push({ name: String(e.name || ""), count: Number(e.count) || 1, brands: resolvedBrands });
  }
  const keyEntities = [...byCat.entries()].map(([category, items]) => ({ category, items: items.filter(i => i.name) }));

  // ── Trust signals per domain ──
  const maxCites = Math.max(1, ...[...citeCountByDomain.values()]);
  const trustRows: GeoTrustRow[] = [...allDomains].map(d => {
    const cites = citeCountByDomain.get(d) ?? 0;
    const cited = citedDomains.has(d), opened = openedDomains.has(d), searched = searchedDomains.has(d), scanned = scannedDomains.has(d);
    const trust =
      0.5 * (cited ? 1 : 0) +
      0.2 * (cites / maxCites) +
      0.15 * (searched ? 1 : 0) +
      0.10 * (opened ? 1 : 0) +
      0.05 * (scanned ? 1 : 0);
    return { domain: d, type: typeMap[d], label: TYPE_LABEL[typeMap[d]], cited, opened, cites, trust: Math.round(trust * 100) / 100 };
  }).sort((x, y) => y.trust - x.trust || y.cites - x.cites).slice(0, 12);

  // ── Inclusion pattern ──
  const citedTypesSorted = sourceTypes.filter(s => s.cites > 0);
  const scannedNeverCited = sourceTypes.filter(s => s.cites === 0 && s.domains > 0);
  const topBrandDomains = new Set(brands.slice(0, 3).map(b => b.domain));
  const inclusionSignals: GeoInclusionSignal[] = [];
  if (citedTypesSorted[0]) {
    const s = citedTypesSorted[0];
    const domains = [...allDomains].filter(d => typeMap[d] === s.type && citedDomains.has(d));
    inclusionSignals.push({
      kind: "required", type: s.type, label: s.label,
      text: `Brand needs to be featured in ${s.label.toLowerCase()} for credibility.`,
      cites: s.cites, brands: domains.length, domains,
    });
  }
  if (citedTypesSorted[1]) {
    const s = citedTypesSorted[1];
    const domains = [...allDomains].filter(d => typeMap[d] === s.type && citedDomains.has(d));
    inclusionSignals.push({
      kind: "boosting", type: s.type, label: s.label,
      text: `Brand should engage with ${s.label.toLowerCase()} platforms to enhance visibility.`,
      cites: s.cites, brands: domains.length, domains,
      note: brands.slice(0, 3).map(b => `${b.name} (${b.score})`).join(", "),
    });
  }
  for (const s of scannedNeverCited.slice(0, 3)) {
    const domains = [...allDomains].filter(d => typeMap[d] === s.type).slice(0, 2);
    inclusionSignals.push({
      kind: "absent", type: s.type, label: s.label,
      text: `No citations from ${s.label.toLowerCase()} domains${domains.length ? ` like ${domains.join(" and ")}` : ""} despite being scanned.`,
      cites: 0, brands: 0, domains,
    });
  }
  const stability = brands.length >= 5 ? "high confidence" : brands.length >= 3 ? "low confidence" : "very low confidence";

  // ── Coverage gaps (missing source types = taxonomy types never seen) ──
  const seenTypes = new Set(sourceTypes.map(s => s.type));
  const missingSourceTypes = ["review_aggregator", "listicle_editorial"]
    .filter(ty => (citesByType.get(ty) ?? 0) === 0)
    .map(ty => ({
      type: ty,
      note: ty === "review_aggregator" ? "No review aggregator sources were found." : "No listicle or editorial sources were found.",
    }));

  // ── Insights prose ──
  const ins = a.insights ?? {};
  const insights = {
    userSearchBehavior: String(ins.userSearchBehavior ||
      `${searchBatches} search batches executed with ${uniqueQueries} unique queries, resulting in ${pagesOpened} pages opened. The scanned-to-cited ratio stands at ${scannedToCitedPct}%.`),
    dominantSource: String(ins.dominantSource ||
      `${dominant.label} sources dominate with a ${dominant.pct}% share of citations.`),
    strategicEngagement: String(ins.strategicEngagement ||
      `${dominant.label} sources are critical, with a ${dominant.pct}% citation share. Getting featured there is the highest-leverage action.`),
    opportunityGaps: String(ins.opportunityGaps ||
      (missingSourceTypes.length ? `Under-covered areas competitors miss: ${missingSourceTypes.map(m => m.type).join(", ")}.` : "Few obvious coverage gaps.")),
  };

  // ── Build batch summaries (with cited counts) ──
  const citedUrlSet = new Set(trace.citations.map(c => c.url));
  const citedDomainSet = citedDomains;
  const batches: GeoBatch[] = trace.batches.map((b, i) => {
    const cited = b.sources.filter(s => citedUrlSet.has(s.url) || citedDomainSet.has(s.domain)).length;
    return { id: b.id?.startsWith("b") ? `B${i + 1}` : `B${i + 1}`, queries: b.queries, scanned: b.sources.length, cited };
  });

  const openPages = trace.opened.map((o, i) => ({ rank: i + 1, domain: domainOf(o.url), path: pathOf(o.url), url: o.url }));

  return {
    query, language, country, model, createdAt: Date.now(),
    classification: {
      intent: String(a.intent || "Commercial"),
      intentConfidence: Number(a.intentConfidence) || 0.8,
      stage: String(a.stage || "Decision"),
      topic: String(a.topic || "general"),
    },
    metrics: {
      searchBatches, uniqueQueries, pagesOpened, sourcesScanned, uniqueDomains, citations,
      scannedToCitedPct, top3ConcentrationPct,
      dominantType: { type: dominant.type, label: dominant.label, pct: dominant.pct },
    },
    batches, openPages, brands, selectionFactors, keyEntities, sourceTypes, trustSignals: trustRows,
    inclusion: { stability, topCount: Math.min(brands.length, 3), signals: inclusionSignals },
    coverageGaps: {
      missingFactors: Array.isArray(a.coverageNotes?.missingFactors) ? a.coverageNotes.missingFactors.map(String) : [],
      missingEntities: Array.isArray(a.coverageNotes?.missingEntities) ? a.coverageNotes.missingEntities.map(String) : [],
      missingSourceTypes,
    },
    insights,
    answer: {
      text: trace.answerText,
      chars: trace.answerText.length,
      citations: trace.citations.map((c, i) => ({ n: i + 1, domain: c.domain, url: c.url, title: c.title })),
    },
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────────
export async function runGeoAudit(params: {
  query: string; language?: string; country?: string; model?: string; apiKey: string; engine?: GeoEngine;
  /**
   * Model for stage 2 — the structured pass that turns the search trace into a report. Separate
   * from the search model on purpose: stage 1 needs browsing depth, stage 2 needs to emit JSON
   * cheaply, and paying flagship rates for the second is waste.
   *
   * Supplied by the caller from the `utility` task setting. It used to be `"gpt-4o-mini"`,
   * written into this file, which meant the cheap pass was pinned to a model the user could not
   * see, could not change, and which will eventually be retired out from under them.
   */
  analysisModel?: string;
  /**
   * Full stage-2 credentials, when the caller has them. Optional and additive: a client that
   * sends only `analysisModel` — or nothing — keeps the previous behaviour exactly, which
   * matters because this runs detached in the background for live users.
   */
  analysis?: GeoAnalysisCreds;
  /**
   * Endpoint override for the GEO ENGINE (stage 1 + the stage-2 fallback), from
   * aiBaseUrl_openai. Same convention as the shared client: a gateway key must be spent
   * against the gateway, never against the vendor it proxies.
   */
  baseUrl?: string;
  /**
   * Preset name inside the user's A-Parser (engine "aparser" only). The preset decides both
   * the parser options — "Search the web" MUST be on, or the answer comes from the model's
   * weights and measures nothing — and the result format, which is why the response mapper
   * accepts a range of shapes instead of one.
   */
  aparserPreset?: string;
  /** A-Parser thread-count config to run under ("default" unless the user changed it). */
  aparserConfig?: string;
}): Promise<GeoResult> {
  const query = String(params.query ?? "").trim();
  if (!query) return { ok: false, error: "no_query" };
  const apiKey = String(params.apiKey ?? "");
  if (!apiKey) return { ok: false, error: "no_key" };
  const language = String(params.language ?? "en");
  const country = String(params.country ?? "us");
  const engine: GeoEngine = params.engine === "kie" ? "kie"
    : params.engine === "gemini" ? "gemini"
    : params.engine === "aparser" ? "aparser"
    : "openai";
  // A-Parser is not asked for a model — it reports the one its free session happened to serve —
  // so the placeholder here is only what the audit row shows until the real id comes back on
  // the trace. Defaulting it to an OpenAI id would put a model in the report that never ran.
  const model = String(params.model ?? "")
    || (engine === "aparser" ? GEO_APARSER_PARSER
      : engine === "kie" ? "gpt-5-5"
      : engine === "gemini" ? "gemini-2.5-flash"
      : OPENAI_FALLBACK_MODELS[0]);
  const baseUrl = String(params.baseUrl ?? "").trim() || undefined;
  // The endpoint is not optional on this engine: there is no public host to fall back to, and
  // an empty one would send the instance password nowhere useful.
  if (engine === "aparser" && !baseUrl) return { ok: false, error: "aparser_no_url" };

  const trace = await runWebSearch(query, language, country, model, apiKey, engine, baseUrl, params.aparserPreset, params.aparserConfig);
  if ("error" in trace) return { ok: false, error: trace.error };
  if (!trace.answerText && trace.citations.length === 0 && trace.batches.length === 0) {
    return { ok: false, error: "empty_trace" };
  }

  // Through a gateway the hardcoded cheap default is an id the gateway may not serve (its
  // catalogue is not OpenAI's), so the search model — a proven-valid id on that gateway —
  // stands in for the unattended stage-2 fallback. The Gemini engine defaults likewise: an
  // OpenAI id would 404 against the user's Gemini key.
  const analysisModel = String(params.analysisModel ?? "")
    || (engine === "gemini" || engine === "kie" || engine === "aparser" || baseUrl ? model : OPENAI_FALLBACK_CHEAP);
  const analysis = await runAnalysis(trace, query, language, country, analysisModel, apiKey, engine, params.analysis, baseUrl);
  // What ran, not what was requested. On A-Parser the two differ by construction, and a report
  // that silently claims the requested id would hide the whole point of the trade-off: the free
  // tier serves whichever model it serves that day.
  const report = assembleReport({ query, language, country, model: trace.model || model, trace, analysis });
  return { ok: true, data: report };
}
