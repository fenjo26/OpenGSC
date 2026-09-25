// Footprint skeleton extraction (wave-nov N1) — pure string work, no Prisma, no fetch.
//
// A network footprint is the same title/description/H1 CONSTRUCTION standing on several sites
// with only the entity swapped: «{slot} Démo Gratuite : Jouer Sans Inscription ni Dépôt» was
// found on four sites of the portfolio. A human spots it instantly at manual review, and it is
// trivially linkable algorithmically — which is the whole risk. The skeleton reduces a string
// to that construction: the entity becomes `{x}`, years `{y}`, other numbers `{n}`, so two
// pages match when they share the template regardless of which slot or year was substituted.

// ─── constants (the thresholds the report and the tests share) ───────────────────

/** A skeleton repeated on fewer distinct sites than this is not a network footprint. */
export const MIN_SITES_DEFAULT = 2;

/**
 * Skeletons shorter than this many words are not footprints either: «{x} review» matches every
 * site in any niche, so reporting it would bury the real findings in noise.
 */
export const MIN_SKELETON_WORDS = 4;

/** Jaccard word-similarity at which two skeletons land in the «similar» section. */
export const SIMILARITY_THRESHOLD = 0.85;

// ─── fold ────────────────────────────────────────────────────────────────────────

/** Case- and diacritics-insensitive fold («Démo» → «demo») — the same normalization metaFit uses. */
export const fold = (s: string): string =>
  String(s ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── entities ────────────────────────────────────────────────────────────────────

// Two-label public suffixes whose REGISTRABLE name is the third label from the right
// ("site.co.uk" → "site"). Everything else loses just the TLD.
const TWO_LABEL_TLDS = new Set([
  "co.uk", "org.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "net.nz",
  "co.za", "com.br", "com.mx", "com.tr", "com.cn", "com.tw", "co.jp", "ne.jp", "or.jp",
  "co.in", "net.in", "org.in", "com.sg", "com.hk", "com.ar", "com.ua", "co.kr",
]);

/**
 * The site's domain label as a search entity: hostname without `www.` and without the TLD,
 * hyphens turned into spaces — `golden-crown-extreme-booster.fr` → «golden crown extreme
 * booster». That label is what the site's own titles are built around, so it is the part a
 * shared template would have swapped for `{x}`.
 */
export function domainEntity(urlOrHost: string): string {
  let host = String(urlOrHost ?? "").trim();
  host = host.replace(/^https?:\/\//i, "").replace(/^sc-domain:/i, "");
  host = host.split("/")[0] ?? "";
  host = host.toLowerCase().replace(/^www\./, "");
  host = host.split(":")[0] ?? ""; // strip a port
  const labels = host.split(".").filter(Boolean);
  if (!labels.length) return "";
  const last2 = labels.slice(-2).join(".");
  const name = labels.length >= 3 && TWO_LABEL_TLDS.has(last2) ? labels.slice(-3, -2)[0] : labels[0];
  return String(name ?? "").replace(/[-_]+/g, " ").trim();
}

// ─── the skeleton itself ─────────────────────────────────────────────────────────

/**
 * Reduce a title/description/H1 to its construction.
 *
 * Order: entities first (longest first, so «golden crown extreme booster» is consumed before
 * «golden crown»), then years 2000–2099 → `{y}`, then the remaining digit runs → `{n}`, then
 * whitespace collapse. Years run BEFORE plain numbers on purpose: in the brief's arrow order
 * (numbers → years) a year is already `{n}` by the time the year rule runs, and the year
 * distinction — «reused across years» vs «reused with a content number» — would be dead code.
 *
 * A skeleton with no `{x}` means no entity was found in the text; it still participates in the
 * report (flagged `noEntity` — an identical template WITHOUT even the site name swapped in is a
 * stronger footprint, not a weaker one).
 */
export function skeletonOf(text: string, entities: string[]): string {
  let out = fold(text);
  const ents = [...new Set((entities ?? []).map((e) => fold(e)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const e of ents) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(e)}(?![\\p{L}\\p{N}])`, "gu"),
      "{x}",
    );
  }
  out = out.replace(/(?<![\p{L}\p{N}\{])20[0-9]{2}(?![\p{L}\p{N}\}])/gu, "{y}");
  out = out.replace(/(?<![\p{L}\p{N}\{])\d+(?![\p{L}\p{N}\}])/gu, "{n}");
  return out.replace(/\s+/g, " ").trim();
}

/** True when the skeleton never captured an entity (no `{x}` marker). */
export const isNoEntity = (skeleton: string): boolean => !skeleton.includes("{x}");

/**
 * Words of a skeleton for the minimum-length rule: space-separated tokens that carry letters,
 * digits or a placeholder. Pure punctuation (« : ») is not a word.
 */
export function skeletonWordCount(skeleton: string): number {
  return skeleton.split(/\s+/).filter((tok) => /[\p{L}\p{N}{]/u.test(tok)).length;
}

// ─── grouping (exact) ────────────────────────────────────────────────────────────

export type FootprintKind = "title" | "description" | "h1";
export type FootprintSource = "published" | "generated";

/** One observed occurrence of a template, already reduced to its skeleton. */
export interface FootprintItem {
  skeleton: string;
  kind: FootprintKind;
  source: FootprintSource;
  /**
   * Who the occurrence belongs to: `siteId` for a published page, the record's `keyword` for a
   * generation-history row. The distinct count of these IS the «sites» number — the same phrase
   * repeated on one site is not a footprint, and one keyword regenerated five times is not either.
   */
  identity: string;
  /** Human label of the identity (domain for a site, the keyword itself for a history row). */
  label: string;
  /** Where it was seen: the page URL for published rows, a `history:id` pointer for generated ones. */
  example: string;
}

export interface FootprintExample {
  label: string;
  source: FootprintSource;
  example: string;
}

export interface FootprintGroup {
  skeleton: string;
  noEntity: boolean;
  /** Distinct identities (sites, or keywords for generated-only groups). */
  sites: number;
  /** Occurrences — pages and history records carrying this skeleton. */
  pages: number;
  source: FootprintSource | "both";
  /** One example per identity, first seen first. */
  examples: FootprintExample[];
  /** Present (and `true`) only when the operator's ignore list contains this skeleton. */
  ignored?: boolean;
}

/** A cluster of skeletons that are not identical but are ≥ SIMILARITY_THRESHOLD alike. */
export interface SimilarGroup {
  skeletons: string[];
  sites: number;
  pages: number;
  examples: FootprintExample[];
}

export interface GroupOptions {
  minSites?: number;
  minWords?: number;
}

/** Group items by exact skeleton and keep the groups that qualify for the report. */
export function groupFootprints(
  items: FootprintItem[],
  opts: GroupOptions = {},
): FootprintGroup[] {
  const minSites = Math.max(2, opts.minSites ?? MIN_SITES_DEFAULT);
  const minWords = Math.max(1, opts.minWords ?? MIN_SKELETON_WORDS);

  const bySkeleton = new Map<string, FootprintItem[]>();
  for (const item of items) {
    if (!item.skeleton) continue;
    const list = bySkeleton.get(item.skeleton);
    if (list) list.push(item);
    else bySkeleton.set(item.skeleton, [item]);
  }

  const groups: FootprintGroup[] = [];
  for (const [skeleton, list] of bySkeleton) {
    if (skeletonWordCount(skeleton) < minWords) continue;
    const identities = new Set(list.map((i) => i.identity));
    if (identities.size < minSites) continue;
    const examples: FootprintExample[] = [];
    const seen = new Set<string>();
    for (const i of list) {
      if (seen.has(i.identity)) continue;
      seen.add(i.identity);
      examples.push({ label: i.label, source: i.source, example: i.example });
    }
    const hasPublished = list.some((i) => i.source === "published");
    const hasGenerated = list.some((i) => i.source === "generated");
    groups.push({
      skeleton,
      noEntity: isNoEntity(skeleton),
      sites: identities.size,
      pages: list.length,
      source: hasPublished && hasGenerated ? "both" : hasPublished ? "published" : "generated",
      examples,
    });
  }
  groups.sort((a, b) => b.sites - a.sites || b.pages - a.pages || a.skeleton.localeCompare(b.skeleton));
  return groups;
}

// ─── similar (Jaccard) ───────────────────────────────────────────────────────────

/**
 * Word set for similarity: skeleton tokens minus `{x}` (two templates about DIFFERENT entities
 * being 90% alike is exactly the near-duplicate worth showing) minus pure punctuation.
 */
function similarityWords(skeleton: string): Set<string> {
  return new Set(
    skeleton.split(/\s+/).filter((tok) => tok !== "{x}" && /[\p{L}\p{N}]/u.test(tok)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Cluster the skeletons that did NOT form exact qualifying groups: pairwise Jaccard over word
 * sets ≥ SIMILARITY_THRESHOLD, joined by union-find so a chain of near-neighbours stays in one
 * cluster. Long skeletons only (same minimum-length rationale as the exact report).
 */
export function similarGroups(
  items: FootprintItem[],
  opts: GroupOptions = {},
): SimilarGroup[] {
  const minWords = Math.max(1, opts.minWords ?? MIN_SKELETON_WORDS);

  const bySkeleton = new Map<string, FootprintItem[]>();
  for (const item of items) {
    if (!item.skeleton || skeletonWordCount(item.skeleton) < minWords) continue;
    const list = bySkeleton.get(item.skeleton);
    if (list) list.push(item);
    else bySkeleton.set(item.skeleton, [item]);
  }

  // Only skeletons absent from the exact report participate (the caller passes the leftovers).
  const skeletons = [...bySkeleton.keys()];
  const words = new Map(skeletons.map((s) => [s, similarityWords(s)]));

  const parent = new Map<string, string>(skeletons.map((s) => [s, s]));
  const find = (s: string): string => {
    let root = s;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < skeletons.length; i++) {
    for (let j = i + 1; j < skeletons.length; j++) {
      const a = skeletons[i], b = skeletons[j];
      if (jaccard(words.get(a)!, words.get(b)!) >= SIMILARITY_THRESHOLD) union(a, b);
    }
  }

  const clusters = new Map<string, string[]>();
  for (const s of skeletons) {
    const root = find(s);
    const list = clusters.get(root);
    if (list) list.push(s);
    else clusters.set(root, [s]);
  }

  const out: SimilarGroup[] = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    const members = cluster.slice().sort();
    const identities = new Set<string>();
    const examples: FootprintExample[] = [];
    const seen = new Set<string>();
    let pages = 0;
    for (const s of members) {
      for (const item of bySkeleton.get(s) ?? []) {
        pages++;
        identities.add(item.identity);
        if (seen.has(item.identity)) continue;
        seen.add(item.identity);
        examples.push({ label: item.label, source: item.source, example: item.example });
      }
    }
    out.push({ skeletons: members, sites: identities.size, pages, examples });
  }
  out.sort((a, b) => b.sites - a.sites || b.pages - a.pages);
  return out;
}
