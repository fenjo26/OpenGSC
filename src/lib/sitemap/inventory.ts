import { gunzipSync } from "node:zlib";
import { safeFetch } from "@/lib/security/safeFetch";

export const MAX_SITEMAP_URLS = 20_000;
export const MAX_CHILD_SITEMAPS = 50;
export const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;

export type SitemapKind = "urlset" | "index";
export type SitemapEntryType = "standard" | "image" | "video" | "news" | "mixed";

export interface SitemapInventoryEntry {
  url: string;
  sourceSitemap: string;
  sitemapType: SitemapEntryType;
  lastmod: string | null;
  lastmodValid: boolean | null;
  imageCount: number;
  videoCount: number;
  newsCount: number;
}

export interface SitemapChild {
  url: string;
  lastmod: string | null;
}

export interface ParsedSitemap {
  kind: SitemapKind;
  entries: SitemapInventoryEntry[];
  children: SitemapChild[];
  invalid: number;
  invalidExamples: string[];
}

export interface SitemapCollection {
  entries: SitemapInventoryEntry[];
  invalid: number;
  invalidExamples: string[];
  fetchedSitemaps: number;
  partial: boolean;
  failures: Array<{ sitemap: string; error: string }>;
}

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .trim();
}

function tagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
}

function tagCount(block: string, tag: string): number {
  return (block.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b`, "gi")) ?? []).length;
}

function blocks(xml: string, tag: string): string[] {
  const result: string[] = [];
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) result.push(match[1]);
  return result;
}

function normalizedHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function isValidSitemapLastmod(value: string): boolean {
  // Sitemap lastmod is W3C datetime: a date or an ISO timestamp with an explicit timezone.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function entryType(imageCount: number, videoCount: number, newsCount: number): SitemapEntryType {
  const kinds = [imageCount > 0, videoCount > 0, newsCount > 0].filter(Boolean).length;
  if (kinds > 1) return "mixed";
  if (imageCount) return "image";
  if (videoCount) return "video";
  if (newsCount) return "news";
  return "standard";
}

/** Parse one XML document without fetching anything. Exported for deterministic tests. */
export function parseSitemapXml(xml: string, sourceSitemap: string): ParsedSitemap {
  const source = normalizedHttpUrl(sourceSitemap);
  if (!source) throw new Error("invalid_sitemap_url");
  const isIndex = /<(?:[\w.-]+:)?sitemapindex\b/i.test(xml);
  const isUrlset = /<(?:[\w.-]+:)?urlset\b/i.test(xml);
  if (!isIndex && !isUrlset) throw new Error("invalid_sitemap_xml");

  const invalidExamples: string[] = [];
  let invalid = 0;
  const markInvalid = (value: string | null) => {
    invalid++;
    if (invalidExamples.length < 10) invalidExamples.push((value || "missing <loc>").slice(0, 300));
  };

  if (isIndex) {
    const children: SitemapChild[] = [];
    for (const block of blocks(xml, "sitemap")) {
      const rawLoc = tagValue(block, "loc");
      const url = normalizedHttpUrl(rawLoc);
      if (!url) { markInvalid(rawLoc); continue; }
      children.push({ url, lastmod: tagValue(block, "lastmod") });
    }
    return { kind: "index", entries: [], children, invalid, invalidExamples };
  }

  const entries: SitemapInventoryEntry[] = [];
  for (const block of blocks(xml, "url")) {
    const rawLoc = tagValue(block, "loc");
    const url = normalizedHttpUrl(rawLoc);
    if (!url) { markInvalid(rawLoc); continue; }
    const lastmod = tagValue(block, "lastmod");
    const imageCount = tagCount(block, "image");
    const videoCount = tagCount(block, "video");
    const newsCount = tagCount(block, "news");
    entries.push({
      url,
      sourceSitemap: source,
      sitemapType: entryType(imageCount, videoCount, newsCount),
      lastmod,
      lastmodValid: lastmod == null ? null : isValidSitemapLastmod(lastmod),
      imageCount,
      videoCount,
      newsCount,
    });
  }
  return { kind: "urlset", entries, children: [], invalid, invalidExamples };
}

function decodeSitemapBuffer(buffer: Buffer): string {
  const body = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
    ? gunzipSync(buffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
    : buffer;
  if (body.length > MAX_DECOMPRESSED_BYTES) throw new Error("sitemap_too_large");
  return body.toString("utf8").replace(/^\uFEFF/, "");
}

async function fetchSitemapXml(url: string): Promise<string> {
  const response = await safeFetch(url, {
    timeoutMs: 15_000,
    maxBytes: MAX_SITEMAP_BYTES,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OpenGSC-Sitemap/1.0; +https://opengsc.org)",
      Accept: "application/xml,text/xml,application/gzip,*/*;q=0.1",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return decodeSitemapBuffer(Buffer.from(await response.arrayBuffer()));
}

/**
 * Resolve an index into a bounded URL inventory. A failed child marks the run partial; callers
 * must not infer disappearance from a partial run. The root failure is thrown to the caller.
 */
export async function collectSitemapInventory(
  rootSitemap: string,
  fetchXml: (url: string) => Promise<string> = fetchSitemapXml,
): Promise<SitemapCollection> {
  const root = normalizedHttpUrl(rootSitemap);
  if (!root) throw new Error("invalid_sitemap_url");

  const collection: SitemapCollection = {
    entries: [], invalid: 0, invalidExamples: [], fetchedSitemaps: 0, partial: false, failures: [],
  };
  const visited = new Set<string>();

  const visit = async (sitemapUrl: string, depth: number, rootRequest = false): Promise<void> => {
    if (visited.has(sitemapUrl) || collection.entries.length >= MAX_SITEMAP_URLS) return;
    if (depth > MAX_SITEMAP_DEPTH) {
      collection.partial = true;
      collection.failures.push({ sitemap: sitemapUrl, error: "depth_limit" });
      return;
    }
    visited.add(sitemapUrl);
    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemapXml(await fetchXml(sitemapUrl), sitemapUrl);
      collection.fetchedSitemaps++;
    } catch (error) {
      if (rootRequest) throw error;
      collection.partial = true;
      collection.failures.push({ sitemap: sitemapUrl, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
      return;
    }

    collection.invalid += parsed.invalid;
    for (const value of parsed.invalidExamples) {
      if (collection.invalidExamples.length < 10) collection.invalidExamples.push(value);
    }
    if (parsed.kind === "urlset") {
      const remaining = MAX_SITEMAP_URLS - collection.entries.length;
      if (parsed.entries.length > remaining) {
        collection.partial = true;
        collection.failures.push({ sitemap: sitemapUrl, error: "url_limit" });
      }
      collection.entries.push(...parsed.entries.slice(0, remaining));
      return;
    }

    // A malformed URL entry is local to one page. A malformed child <loc> can hide an entire
    // subtree, so it must remove the negative evidence needed to mark older URLs missing.
    if (parsed.invalid > 0) {
      collection.partial = true;
      collection.failures.push({ sitemap: sitemapUrl, error: "invalid_child_sitemap" });
    }

    if (parsed.children.length > MAX_CHILD_SITEMAPS) {
      collection.partial = true;
      collection.failures.push({ sitemap: sitemapUrl, error: "child_limit" });
    }
    for (const child of parsed.children.slice(0, MAX_CHILD_SITEMAPS)) {
      if (collection.entries.length >= MAX_SITEMAP_URLS) {
        collection.partial = true;
        collection.failures.push({ sitemap: sitemapUrl, error: "url_limit" });
        break;
      }
      await visit(child.url, depth + 1);
    }
  };

  await visit(root, 0, true);

  // A URL may occur in several sitemaps. Keep the first source but merge extension counts so the
  // row still describes the richest occurrence without multiplying inventory records.
  const deduped = new Map<string, SitemapInventoryEntry>();
  for (const entry of collection.entries) {
    const previous = deduped.get(entry.url);
    if (!previous) { deduped.set(entry.url, entry); continue; }
    const imageCount = Math.max(previous.imageCount, entry.imageCount);
    const videoCount = Math.max(previous.videoCount, entry.videoCount);
    const newsCount = Math.max(previous.newsCount, entry.newsCount);
    deduped.set(entry.url, {
      ...previous,
      lastmod: previous.lastmod ?? entry.lastmod,
      lastmodValid: previous.lastmodValid ?? entry.lastmodValid,
      imageCount,
      videoCount,
      newsCount,
      sitemapType: entryType(imageCount, videoCount, newsCount),
    });
  }
  collection.entries = [...deduped.values()].slice(0, MAX_SITEMAP_URLS);
  return collection;
}
