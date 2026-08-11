// Competitor content scraper for the SEO Tools module.
// Strategy (per spec §2.2): direct fetch + regex H-structure extraction first,
// fall back to Firecrawl when direct fetch fails or returns too little (anti-bot pages).
// No third-party HTML-parsing deps — pure regex extraction.

import { extractMainContent } from "./readability";
import { safeFetch, type SafeFetchResponse } from "@/lib/security/safeFetch";

export interface ScrapedPage {
  url: string;
  ok: boolean;
  via: "fetch" | "firecrawl" | "failed";
  title: string;
  metaDescription: string;
  headings: string[]; // ["H1: ...", "H2: ...", ...] in document order
  wordCount: number;
  hasPriceTable: boolean;
  hasFaq: boolean;
  /**
   * First ~6000 chars of the ARTICLE BODY (not the raw document) — the LLM grounding sample.
   * It used to be the first 6000 chars of the flattened page, which on any real site is the
   * mega-menu, so every consumer of this field was being fed navigation. See ./readability.ts.
   */
  textSample: string;
  /** Article body as Markdown with headings intact — for callers that rewrite or reproduce a page. */
  contentMarkdown: string;
  /** Body word count after boilerplate removal (differs from wordCount, which counts the raw page). */
  contentWords: number;
  /** Share of body text sitting inside links; high means navigation survived. */
  linkDensity: number;
  /** No article found — the page yielded chrome only. Callers must refuse rather than process it. */
  boilerplateOnly: boolean;
  error?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// Parse an HTML string into a ScrapedPage. Shared by fetch + firecrawl paths.
export function parseHtml(url: string, html: string): ScrapedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : "";

  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const metaDescription = descMatch ? decodeEntities(descMatch[1]) : "";

  const headings: string[] = [];
  const hRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = hRe.exec(html)) !== null) {
    const text = stripTags(m[2]);
    if (text) headings.push(`H${m[1]}: ${text}`);
    if (headings.length > 80) break;
  }

  const bodyText = stripTags(html);
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  const hasPriceTable =
    /<table[\s\S]*?(price|cost|€|\$|£|руб|tariff|rate)/i.test(html) ||
    /(price|cost|tariff)[\s\S]{0,40}<table/i.test(html);
  const hasFaq =
    /faq/i.test(html) ||
    /itemtype=["'][^"']*FAQPage/i.test(html) ||
    /frequently asked/i.test(bodyText);

  // Boilerplate removal happens here, once, so every downstream consumer (Rewriter, outline MAP
  // stage, Content Gap, fact-checking) gets article text instead of navigation.
  const main = extractMainContent(html);

  return {
    url,
    ok: true,
    via: "fetch",
    title,
    metaDescription,
    headings,
    wordCount,
    hasPriceTable,
    hasFaq,
    // Prefer extracted body whenever there is ANY of it. Falling back to the flattened document
    // just because the article is short would put the navigation straight back into the sample —
    // a short article is still an article, and menu text is never the better option.
    textSample: (main.text || bodyText).slice(0, 6000),
    contentMarkdown: main.markdown,
    contentWords: main.words,
    linkDensity: main.linkDensity,
    boilerplateOnly: main.boilerplateOnly,
  };
}

// ─── Heading structure extraction (Landing-flow "my page" import) ───────────────
// Splits the raw HTML between consecutive heading tags and counts words in each slice, so the
// UI can show "H2: ... (~120 сл.)" — a per-section word budget derived from the LIVE page, not
// a guess. Order = document order (same as parseHtml's `headings`, but with real per-section size).
export interface StructureNode { level: string; text: string; words: number; }

export function extractStructure(html: string): StructureNode[] {
  const marks: { level: string; text: string; start: number; end: number }[] = [];
  const hRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = hRe.exec(html)) !== null) {
    const text = stripTags(m[2]);
    if (text) marks.push({ level: `H${m[1]}`, text, start: m.index, end: m.index + m[0].length });
    if (marks.length > 150) break;
  }
  if (!marks.length) return [];
  return marks.map((h, i) => {
    const sliceEnd = i + 1 < marks.length ? marks[i + 1].start : html.length;
    const body = stripTags(html.slice(h.end, sliceEnd));
    const words = body ? body.split(/\s+/).filter(Boolean).length : 0;
    return { level: h.level, text: h.text, words };
  });
}

// Markdown fallback (Firecrawl returned no HTML, only markdown) — split on markdown heading lines.
function extractStructureFromMarkdown(md: string): StructureNode[] {
  const lines = md.split(/\r?\n/);
  const marks: { level: string; text: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) marks.push({ level: `H${hm[1].length}`, text: hm[2].trim(), line: i });
  });
  if (!marks.length) return [];
  return marks.map((h, i) => {
    const endLine = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    const body = lines.slice(h.line + 1, endLine).join(" ").trim();
    const words = body ? body.split(/\s+/).filter(Boolean).length : 0;
    return { level: h.level, text: h.text, words };
  });
}

export interface StructureResult {
  url: string; ok: boolean; via: "fetch" | "firecrawl" | "failed";
  title: string; nodes: StructureNode[]; totalWords: number; error?: string;
}

// Fetch a single page (own site or competitor) and return its H1-H6 structure with a real
// per-section word count — used by the Landing-flow "under my page" import.
export async function scrapeStructure(url: string, firecrawlKey?: string): Promise<StructureResult> {
  try {
    const res = await safeFetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const nodes = extractStructure(html);
    if (!nodes.length) throw new Error("no_headings");
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : "";
    return { url, ok: true, via: "fetch", title, nodes, totalWords: nodes.reduce((s, n) => s + n.words, 0) };
  } catch (e: any) {
    if (firecrawlKey) {
      try {
        const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["html", "markdown"], onlyMainContent: true }),
          signal: AbortSignal.timeout(45000),
        });
        if (!res.ok) throw new Error(`firecrawl ${res.status}`);
        const data = await res.json();
        const html: string = data?.data?.html ?? "";
        const md: string = data?.data?.markdown ?? "";
        const meta = data?.data?.metadata ?? {};
        const nodes = html ? extractStructure(html) : extractStructureFromMarkdown(md);
        if (!nodes.length) throw new Error("no_headings");
        return { url, ok: true, via: "firecrawl", title: meta.title || "", nodes, totalWords: nodes.reduce((s, n) => s + n.words, 0) };
      } catch (e2: any) {
        return { url, ok: false, via: "failed", title: "", nodes: [], totalWords: 0, error: `fetch:${e?.message}; firecrawl:${e2?.message}` };
      }
    }
    return { url, ok: false, via: "failed", title: "", nodes: [], totalWords: 0, error: e?.message ?? "fetch_failed" };
  }
}

// Decode a response using the charset the page actually declares.
//
// `res.text()` trusts the Content-Type header and silently falls back to UTF-8 when it is missing
// or wrong. That mangles pages declaring their encoding only in a <meta charset> tag — still common
// on older regional sites (windows-1251 in RU/UA, ISO-8859-7 in GR). Mojibake here is invisible
// downstream: the rewrite still "succeeds", it just produces garbled text.
async function decodeResponse(res: Pick<SafeFetchResponse, "arrayBuffer" | "headers">): Promise<string> {
  const buf = await res.arrayBuffer();
  const header = /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1];
  // Sniff the first 2KB as Latin-1 to read the meta tag without knowing the final encoding yet.
  const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
  const meta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  const charset = (header || meta || "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf); // unknown label — UTF-8 is the safe default
  }
}

async function directFetch(url: string): Promise<ScrapedPage> {
  const res = await safeFetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    timeoutMs: 15_000,
    maxBytes: 5 * 1024 * 1024,
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await decodeResponse(res);
  const parsed = parseHtml(url, html);
  // Heuristic: anti-bot / empty pages → force fallback
  if (parsed.wordCount < 80 && parsed.headings.length === 0) {
    throw new Error("too_little_content");
  }
  return parsed;
}

// Firecrawl fallback. Docs: https://firecrawl.dev — returns clean markdown + html.
async function firecrawlFetch(url: string, apiKey: string): Promise<ScrapedPage> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["html", "markdown"], onlyMainContent: true }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`firecrawl ${res.status}`);
  const data = await res.json();
  const html: string = data?.data?.html ?? "";
  const md: string = data?.data?.markdown ?? "";
  const meta = data?.data?.metadata ?? {};
  const parsed = html ? parseHtml(url, html) : {
    url, ok: true, via: "firecrawl" as const,
    title: meta.title ?? "", metaDescription: meta.description ?? "",
    headings: (md.match(/^#{1,6}\s.+$/gm) ?? []).map((h: string) => {
      const lvl = (h.match(/^#+/)?.[0].length) ?? 1;
      return `H${lvl}: ${h.replace(/^#+\s*/, "").trim()}`;
    }),
    wordCount: md ? md.split(/\s+/).length : 0,
    hasPriceTable: /\|.*(price|cost|€|\$|£|руб)/i.test(md),
    hasFaq: /faq|frequently asked/i.test(md),
    // Firecrawl was asked for onlyMainContent, so its markdown is already the article body.
    textSample: md.slice(0, 6000),
    contentMarkdown: md,
    contentWords: md ? md.split(/\s+/).filter(Boolean).length : 0,
    linkDensity: 0,
    boilerplateOnly: md.split(/\s+/).filter(Boolean).length < 120,
  };
  parsed.via = "firecrawl";
  parsed.title = parsed.title || meta.title || "";
  parsed.metaDescription = parsed.metaDescription || meta.description || "";
  return parsed;
}

export async function scrapePage(url: string, firecrawlKey?: string): Promise<ScrapedPage> {
  try {
    return await directFetch(url);
  } catch (e: any) {
    if (firecrawlKey) {
      try {
        return await firecrawlFetch(url, firecrawlKey);
      } catch (e2: any) {
        return failed(url, `fetch:${e?.message}; firecrawl:${e2?.message}`);
      }
    }
    return failed(url, e?.message ?? "fetch_failed");
  }
}

function failed(url: string, error: string): ScrapedPage {
  return {
    url, ok: false, via: "failed", title: "", metaDescription: "",
    headings: [], wordCount: 0, hasPriceTable: false, hasFaq: false,
    textSample: "", contentMarkdown: "", contentWords: 0, linkDensity: 1,
    boilerplateOnly: true, error,
  };
}

// Scrape many URLs with limited concurrency.
export async function scrapeMany(urls: string[], firecrawlKey?: string, concurrency = 4): Promise<ScrapedPage[]> {
  const out: ScrapedPage[] = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      out[idx] = await scrapePage(urls[idx], firecrawlKey);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}
