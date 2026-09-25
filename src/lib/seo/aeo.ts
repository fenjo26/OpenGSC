// AEO Tracker — does an AI answer engine cite this site when a real user question is asked?
//
// The point of this module is parity with what a person actually sees in ChatGPT/Perplexity,
// so every engine here is asked to *search the live web*, not to answer from weights:
//
//   ChatGPT     Responses API + the hosted `web_search` tool, forced via tool_choice.
//   Perplexity  chat/completions (sonar) — search is built in; we tune context size/location.
//   Claude      Messages API + the server-side `web_search` tool.
//   Grok        chat/completions + xAI Live Search (`search_parameters`).
//   Gemini      generateContent + the `google_search` grounding tool (T7).
//   AI Overviews the block Google itself shows above its SERP for the question (N7) — no
//              model is asked anything; the question is run through DataForSEO SER Advanced
//              or A-Parser SE::Google and the ai_overview element is read off the page.
//
// Three things were wrong with the previous version and are worth stating so they don't come
// back. (1) `tool_choice: "auto"` on a mini model meant the model usually skipped the search
// and answered from memory — no citations, so the tracker reported "not cited" for a site that
// ChatGPT cites in the browser. (2) No `user_location`: for a local-intent question ("transfer
// from Thessaloniki airport") the browser answer is geolocated and the API answer is not, so
// the two are not comparable at all. (3) Nothing but a boolean was persisted, so when the
// result disagreed with the browser there was no way to tell whether the model had searched,
// what it answered, or who it cited instead.
//
// Hence the result shape: the full answer text, every citation, whether a search actually ran,
// and our rank among the cited domains — the raw material the UI needs to explain itself.

import { defaultModelFor } from "@/lib/providerDefaults";
import { loggedFetch, type CallHandle } from "@/lib/providerLog/log";
import { usageFrom } from "@/lib/providerLog/tokens";
import { aparserOneRequest, parserResultProblem, type AparserCreds } from "./aparser";
import { aparserSerpOptions, captchaShows, describeAparserRow } from "./aparserSerp";
import { DFS_LOC, dfsCostUsd } from "./serp";
import { defaultLanguageFor } from "./regions";

export type AeoEngine = "chatgpt" | "perplexity" | "claude" | "grok" | "gemini" | "ai_overview";

// "cited" — our domain is linked in the answer. "mentioned" — the brand is named in the prose
// but nothing links to us (real, and worth seeing, but a weaker outcome than a citation).
// "no_overview" — Google served the SERP but showed no AI Overview block for this question
// (ai_overview engine only). That is NOT "not cited": the engine never had a chance to cite
// anyone, so it is a separate state and is kept out of every share-of-voice denominator.
export type AeoStatus = "cited" | "mentioned" | "absent" | "no_overview";

export interface AeoCitation { url: string; domain: string; title: string }

export interface AeoCheckResult {
  cited: boolean;
  mentioned: boolean;
  status: AeoStatus;
  url: string | null;
  snippet: string | null;
  /** 1-based position of our domain among the distinct cited domains, in answer order. */
  rank: number | null;
  answerText: string | null;
  citations: AeoCitation[];
  /** The engine ran a live web search for this answer (vs. answering from weights). */
  searched: boolean;
  /** Our domain turned up in the engine's search results but was not cited in the answer. */
  scanned: boolean;
  model: string | null;
  error?: string;
}

export interface AeoRunOptions {
  /** Model id for the engine. If omitted, engine default is used. */
  model?: string;
  /** ISO-3166-1 alpha-2, lowercase (same `gl` codes as the rest of SEO Tools). */
  country?: string | null;
  city?: string | null;
  region?: string | null;
  /** ISO-639-1, lowercase. Only used to nudge the answer language, never the question text. */
  language?: string | null;
  /** Base URL for custom endpoints / proxies */
  baseUrl?: string | null;
  /** The "ai_overview" engine's supplier: a DataForSEO key or the owner's A-Parser connection.
   *  Unlike every other engine there is no API key of Google's to pass — the overview is read
   *  off a regular SERP, so whoever fetches that SERP is the provider. */
  aio?: AioContext | null;
}

// Used only when the site has no model chosen and the picker could not list the account's
// models (no key, or /v1/models unreachable). The UI resolves a live default via
// lib/seo/models.ts, which is what normally decides this — see the note there about why naming
// a model literally goes stale silently.
//
// The one thing that is not negotiable: never default to a mini/nano tier. Those search
// shallowly, or skip the search entirely, and that was the single biggest source of false
// "not cited" in this tracker.
export const AEO_DEFAULT_MODEL = "gpt-5.6-terra";
export const AEO_ENGINES: AeoEngine[] = ["chatgpt", "perplexity", "claude", "grok", "gemini", "ai_overview"];

// ─── Shared helpers ──────────────────────────────────────────────────────────

export function hostOf(input: string): string {
  let d = (input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "");
  d = d.split("/")[0];
  return d.replace(/^www\./, "");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(url || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

function isOurs(domain: string, host: string): boolean {
  return !!host && (domain === host || domain.endsWith("." + host));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match that survives non-ASCII brands — \b is ASCII-only in JS regexes, so the
// boundary is spelled out as "not a letter or digit" in Unicode terms.
function mentionsTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (t.length < 3) return false;
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
  } catch {
    return text.toLowerCase().includes(t.toLowerCase());
  }
}

// When a site has no brandedKeywords set, guess plausible brand spellings from the domain
// label: "transfer-thessaloniki.gr" → "transfer-thessaloniki", "transfer thessaloniki".
// Only ever used for the weaker "mentioned" verdict, never to claim a citation.
export function brandTermsFor(host: string, explicit: string[]): string[] {
  const terms = explicit.map(s => s.trim()).filter(s => s.length >= 3);
  if (terms.length) return terms;
  const label = host.split(".")[0];
  if (!label || label.length < 4) return [];
  const out = new Set<string>([label]);
  if (/[-_]/.test(label)) out.add(label.replace(/[-_]+/g, " "));
  return [...out];
}

function snippetAround(text: string, needle: string, span = 200): string | null {
  if (!text || !needle) return null;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - Math.floor(span / 2));
  return (start > 0 ? "…" : "") + text.slice(start, start + span).trim() + (start + span < text.length ? "…" : "");
}

// Bare URLs / markdown links in the answer body. Some engines (and OpenAI-compatible relays)
// print sources inline without attaching structured citation metadata; without this fallback
// every downstream number collapses to zero on an answer that visibly names sources.
function linksFromText(text: string): AeoCitation[] {
  const out: AeoCitation[] = [];
  const seen = new Set<string>();
  const push = (raw: string, title: string) => {
    const url = raw.replace(/[),.;:!?\]]+$/g, "");
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, domain: domainOf(url), title });
  };
  for (const m of text.matchAll(/\[([^\]]{1,160})\]\((https?:\/\/[^\s)]+)\)/g)) push(m[2], m[1]);
  for (const m of text.matchAll(/(?<!\()\bhttps?:\/\/[^\s<>"'\])]+/g)) push(m[0], "");
  return out;
}

function dedupeCitations(list: AeoCitation[]): AeoCitation[] {
  const seen = new Set<string>();
  const out: AeoCitation[] = [];
  for (const c of list) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ url: c.url, domain: c.domain || domainOf(c.url), title: c.title || "" });
  }
  return out;
}

interface EngineTrace {
  text: string;
  citations: AeoCitation[];
  /** Domains the engine looked at while searching, cited or not. */
  scanned: string[];
  searched: boolean;
  model: string | null;
}

// The one place a verdict is formed, so all four engines are judged identically.
function verdict(host: string, brandTerms: string[], tr: EngineTrace): AeoCheckResult {
  const citations = dedupeCitations(tr.citations.length ? tr.citations : linksFromText(tr.text));

  const ourCitation = citations.find(c => isOurs(c.domain, host)) ?? null;
  const distinctDomains: string[] = [];
  for (const c of citations) if (!distinctDomains.includes(c.domain)) distinctDomains.push(c.domain);
  const rank = ourCitation ? distinctDomains.indexOf(ourCitation.domain) + 1 : null;

  const textHasDomain = !!host && tr.text.toLowerCase().includes(host);
  const cited = !!ourCitation || textHasDomain;
  const brandHit = cited ? null : brandTerms.find(t => mentionsTerm(tr.text, t)) ?? null;
  const mentioned = !cited && !!brandHit;

  return {
    cited,
    mentioned,
    status: cited ? "cited" : mentioned ? "mentioned" : "absent",
    url: ourCitation?.url ?? null,
    snippet: snippetAround(tr.text, ourCitation ? host : (brandHit ?? host)),
    rank,
    answerText: tr.text || null,
    citations,
    searched: tr.searched || citations.length > 0,
    scanned: tr.scanned.some(d => isOurs(d, host)),
    model: tr.model,
  };
}

function failed(error: string, model: string | null = null): AeoCheckResult {
  return {
    cited: false, mentioned: false, status: "absent", url: null, snippet: null, rank: null,
    answerText: null, citations: [], searched: false, scanned: false, model, error,
  };
}

// Answer-language nudge. The question itself is never rewritten — a tracked question has to hit
// the engine exactly as a user would type it, or the check stops measuring the thing it claims
// to measure.
function languageHint(language?: string | null): string | null {
  const l = (language || "").trim().toLowerCase();
  return l ? `Answer in ${l}. Search the web and cite your sources.` : "Search the web and cite your sources.";
}

// ─── ChatGPT — OpenAI Responses API + hosted web_search ──────────────────────

function openAiLocation(o: AeoRunOptions) {
  if (!o.country) return undefined;
  const loc: Record<string, string> = { type: "approximate", country: o.country.toUpperCase() };
  if (o.city) loc.city = o.city;
  if (o.region) loc.region = o.region;
  return loc;
}

async function callOpenAi(apiKey: string, question: string, o: AeoRunOptions): Promise<EngineTrace | { error: string }> {
  const model = o.model || AEO_DEFAULT_MODEL;
  const location = openAiLocation(o);

  // Attempt ladder, widest capability first. Forcing the tool is what stops the model from
  // answering from memory; `search_context_size: high` is what gets it close to the browser's
  // search depth. Both are dropped in turn if a given model/snapshot rejects them, so an
  // account without the newest surface degrades instead of erroring.
  const attempts = [
    { toolType: "web_search", contextSize: "high", location, force: true, extras: true },
    { toolType: "web_search_preview", contextSize: "high", location, force: true, extras: true },
    { toolType: "web_search", contextSize: null, location, force: false, extras: true },
    // Last resort: nothing but the tool itself. If `include` or `instructions` is what a given
    // snapshot rejects, every richer attempt above fails on it and this is the one that answers.
    { toolType: "web_search_preview", contextSize: null, location: undefined, force: false, extras: false },
  ];

  let lastErr = "";
  // Each rung of the ladder is its own request and its own row, numbered: a snapshot that
  // rejects `web_search` still answered, and still charged for answering.
  let attempt = 0;
  for (const a of attempts) {
    attempt += 1;
    const tool: Record<string, unknown> = { type: a.toolType };
    if (a.contextSize) tool.search_context_size = a.contextSize;
    if (a.location) tool.user_location = a.location;

    const body: Record<string, unknown> = {
      model,
      stream: false,
      tools: [tool],
      tool_choice: a.force ? { type: a.toolType } : "auto",
      input: question,
    };
    if (a.extras) {
      body.include = ["web_search_call.action.sources"];
      body.instructions = languageHint(o.language);
    }

    try {
      const rawBase = (o.baseUrl || "").trim().replace(/\/+$/, "");
      const root = rawBase ? rawBase.replace(/\/responses$/, "") : "https://api.openai.com/v1";
      const url = root.endsWith("/responses") ? root : `${root}/responses`;
      const { res, call } = await loggedFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      }, { provider: "openai", model, attempt });
      if (res.ok) {
        const data = await res.json();
        // The Responses API reports input_tokens/output_tokens — the dialect tokens.ts files
        // under "kie", which is the same endpoint shape whichever host serves it.
        call.finish({ ...usageFrom("kie", data), responseBody: data });
        return parseOpenAi(data, model);
      }
      lastErr = `chatgpt ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      call.finish({ error: lastErr });
      // 401/429 are about the key or the budget — retrying with a smaller feature set is noise.
      if (res.status === 401 || res.status === 403 || res.status === 429) return { error: lastErr };
    } catch (e: any) {
      return { error: e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : String(e?.message ?? e) };
    }
  }
  return { error: lastErr || "chatgpt: unknown error" };
}

function parseOpenAi(data: any, model: string): EngineTrace {
  const out: any[] = Array.isArray(data?.output) ? data.output : [];
  const citations: AeoCitation[] = [];
  const scanned: string[] = [];
  let text = "";
  let searched = false;

  for (const item of out) {
    if (item?.type === "web_search_call") {
      searched = true;
      const sources = Array.isArray(item?.action?.sources) ? item.action.sources : [];
      for (const s of sources) {
        const url = typeof s === "string" ? s : s?.url;
        if (url) scanned.push(domainOf(url));
      }
      if (item?.action?.url) scanned.push(domainOf(item.action.url));
    } else if (item?.type === "message") {
      for (const c of (Array.isArray(item.content) ? item.content : [])) {
        if (typeof c?.text === "string") text += c.text + "\n";
        for (const a of (c?.annotations ?? [])) {
          if (a?.type === "url_citation" && a.url) citations.push({ url: a.url, domain: domainOf(a.url), title: a.title ?? "" });
        }
      }
    }
  }
  if (!text && typeof data?.output_text === "string") text = data.output_text;
  return { text: text.trim(), citations, scanned, searched, model };
}

export async function checkChatGpt(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const r = await callOpenAi(apiKey, question, o);
  if ("error" in r) return failed(r.error, o.model || AEO_DEFAULT_MODEL);
  return verdict(hostOf(domain), brandTerms, r);
}

// ─── Perplexity — sonar, search is always on ─────────────────────────────────

const PERPLEXITY_MODEL = "sonar";

export async function checkPerplexity(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const model = o.model || PERPLEXITY_MODEL;
  const rawBase = (o.baseUrl || "").trim().replace(/\/+$/, "");
  const url = rawBase ? (rawBase.endsWith("/chat/completions") ? rawBase : `${rawBase.replace(/\/v1$/, "")}/v1/chat/completions`) : "https://api.perplexity.ai/chat/completions";
  const webOpts: Record<string, unknown> = { search_context_size: "high" };
  if (o.country) webOpts.user_location = { country: o.country.toUpperCase(), ...(o.city ? { city: o.city } : {}) };

  try {
    const { res, call } = await loggedFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: languageHint(o.language) },
          { role: "user", content: question },
        ],
        web_search_options: webOpts,
      }),
      signal: AbortSignal.timeout(120_000),
    }, { provider: "perplexity", model });
    if (!res.ok) {
      const error = `perplexity ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      call.finish({ error });
      return failed(error, model);
    }

    const data = await res.json();
    // sonar speaks the chat-completions dialect, prompt_tokens/completion_tokens.
    call.finish({ ...usageFrom("openai", data), responseBody: data });
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    // `search_results` is the current shape; `citations` is the older string[] form. Both are
    // still returned by some deployments, so read whichever is present.
    const results: any[] = Array.isArray(data?.search_results) ? data.search_results : [];
    const citations: AeoCitation[] = results
      .filter(r => r?.url)
      .map(r => ({ url: r.url, domain: domainOf(r.url), title: r.title ?? "" }));
    if (!citations.length && Array.isArray(data?.citations)) {
      for (const u of data.citations) if (typeof u === "string") citations.push({ url: u, domain: domainOf(u), title: "" });
    }
    return verdict(hostOf(domain), brandTerms, { text, citations, scanned: citations.map(c => c.domain), searched: true, model });
  } catch (e: any) {
    return failed(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : `perplexity: ${e?.message ?? e}`, model);
  }
}

// ─── Claude — Messages API + server-side web_search tool ─────────────────────

const CLAUDE_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function checkClaude(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const model = o.model || CLAUDE_DEFAULT_MODEL;
  const rawBase = (o.baseUrl || "").trim().replace(/\/+$/, "");
  const isProxied = !!rawBase && !rawBase.includes("api.anthropic.com");
  const root = rawBase ? rawBase.replace(/\/v1$/, "") : "https://api.anthropic.com";

  const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: 6 };
  if (o.country) {
    tool.user_location = {
      type: "approximate",
      country: o.country.toUpperCase(),
      ...(o.city ? { city: o.city } : {}),
      ...(o.region ? { region: o.region } : {}),
    };
  }

  // Two requests at most — the search tool is not enabled on every workspace and a 400/404 is
  // answered by asking again without it — so each gets its own numbered row.
  let attempt = 0;
  let logged: CallHandle | undefined;
  async function call(withTool: boolean) {
    attempt += 1;
    const opened = await loggedFetch(`${root}/v1/messages`, {
      method: "POST",
      headers: {
        ...(isProxied || !apiKey.startsWith("sk-ant-") ? { "Authorization": `Bearer ${apiKey}` } : {}),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: languageHint(o.language),
        messages: [{ role: "user", content: question }],
        ...(withTool ? { tools: [tool] } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    }, { provider: "anthropic", model, attempt });
    logged = opened.call;
    return opened.res;
  }

  try {
    // Web search is a paid server tool and not enabled on every workspace; fall back to a plain
    // answer rather than reporting an error the user can do nothing about.
    let res = await call(true);
    let searched = true;
    if (res.status === 400 || res.status === 404) {
      logged?.finish({ error: `claude ${res.status}` });
      res = await call(false);
      searched = false;
    }
    if (!res.ok) {
      const error = `claude ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      logged?.finish({ error });
      return failed(error, model);
    }

    const data = await res.json();
    logged?.finish({ ...usageFrom("anthropic", data), responseBody: data });
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const citations: AeoCitation[] = [];
    const scanned: string[] = [];
    let text = "";

    for (const b of blocks) {
      if (b?.type === "text") {
        text += (b.text ?? "") + "\n";
        for (const c of (b.citations ?? [])) {
          if (c?.url) citations.push({ url: c.url, domain: domainOf(c.url), title: c.title ?? "" });
        }
      } else if (b?.type === "web_search_tool_result") {
        for (const r of (Array.isArray(b.content) ? b.content : [])) {
          if (r?.url) scanned.push(domainOf(r.url));
        }
      }
    }
    return verdict(hostOf(domain), brandTerms, { text: text.trim(), citations, scanned, searched, model });
  } catch (e: any) {
    const error = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : `claude: ${e?.message ?? e}`;
    logged?.finish({ error });
    return failed(error, model);
  }
}

// ─── Grok (xAI) — chat/completions + Live Search ─────────────────────────────

const GROK_MODEL = "grok-4-fast";

export async function checkGrok(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const model = o.model || GROK_MODEL;
  const rawBase = (o.baseUrl || "").trim().replace(/\/+$/, "");
  const url = rawBase ? (rawBase.endsWith("/chat/completions") ? rawBase : `${rawBase.replace(/\/v1$/, "")}/v1/chat/completions`) : "https://api.x.ai/v1/chat/completions";

  const webSource: Record<string, unknown> = { type: "web" };
  if (o.country) webSource.country = o.country.toUpperCase();

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: languageHint(o.language) },
      { role: "user", content: question },
    ],
    search_parameters: {
      mode: "auto",
      return_citations: true,
      max_search_results: 20,
      sources: [webSource, { type: "news", ...(o.country ? { country: o.country.toUpperCase() } : {}) }],
    },
  };

  try {
    const { res, call } = await loggedFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }, { provider: "xai", model });
    if (!res.ok) {
      const error = `grok ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      call.finish({ error });
      return failed(error, model);
    }

    const data = await res.json();
    // xAI speaks the chat-completions dialect.
    call.finish({ ...usageFrom("openai", data), responseBody: data });
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const raw: any[] = Array.isArray(data?.citations) ? data.citations : [];
    const citations: AeoCitation[] = raw
      .map(c => (typeof c === "string" ? c : c?.url))
      .filter(Boolean)
      .map((u: string) => ({ url: u, domain: domainOf(u), title: "" }));
    return verdict(hostOf(domain), brandTerms, { text, citations, scanned: citations.map(c => c.domain), searched: true, model });
  } catch (e: any) {
    return failed(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : `grok: ${e?.message ?? e}`, model);
  }
}

// ─── Gemini — generateContent + google_search grounding ──────────────────────

// The current Flash model with Search grounding. The id comes from the same defaults table the
// rest of the app reads (providerDefaults), so it ages with that table instead of silently
// going stale here — the one rule is that it must be a model that accepts the google_search tool.
export const AEO_GEMINI_MODEL = defaultModelFor("gemini");

// Looks like a bare host: "example.com", "sub.example.co.uk". No spaces, at least one dot,
// host-legal characters only.
function looksLikeHost(s: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s.trim().toLowerCase());
}

// Gemini's grounding uri is a vertexaisearch.cloud.google.com redirect, but the source usually
// surfaces in the title as "... — Publisher" or "... | example.com". Reading the domain off the
// title costs nothing; expanding the redirect would be one more network call per citation, per
// check — exactly the kind of hidden cost this tracker refuses. Returns "" when the title does
// not name a host (the honest answer, not a guess).
export function hostFromTitle(title: string): string {
  const t = (title || "").trim().toLowerCase().replace(/^www\./, "");
  if (looksLikeHost(t)) return t;
  const segments = t.split(/\s+[–—|·:,-]\s+/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i].replace(/^www\./, "");
    if (looksLikeHost(s)) return s;
  }
  return "";
}

/** A Gemini generateContent response — only the fields this parser reads. */
interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: {
      webSearchQueries?: unknown[];
      groundingChunks?: { web?: { uri?: unknown; title?: unknown; domain?: unknown } }[];
    };
  }[];
}

/** Pure parse of a Gemini generateContent response with google_search grounding. Exported for
 *  tests; checkGemini is a thin fetch + verdict around it. */
export function parseGeminiGrounding(data: GeminiResponse, model: string): EngineTrace {
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  const text = parts.map(p => (typeof p?.text === "string" ? p.text : "")).join("").trim();

  const gm = cand?.groundingMetadata;
  const chunks = Array.isArray(gm?.groundingChunks) ? gm.groundingChunks : [];
  const citations: AeoCitation[] = [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    if (!web) continue;
    const uri = typeof web.uri === "string" ? web.uri : "";
    const title = typeof web.title === "string" ? web.title : "";
    // Some API revisions put the source domain on the chunk directly; when they do it is the
    // most trustworthy copy. Otherwise fall back to the title, else leave it empty.
    const direct = typeof web.domain === "string" ? web.domain.trim() : "";
    const domain = looksLikeHost(direct) ? direct.replace(/^www\./, "").toLowerCase() : hostFromTitle(title);
    if (!uri && !domain) continue;
    citations.push({ url: uri, domain, title });
  }

  const searched = Array.isArray(gm?.webSearchQueries) && gm.webSearchQueries.length > 0;
  return { text, citations, scanned: citations.map(c => c.domain), searched, model };
}

export async function checkGemini(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const model = o.model || AEO_GEMINI_MODEL;
  const rawBase = (o.baseUrl || "").trim().replace(/\/+$/, "");
  const root = rawBase || "https://generativelanguage.googleapis.com";

  try {
    const { res, call } = await loggedFetch(
      `${root}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: languageHint(o.language) }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
          // Server-side Search grounding — the analogue of the other engines' web-search tools.
          // Billed past Google's free tier, which is why the UI confirms cost before a check.
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(120_000),
      },
      { provider: "gemini", model },
    );
    if (!res.ok) {
      const error = `gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      call.finish({ error });
      return failed(error, model);
    }

    const data = await res.json();
    call.finish({ ...usageFrom("gemini", data), responseBody: data });
    return verdict(hostOf(domain), brandTerms, parseGeminiGrounding(data, model));
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    return failed(name === "TimeoutError" || name === "AbortError" ? "timeout" : `gemini: ${msg}`, model);
  }
}

// ─── Google AI Overviews — the block on Google's own SERP (N7) ────────────────

/** Who fetches the SERP the AI Overview is read from. DataForSEO first, A-Parser as the
 *  self-hosted alternative — the same preference the brief states. */
export interface AioContext {
  provider: "dataforseo" | "aparser";
  /** DataForSEO credential: "login:password" or the ready Base64 token from the dashboard. */
  dataForSeoKey?: string;
  /** A-Parser connection (SE::Google). */
  aparser?: { baseUrl: string; password: string; configPreset?: string };
}

/** What an AI Overview parse produced. `noOverview` means the SERP came back fine and Google
 *  simply showed no overview for the question — a verdict, not an error. */
export interface AioParseResult {
  text: string;
  citations: AeoCitation[];
  noOverview: boolean;
}

/** The model label stored on the AeoCheck row for this engine. There is no model — the text is
 *  Google's own overview — so the label names the source instead, exactly like `model` names the
 *  answering model on every other engine. */
export const AIO_MODEL_LABEL = "google-ai-overview";

// One SERP page is all an overview ever needs: the block renders above the organic results.
const AIO_DEPTH = 10;

// A DataForSEO SERP Advanced response carries the overview as an item of type "ai_overview"
// alongside the organic rows. The sources have been seen under two keys (`items` in the
// documented shape, `references` in some revisions) and the domain under `source` or `domain`;
// every spelling is read, none is assumed. A block with neither text nor sources is treated as
// absent — an overview we cannot read is not evidence of anything.
export function parseDataForSeoAiOverview(data: unknown): AioParseResult {
  const root = data as { tasks?: { result?: { items?: unknown[] }[] }[] } | null;
  const items = root?.tasks?.[0]?.result?.[0]?.items;
  const block = (Array.isArray(items) ? items : []).find(
    (it): it is Record<string, unknown> => !!it && typeof it === "object" && (it as { type?: unknown }).type === "ai_overview",
  );
  if (!block) return { text: "", citations: [], noOverview: true };

  const refs: Record<string, unknown>[] = [
    ...(Array.isArray(block.items) ? (block.items as unknown[]) : []),
    ...(Array.isArray(block.references) ? (block.references as unknown[]) : []),
  ].filter((r): r is Record<string, unknown> => !!r && typeof r === "object");

  const citations: AeoCitation[] = [];
  for (const r of refs) {
    const url = typeof r.url === "string" ? r.url : "";
    const domain =
      (typeof r.domain === "string" && r.domain.trim()) ||
      (typeof r.source === "string" && r.source.trim()) ||
      domainOf(url);
    const title = typeof r.title === "string" ? r.title : "";
    if (!url && !domain) continue;
    citations.push({ url, domain, title });
  }

  let text = typeof block.text === "string" ? block.text.trim() : "";
  if (!text) {
    // Item-level texts exist in some revisions — joined they are still the overview's content.
    const parts = refs.map(r => (typeof r.text === "string" ? r.text.trim() : "")).filter(Boolean);
    if (parts.length) text = parts.join("\n");
  }

  if (!text && !citations.length) return { text: "", citations: [], noOverview: true };
  return { text, citations, noOverview: false };
}

// A-Parser's SE::Google row reports the overview as two flat fields, `ai_answer` and `ai_type`
// (both "none" when Google showed no block — confirmed against live SERP Monitor history). No
// source list travels with them, so citations stay empty and the verdict runs on the text alone;
// bare URLs in the text are still picked up by `linksFromText` inside `verdict`.
export function parseAparserAiOverview(row: unknown): AioParseResult {
  const r = (row ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
  const aiAnswer = asStr(r.ai_answer);
  if (!aiAnswer || /^none$/i.test(aiAnswer)) return { text: "", citations: [], noOverview: true };
  return { text: aiAnswer, citations: [], noOverview: false };
}

function aioVerdict(host: string, brandTerms: string[], p: AioParseResult): AeoCheckResult {
  if (p.noOverview) {
    return {
      cited: false, mentioned: false, status: "no_overview", url: null, snippet: null, rank: null,
      answerText: null, citations: [], searched: true, scanned: false, model: AIO_MODEL_LABEL,
    };
  }
  return verdict(host, brandTerms, { text: p.text, citations: p.citations, scanned: [], searched: true, model: AIO_MODEL_LABEL });
}

async function checkAiOverviewDataForSeo(
  credential: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions,
): Promise<AeoCheckResult> {
  const host = hostOf(domain);
  const cred = (credential || "").trim();
  const auth = cred.includes(":") ? Buffer.from(cred).toString("base64") : cred;
  const gl = (o.country || "us").toLowerCase();
  const task = [{
    keyword: question,
    language_code: o.language || defaultLanguageFor(gl),
    location_code: DFS_LOC[gl] ?? 2840,
    depth: AIO_DEPTH,
  }];

  try {
    const { res, call } = await loggedFetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(45_000),
    }, { provider: "dataforseo", model: AIO_MODEL_LABEL });
    const data = await res.json().catch(() => null);
    const costUsd = dfsCostUsd(data);
    if (!res.ok) {
      const error = `ai_overview dataforseo ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      call.finish({ error, ...(costUsd != null ? { costUsd } : {}) });
      return failed(error, AIO_MODEL_LABEL);
    }
    // The envelope and the task each carry their own status; both are checked, like serp.ts.
    if (data?.status_code && data.status_code !== 20000) {
      const error = `ai_overview dataforseo ${data.status_code}: ${data.status_message}`;
      call.finish({ error, costUsd, responseBody: data });
      return failed(error, AIO_MODEL_LABEL);
    }
    const taskObj = data?.tasks?.[0];
    if (taskObj?.status_code && taskObj.status_code !== 20000) {
      const error = `ai_overview dataforseo task ${taskObj.status_code}: ${taskObj.status_message}`;
      call.finish({ error, costUsd, responseBody: data });
      return failed(error, AIO_MODEL_LABEL);
    }
    call.finish({ ...(costUsd != null ? { costUsd } : {}), responseBody: data });
    return aioVerdict(host, brandTerms, parseDataForSeoAiOverview(data));
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    return failed(name === "TimeoutError" || name === "AbortError" ? "timeout" : `ai_overview dataforseo: ${msg}`, AIO_MODEL_LABEL);
  }
}

async function checkAiOverviewAparser(
  creds: AparserCreds | null | undefined, question: string, domain: string, brandTerms: string[], o: AeoRunOptions,
): Promise<AeoCheckResult> {
  if (!creds?.baseUrl || !creds.password) return failed("ai_overview aparser: no connection", AIO_MODEL_LABEL);
  const host = hostOf(domain);
  const options = aparserSerpOptions({
    depth: AIO_DEPTH,
    gl: (o.country || "").toLowerCase(),
    hl: (o.language || "").toLowerCase(),
  });

  try {
    const r = await aparserOneRequest(creds, "SE::Google", question, options, { doLog: true });
    if (r.error || !r.data) {
      return failed(`ai_overview aparser: ${r.error || "no answer"}`, AIO_MODEL_LABEL);
    }
    const row = Array.isArray(r.data.results) ? r.data.results[0] : null;
    if (!row || typeof row !== "object") {
      return failed(`ai_overview aparser: no result row (${describeAparserRow(row, r.data.logs)})`, AIO_MODEL_LABEL);
    }
    // An overview that IS there wins over any SERP-side problem — the block is parsed from the
    // same page the organic rows are. Without one, an empty page must be told apart from "Google
    // showed no overview": a burnt proxy / captcha is an error, `ai_answer: "none"` is a verdict.
    const parsed = parseAparserAiOverview(row);
    if (parsed.noOverview) {
      let problem = parserResultProblem(row, ["serp"]);
      if (problem === "aparser_parser_failed" && captchaShows(row) > 0) problem = "aparser_blocked_or_empty";
      if (problem) return failed(`ai_overview aparser: ${problem} (${describeAparserRow(row, r.data.logs)})`, AIO_MODEL_LABEL);
    }
    return aioVerdict(host, brandTerms, parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failed(`ai_overview aparser: ${msg}`, AIO_MODEL_LABEL);
  }
}

export async function checkAiOverview(
  ctx: AioContext | null | undefined, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {},
): Promise<AeoCheckResult> {
  if (!ctx) return failed("no_aio_provider", AIO_MODEL_LABEL);
  if (ctx.provider === "dataforseo") return checkAiOverviewDataForSeo(ctx.dataForSeoKey || "", question, domain, brandTerms, o);
  return checkAiOverviewAparser(ctx.aparser, question, domain, brandTerms, o);
}

export async function runAeoCheck(
  engine: AeoEngine, apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {},
): Promise<AeoCheckResult> {
  // ai_overview has no key of its own — it runs on whoever fetches the SERP (o.aio).
  if (engine !== "ai_overview" && !apiKey) return failed("no_key");
  const terms = brandTermsFor(hostOf(domain), brandTerms);
  switch (engine) {
    case "chatgpt": return checkChatGpt(apiKey, question, domain, terms, o);
    case "perplexity": return checkPerplexity(apiKey, question, domain, terms, o);
    case "claude": return checkClaude(apiKey, question, domain, terms, o);
    case "grok": return checkGrok(apiKey, question, domain, terms, o);
    case "gemini": return checkGemini(apiKey, question, domain, terms, o);
    case "ai_overview": return checkAiOverview(o.aio, question, domain, terms, o);
  }
}
