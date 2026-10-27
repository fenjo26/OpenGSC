/**
 * Duplicate detection for the Site Audit — near-identical page content and repeated descriptions.
 *
 * Content: each page's MAIN content (<main>, else <article>, else <body> minus header, nav,
 * footer, aside and forms) becomes a set of hashed 3-word shingles. Text that sits on nearly every
 * page (cookie banners, a sidebar the region filter missed) is dropped as site chrome, then pages
 * are compared by Jaccard similarity of what remains. MinHash + LSH banding finds the candidate
 * pairs, so a 5,000-page crawl is not 12.5 million comparisons; every reported pair is confirmed
 * on the exact shingle sets.
 *
 * Why 3-word shingles and 0.8: every mention of a swapped word breaks k shingles, so the shingle
 * length decides whether a template page with the city name swapped still reads as a copy. With
 * the city named 10 times in 400 words, k = 3 keeps the pair at ~0.86 (reported), while k = 5
 * would drop it to ~0.78 (missed) — and that page is exactly the near-duplicate a search engine
 * folds together. Two genuinely different texts stay far below.
 *
 * Pure and Prisma-free. The crawler keeps only the compact shingle array per page, never the text.
 */
import { normalizeForDiff, tokenize } from "@/lib/seo/textSimilarity";

export const SHINGLE_WORDS = 3;
/** Unique shingles kept per page — bounds memory (≤ 8 KB/page) on a 5,000-page crawl. */
export const MAX_SHINGLES = 2000;
/** Below this many shingles after chrome removal, a page has too little text to compare. */
export const MIN_SHINGLES = 30;
/** Jaccard similarity at or above which two pages are reported as near-duplicates. */
export const NEAR_DUPLICATE_THRESHOLD = 0.8;
/** A shingle on at least this share of pages (on sites of ≥ 10 pages) is site chrome. */
export const CHROME_SHARE = 0.8;
export const CLUSTER_SAMPLE_SIZE = 10;

const MINHASH = 64;
const BANDS = 16;
const ROWS = MINHASH / BANDS;
/** Buckets larger than this are compared star-wise against their first member, not pairwise. */
const BUCKET_PAIRWISE_LIMIT = 300;

/** The page's main content as plain text. */
export function mainContentText(html: string): string {
  const pick = (re: RegExp) => html.match(re)?.[1];
  let region = pick(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
    ?? pick(/<article\b[^>]*>([\s\S]*)<\/article>/i)
    ?? pick(/<body\b[^>]*>([\s\S]*)<\/body>/i)
    ?? html;
  region = region
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
  return region;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sorted unique shingle hashes of a page's main content (empty for pages with no text). */
export function contentShingles(html: string): Uint32Array {
  const tokens = tokenize(normalizeForDiff(mainContentText(html)));
  const seen = new Set<number>();
  for (let i = 0; i + SHINGLE_WORDS <= tokens.length && seen.size < MAX_SHINGLES; i++) {
    seen.add(fnv1a(tokens.slice(i, i + SHINGLE_WORDS).join(" ")));
  }
  return Uint32Array.from(seen).sort();
}

/** Jaccard similarity of two sorted unique arrays. */
export function jaccardSorted(a: Uint32Array, b: Uint32Array): number {
  if (!a.length && !b.length) return 1;
  let i = 0, j = 0, inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { inter++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return inter / (a.length + b.length - inter);
}

function fmix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS = Array.from({ length: MINHASH }, (_, i) => fmix32(0x9e3779b9 * (i + 1)));

function minhash(set: Uint32Array): Uint32Array {
  const sig = new Uint32Array(MINHASH).fill(0xffffffff);
  for (const x of set) {
    for (let i = 0; i < MINHASH; i++) {
      const h = fmix32(x ^ SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

export interface DuplicateInput {
  url: string;
  shingles: Uint32Array;
}

export interface NearDuplicate {
  /** The most similar other page. */
  with: string;
  /** Jaccard similarity to it, 0..1. */
  similarity: number;
  /** How many other pages in the same cluster. */
  others: number;
}

export interface DuplicateCluster {
  size: number;
  /** Lowest confirmed pairwise similarity that joined the cluster. */
  minSimilarity: number;
  urls: string[];
}

export interface DuplicateResult {
  byUrl: Map<string, NearDuplicate>;
  clusters: { count: number; pages: number; sample: DuplicateCluster[] };
}

/**
 * Near-duplicate clusters among `pages`. Callers pass only pages that should be unique: 200 HTML,
 * not closed on purpose, not canonicalised elsewhere — a page that already names another URL as
 * its canonical has declared itself a duplicate and is not a finding.
 */
export function findNearDuplicates(pages: readonly DuplicateInput[], threshold = NEAR_DUPLICATE_THRESHOLD): DuplicateResult {
  // Site chrome: shingles present on most pages of a site big enough to tell.
  let chrome: Set<number> | null = null;
  if (pages.length >= 10) {
    const df = new Map<number, number>();
    for (const p of pages) for (const x of p.shingles) df.set(x, (df.get(x) ?? 0) + 1);
    const limit = Math.ceil(pages.length * CHROME_SHARE);
    chrome = new Set([...df].filter(([, n]) => n >= limit).map(([x]) => x));
  }
  const items = pages
    .map(p => ({ url: p.url, set: chrome && chrome.size ? p.shingles.filter(x => !chrome!.has(x)) : p.shingles }))
    .filter(p => p.set.length >= MIN_SHINGLES);
  const sigs = items.map(p => minhash(p.set));

  // Union-find over confirmed pairs.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const best = new Map<number, { j: number; sim: number }>();
  const joinedAt = new Map<number, number>();
  const checked = new Set<string>();
  const consider = (i: number, j: number) => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (checked.has(key)) return;
    checked.add(key);
    // Cheap estimate first; the exact set comparison only for plausible pairs.
    let agree = 0;
    for (let r = 0; r < MINHASH; r++) if (sigs[i][r] === sigs[j][r]) agree++;
    if (agree / MINHASH < threshold - 0.15) return;
    const sim = jaccardSorted(items[i].set, items[j].set);
    if (sim < threshold) return;
    for (const [a, b] of [[i, j], [j, i]]) {
      const cur = best.get(a);
      if (!cur || sim > cur.sim) best.set(a, { j: b, sim });
    }
    const ri = find(i), rj = find(j);
    if (ri !== rj) {
      parent[ri] = rj;
      joinedAt.set(rj, Math.min(joinedAt.get(rj) ?? 1, joinedAt.get(ri) ?? 1, sim));
    } else {
      joinedAt.set(ri, Math.min(joinedAt.get(ri) ?? 1, sim));
    }
  };
  for (let band = 0; band < BANDS; band++) {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < items.length; i++) {
      const key = Array.from(sigs[i].subarray(band * ROWS, band * ROWS + ROWS)).join(",");
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i); else buckets.set(key, [i]);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      if (bucket.length > BUCKET_PAIRWISE_LIMIT) {
        for (let k = 1; k < bucket.length; k++) consider(bucket[0], bucket[k]);
      } else {
        for (let a = 0; a < bucket.length; a++) for (let b = a + 1; b < bucket.length; b++) consider(bucket[a], bucket[b]);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    if (!best.has(i)) continue;
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i); else groups.set(root, [i]);
  }
  const byUrl = new Map<string, NearDuplicate>();
  const clusters: DuplicateCluster[] = [];
  for (const [root, members] of groups) {
    for (const i of members) {
      const b = best.get(i)!;
      byUrl.set(items[i].url, { with: items[b.j].url, similarity: Math.round(b.sim * 100) / 100, others: members.length - 1 });
    }
    clusters.push({
      size: members.length,
      minSimilarity: Math.round((joinedAt.get(root) ?? Math.min(...members.map(i => best.get(i)!.sim))) * 100) / 100,
      urls: members.map(i => items[i].url).sort().slice(0, 5),
    });
  }
  clusters.sort((a, b) => b.size - a.size || a.urls[0].localeCompare(b.urls[0]));
  return {
    byUrl,
    clusters: { count: clusters.length, pages: byUrl.size, sample: clusters.slice(0, CLUSTER_SAMPLE_SIZE) },
  };
}

/** Normalised description key — empty descriptions never count as duplicates. */
export function descriptionKey(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}
