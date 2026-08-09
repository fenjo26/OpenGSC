// AEO Tracker — does an AI answer engine cite this site when a real user question is asked?
//
// The point of this module is parity with what a person actually sees in ChatGPT/Perplexity,
// so every engine here is asked to *search the live web*, not to answer from weights:
//
//   ChatGPT     Responses API + the hosted `web_search` tool, forced via tool_choice.
//   Perplexity  chat/completions (sonar) — search is built in; we tune context size/location.
//   Claude      Messages API + the server-side `web_search` tool.
//   Grok        chat/completions + xAI Live Search (`search_parameters`).
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

export type AeoEngine = "chatgpt" | "perplexity" | "claude" | "grok";

// "cited" — our domain is linked in the answer. "mentioned" — the brand is named in the prose
// but nothing links to us (real, and worth seeing, but a weaker outcome than a citation).
export type AeoStatus = "cited" | "mentioned" | "absent";

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
  /** OpenAI model id for the ChatGPT engine. Other engines have their own fixed models. */
  model?: string;
  /** ISO-3166-1 alpha-2, lowercase (same `gl` codes as the rest of SEO Tools). */
  country?: string | null;
  city?: string | null;
  region?: string | null;
  /** ISO-639-1, lowercase. Only used to nudge the answer language, never the question text. */
  language?: string | null;
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
export const AEO_ENGINES: AeoEngine[] = ["chatgpt", "perplexity", "claude", "grok"];

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
  for (const a of attempts) {
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
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) return parseOpenAi(await res.json(), model);
      lastErr = `chatgpt ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
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
  const webOpts: Record<string, unknown> = { search_context_size: "high" };
  if (o.country) webOpts.user_location = { country: o.country.toUpperCase(), ...(o.city ? { city: o.city } : {}) };

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: "system", content: languageHint(o.language) },
          { role: "user", content: question },
        ],
        web_search_options: webOpts,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return failed(`perplexity ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, PERPLEXITY_MODEL);

    const data = await res.json();
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
    return verdict(hostOf(domain), brandTerms, { text, citations, scanned: citations.map(c => c.domain), searched: true, model: PERPLEXITY_MODEL });
  } catch (e: any) {
    return failed(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : `perplexity: ${e?.message ?? e}`, PERPLEXITY_MODEL);
  }
}

// ─── Claude — Messages API + server-side web_search tool ─────────────────────

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

export async function checkClaude(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: 6 };
  if (o.country) {
    tool.user_location = {
      type: "approximate",
      country: o.country.toUpperCase(),
      ...(o.city ? { city: o.city } : {}),
      ...(o.region ? { region: o.region } : {}),
    };
  }

  async function call(withTool: boolean) {
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: languageHint(o.language),
        messages: [{ role: "user", content: question }],
        ...(withTool ? { tools: [tool] } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
  }

  try {
    // Web search is a paid server tool and not enabled on every workspace; fall back to a plain
    // answer rather than reporting an error the user can do nothing about.
    let res = await call(true);
    let searched = true;
    if (res.status === 400 || res.status === 404) { res = await call(false); searched = false; }
    if (!res.ok) return failed(`claude ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, CLAUDE_MODEL);

    const data = await res.json();
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
    return verdict(hostOf(domain), brandTerms, { text: text.trim(), citations, scanned, searched, model: CLAUDE_MODEL });
  } catch (e: any) {
    return failed(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : `claude: ${e?.message ?? e}`, CLAUDE_MODEL);
  }
}

// ─── Grok (xAI) — chat/completions + Live Search ─────────────────────────────

const GROK_MODEL = "grok-4-fast";

export async function checkGrok(apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {}): Promise<AeoCheckResult> {
  const webSource: Record<string, unknown> = { type: "web" };
  if (o.country) webSource.country = o.country.toUpperCase();

  const body: Record<string, unknown> = {
    model: GROK_MODEL,
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
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return failed(`grok ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, GROK_MODEL);

    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const raw: any[] = Array.isArray(data?.citations) ? data.citations : [];
    const citations: AeoCitation[] = raw
      .map(c => (typeof c === "string" ? c : c?.url))
      .filter(Boolean)
      .map((u: string) => ({ url: u, domain: domainOf(u), title: "" }));
    return verdict(hostOf(domain), brandTerms, { text, citations, scanned: citations.map(c => c.domain), searched: true, model: GROK_MODEL });
  } catch (e: any) {
    return failed(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : `grok: ${e?.message ?? e}`, GROK_MODEL);
  }
}

export async function runAeoCheck(
  engine: AeoEngine, apiKey: string, question: string, domain: string, brandTerms: string[], o: AeoRunOptions = {},
): Promise<AeoCheckResult> {
  if (!apiKey) return failed("no_key");
  const terms = brandTermsFor(hostOf(domain), brandTerms);
  switch (engine) {
    case "chatgpt": return checkChatGpt(apiKey, question, domain, terms, o);
    case "perplexity": return checkPerplexity(apiKey, question, domain, terms, o);
    case "claude": return checkClaude(apiKey, question, domain, terms, o);
    case "grok": return checkGrok(apiKey, question, domain, terms, o);
  }
}
