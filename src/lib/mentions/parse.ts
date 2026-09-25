// Brand mentions — pure text/URL helpers (T6, docs/tasks/wave-oct/T6-mentions.md).
// No Prisma, no fetch: everything here is decision logic that the sources, the store and the
// tests share. The one deliberate exception is deriveTerms importing parseBrandTerms from
// aeoTracker (the wave brief says import, not copy) — see the note there.

import { createHash } from "node:crypto";
import { parseBrandTerms } from "@/lib/aeoTracker";
import type { MentionHit, MentionTerm } from "./types";

// ── XML / HTML text decoding ──────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/**
 * One exact decode pass, the way a feed reader does it. A single global replace never rescans
 * its own output, so "&amp;lt;" becomes "&lt;" (correct for one level) rather than "<".
 */
export function decodeXmlEntities(input: string): string {
  return input.replace(/&(amp|lt|gt|quot|apos|nbsp|#x[0-9a-f]+|#\d+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith("#x")) {
      return codePoint(parseInt(name.slice(2), 16));
    }
    if (key.startsWith("#")) {
      return codePoint(parseInt(name.slice(1), 10));
    }
    return NAMED_ENTITIES[key] ?? whole;
  });
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Inner text of `<tag …>…</tag>`: CDATA content verbatim, otherwise entities decoded once. */
function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const inner = m[1];
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : decodeXmlEntities(inner)).trim();
}

/** Strip tags from a decoded-once HTML fragment and decode the remaining text entities. */
export function stripHtml(html: string): string {
  return decodeXmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const capCodePoints = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max).join("")}…`;
};

// ── Google News RSS ───────────────────────────────────────────────────────────

/**
 * Parse Google News RSS search results over `<item>…</item>` (regex, no new deps).
 * The trailing " - Publisher" is split off the title only when it equals the `<source>` text —
 * Google truncates long titles with an ellipsis, and a wrong split loses information.
 */
export function parseGoogleNewsRss(xml: string, term: string, lang: string): MentionHit[] {
  const out: MentionHit[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = tagText(block, "title") ?? "";
    const link = (tagText(block, "link") ?? "").trim();
    if (!rawTitle && !link) continue; // channel furniture or a malformed item — not a mention

    const pubDate = tagText(block, "pubDate");
    const published = pubDate ? new Date(pubDate) : null;

    const source = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
    const publisher = source ? decodeXmlEntities(source[2]).trim() : "";

    let title = rawTitle;
    if (publisher) {
      const tail = ` - ${publisher}`;
      if (title.endsWith(tail)) title = title.slice(0, -tail.length).trim();
    }

    const description = tagText(block, "description") ?? "";

    out.push({
      source: "news",
      kind: "mention",
      term,
      url: link,
      title,
      snippet: capCodePoints(stripHtml(description), 300),
      publisher,
      lang,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
    });
  }
  return out;
}

// ── Term matching ─────────────────────────────────────────────────────────────

// Letters that survive the combining-mark strip badly get an explicit map first.
const FOLD_MAP: Record<string, string> = {
  ø: "o", ö: "o", ő: "o", æ: "ae", ä: "a", å: "a", à: "a", á: "a", è: "e", é: "e", ê: "e", ë: "e",
  ü: "u", ű: "u", ù: "u", ú: "u", û: "u", ì: "i", í: "i", î: "i", ï: "i", ñ: "n", ç: "c",
  ß: "ss", đ: "d", ħ: "h", ł: "l", ō: "o", õ: "o", œ: "oe", ț: "t", ș: "s", ў: "u",
};

/**
 * Case- and diacritics-insensitive fold for matching. NFD + strip combining marks handles the
 * Latin/Cyrillic/Greek accents; the letters that decompose badly are mapped above. CJK passes
 * through untouched (word boundaries below are no-ops there, which is correct: a CJK brand
 * name matches as a substring because there are no word characters around it to begin with).
 */
function fold(s: string): string {
  let mapped = "";
  for (const ch of s) mapped += FOLD_MAP[ch.toLowerCase()] ?? ch;
  return mapped.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary regex for an already-folded phrase; whitespace inside the phrase is flexible. */
function phraseRe(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).filter(Boolean).map(escapeRe).join("\\s+");
  if (!body) return /$^/; // never matches — an empty term is not a match
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "u");
}

/**
 * The noise gate (CONTRACT §0.8): the term must appear at a word boundary ("Crown" does not
 * match "Crowning"), and when the term carries context words at least one of those must appear
 * too — "Golden Crown" alone pulls in hotels and pageants.
 */
export function matchesTerm(text: string, t: MentionTerm): boolean {
  if (!t.term?.trim()) return false;
  const folded = fold(text);
  if (!phraseRe(fold(t.term)).test(folded)) return false;
  const must = (t.mustInclude ?? []).map(w => w.trim()).filter(Boolean);
  if (!must.length) return true;
  return must.some(w => phraseRe(fold(w)).test(folded));
}

/** User stop-words: substring (not word-boundary) so "casino bonus" exclusions bite mid-phrase. */
export function isExcluded(hit: MentionHit, exclude: string[]): boolean {
  if (!exclude?.length) return false;
  const haystack = fold(`${hit.title} ${hit.snippet}`);
  return exclude.some(w => w.trim() && haystack.includes(fold(w.trim())));
}

// ── URL normalisation ─────────────────────────────────────────────────────────

/**
 * Dedupe key for a mention URL: lowercase host, no fragment, no utm_/fbclid/gclid tracking
 * parameters. Over 191 chars (the schema's key width) it collapses to the sha1 hex of the
 * normalised URL — stable, and comfortably short.
 */
export function normalizeMentionUrl(url: string): string {
  let normalized = url;
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const drop: string[] = [];
    u.searchParams.forEach((_v, name) => {
      const n = name.toLowerCase();
      if (n.startsWith("utm_") || n === "fbclid" || n === "gclid") drop.push(name);
    });
    for (const name of drop) u.searchParams.delete(name);
    normalized = u.toString();
  } catch {
    // Not a parseable absolute URL — keep the raw string; the length guard still applies.
  }
  if (normalized.length <= 191) return normalized;
  return createHash("sha1").update(normalized).digest("hex");
}

// ── Term derivation ───────────────────────────────────────────────────────────

const MAX_DERIVED_TERMS = 20;

// Second-level labels that belong to the registry rather than the registrant (example.co.uk
// must yield "example", not "co"). Small on purpose; an unknown SLD costs one useless term,
// never a wrong match.
const REGISTRY_LABELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or"]);

/** The brand-ish label of a host: the registered domain's own name, not a subdomain. */
function hostBrandLabel(host: string): string {
  const labels = host.replace(/^www\./i, "").toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return "";
  let cut = labels.length - 2; // drop the TLD
  while (cut >= 1 && REGISTRY_LABELS.has(labels[cut])) cut--; // example.co.uk → "example"
  return labels[Math.max(0, cut)] ?? "";
}

/**
 * Empty settings.terms → watch the site's branded keywords (JSON array or comma-separated —
 * parseBrandTerms already tolerates both shapes) plus the host's brand label when it is
 * ≥ 4 chars ("abc.io" would watch the word "abc", which is noise). Derived terms get no
 * mustInclude: context words are a human's call about their own brand name.
 */
export function deriveTerms(brandedKeywords: string | null, host: string): MentionTerm[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (raw: string): void => {
    const term = raw.trim();
    const key = fold(term);
    if (term.length < 2 || seen.has(key) || terms.length >= MAX_DERIVED_TERMS) return;
    seen.add(key);
    terms.push(term);
  };

  for (const term of parseBrandTerms(brandedKeywords)) add(term);

  const label = hostBrandLabel(host);
  if (Array.from(label).length >= 4) add(label);

  return terms.map(term => ({ term, mustInclude: [] }));
}
