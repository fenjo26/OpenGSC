// Donor toxicity for the site's OWN backlink profile (N2) — the pure, database-free half.
//
// The drops classifier (src/lib/drops/toxicity) is reused, not re-implemented: its marker
// dictionaries and script analysis are the shared vocabulary. What differs here is the question.
// For a drop, a casino marker is always bad news. For a live site, a casino anchor from a casino
// donor is a normal topical link — the site itself may BE the casino. That is CONTRACT.md §0.1:
// the site's `backlinkNiche` names the marker groups that are NOT toxic for it, and every
// classifier entry point in this module receives that niche explicitly. Nothing is guessed from
// the site's content at classification time — the niche is operator data, suggested from the
// last audit but applied only by hand.
//
// Signals per donor (all rows of one domainFrom share the verdict):
//   markers     — matchMarkers over pageTitle/apiSnippet, minus ownNiche groups
//   anchors     — the same marker pass over apiAnchor + checkAnchor (anchor_* codes), minus niche
//   alien script — a script the site's own zone does not use, in an anchor or in the donor title
//   structure   — sitewide low-DR junk, everything out of content, a parked donor page
//   deep check  — the same marker pass over a freshly fetched donor homepage (title + text)
//
// "unknown" is a real verdict, not a zero: no anchor, no title and no structural signal means
// there was nothing to judge, and painting that green is exactly the `null ≠ 0` trap.

import {
  isNativeScriptForZone,
  isParked,
  matchMarkers,
  scriptsOf,
  MARKERS,
} from "@/lib/drops/toxicity/markers";
import type { ScriptName } from "@/lib/drops/toxicity/types";

export type ToxLevel = "unknown" | "clean" | "suspicious" | "toxic";

/** Marker-group codes that exist at all — the chip list in the niche editor. */
export const MARKER_GROUPS: readonly string[] = MARKERS.map((g) => g.code);

/** Structural signal codes this module adds on top of the drops classifier's KNOWN_TOX_SIGNALS.
 *  Marker and anchor codes keep their drops names (`pharma`, `anchor_adult`, `alien_script`,
 *  `anchor_alien_script`); the structure of a live donor has no drops counterpart, so those
 *  codes are new and namespaced by this module. */
export const BL_STRUCT_SIGNALS = ["sitewide_low_dr", "out_of_content", "donor_parked"] as const;

/** Level thresholds, in the DEFAULT_TOXIC_AT spirit of the drops classifier. */
export const TOX_TOXIC_AT = 60;
export const TOX_SUSPICIOUS_AT = 25;

/** Weights of the structural signals (marker weights in titles/snippets come from the drops
 *  MARKERS table). Anchor weight is the group weight sharpened by +15 (clamped 20..60): for a
 *  LIVE profile the anchor is written by the donor and cannot be faked in the site's favour,
 *  so one hard spam anchor (pharma, adult, gambling_id) is already a toxic verdict on its own,
 *  while soft words (gambling_generic) stay a suspicion. */
export const TOX_WEIGHTS = {
  alienScriptTitle: 25,
  alienScriptTitleCjk: 35,
  alienScriptAnchor: 30,
  sitewideLowDr: 40,
  outOfContent: 25,
  donorParked: 45,
} as const;

export function anchorMarkerWeight(groupWeight: number): number {
  return Math.min(60, Math.max(20, Math.round(groupWeight) + 15));
}

/** Structure thresholds: DR below this with this many links is a sitewide dump; that many
 *  out-of-content links is boilerplate/footer spam rather than one editorial mistake. */
export const SITEWIDE_MAX_DR = 5;
export const SITEWIDE_MIN_LINKS = 20;
export const OUT_OF_CONTENT_MIN_LINKS = 10;

// ─── niche ─────────────────────────────────────────────────────────────────────

/**
 * Does marker-group `code` belong to the site's own niche? An element matches the code whole
 * or as a prefix up to `_`: "gambling" covers gambling_zh, gambling_id and gambling_generic,
 * "gambling_zh" covers only itself (N2 brief).
 */
export function inOwnNiche(niche: readonly string[], code: string): boolean {
  const c = String(code ?? "").toLowerCase();
  if (!c) return false;
  return niche.some((element) => {
    const el = String(element ?? "").trim().toLowerCase();
    if (!el) return false;
    return c === el || c.startsWith(`${el}_`);
  });
}

/** Parse `Site.backlinkNiche` (JSON `{ ownNiche: string[] }`). Anything unreadable is an empty
 *  niche — a broken JSON blob must not silently turn a gambling site's profile toxic. */
export function parseNiche(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { ownNiche?: unknown };
    if (Array.isArray(parsed?.ownNiche)) {
      return parsed.ownNiche.map((x) => String(x ?? "").trim()).filter(Boolean);
    }
  } catch {
    // fall through
  }
  return [];
}

/** Serialize the niche back into the column shape. */
export function serializeNiche(niche: readonly string[]): string {
  return JSON.stringify({ ownNiche: [...niche] });
}

/** Suggest a niche from any text (the caller passes the site's home title + meta description
 *  from its last audit): every marker group present in the text. A suggestion, never applied
 *  automatically — the operator sees and saves it. */
export function suggestNicheFromText(text: string): string[] {
  const found = new Set<string>();
  for (const { group } of matchMarkers(text ?? "")) found.add(group.code);
  return MARKERS.filter((g) => found.has(g.code)).map((g) => g.code);
}

// ─── donor classification ──────────────────────────────────────────────────────

/** One link of a donor, as the classifier needs it (a slice of SiteBacklink). */
export interface DonorLink {
  apiAnchor: string;
  checkAnchor: string;
  pageTitle: string;
  apiSnippet: string;
  apiDr: number | null;
  apiContent: boolean;
}

/** All links of one donor plus the classification context. */
export interface DonorInput {
  domainFrom: string;
  links: DonorLink[];
  /** Marker groups that are normal for THIS site (Site.backlinkNiche). */
  ownNiche: readonly string[];
  /** The site's own domain — the zone alien scripts are judged against. */
  siteDomain: string;
  /** Deep-check evidence when it ran: the donor homepage's title and a text fragment. */
  deepTitle?: string;
  deepText?: string;
}

export interface DonorVerdict {
  domainFrom: string;
  level: ToxLevel;
  /** 0..100 */
  score: number;
  /** Signal codes; marker/anchor codes are KNOWN_TOX_SIGNALS values, structure from BL_STRUCT_SIGNALS. */
  signals: string[];
}

function markerWeight(code: string): number {
  return MARKERS.find((g) => g.code === code)?.weight ?? 0;
}

/** Markers in anchors, minus niche groups — the twin of drops' classifyAnchors with the niche
 *  subtraction this module exists for. Weights are sharpened (anchorMarkerWeight): the donor
 *  wrote the anchor, so one hard spam phrase is evidence, not a hint. */
function anchorSignals(anchorText: string, ownNiche: readonly string[], siteDomain: string): ToxSignal[] {
  const out: ToxSignal[] = [];
  if (!anchorText.trim()) return out;
  for (const { group } of matchMarkers(anchorText)) {
    if (inOwnNiche(ownNiche, group.code)) continue; // §0.1: own niche is not toxicity
    out.push({ code: `anchor_${group.code}`, weight: anchorMarkerWeight(group.weight) });
  }
  out.push(...alienScriptSignals(anchorText, "anchor_alien_script", TOX_WEIGHTS.alienScriptAnchor, siteDomain));
  return out;
}

/** A non-latin script the site's own zone does not use. Latin is skipped everywhere: on a latin
 *  site it is native, and on a non-latin site latin anchors are the web's default, not a signal. */
function alienScriptSignals(
  text: string,
  code: string,
  weight: number,
  siteDomain: string,
  cjkWeight = weight,
): ToxSignal[] {
  const out: ToxSignal[] = [];
  const seen = new Set<string>();
  for (const script of scriptsOf(text)) {
    if (script === "latin") continue;
    if (isNativeScriptForZone(script, siteDomain)) continue;
    if (seen.has(script)) continue;
    seen.add(script);
    out.push({
      code,
      weight: script === "cjk" ? cjkWeight : weight,
      detail: script,
    });
  }
  return out;
}

interface ToxSignal {
  code: string;
  weight: number;
  detail?: string;
}

/**
 * Classify one donor for one site. The verdict covers every row of the donor — DR, content
 * placement and anchor profile are properties of the donor, and per-row splits would let a
 * 400-link sitewide dump average itself into "clean" one row at a time.
 */
export function classifyDonor(input: DonorInput): DonorVerdict {
  const ownNiche = input.ownNiche;
  const siteDomain = input.siteDomain;
  const signals: ToxSignal[] = [];
  const codes = new Set<string>();
  const add = (s: ToxSignal) => {
    signals.push(s);
    codes.add(s.code);
  };

  const anchorText = input.links
    .map((l) => `${l.apiAnchor ?? ""} ${l.checkAnchor ?? ""}`)
    .join(" \n ")
    .trim();
  // The donor's own page title: any non-empty one (rows of one donor describe the same pages,
  // and our placement check may have read a fresher title than the provider snippet).
  const title = input.links.map((l) => (l.pageTitle ?? "").trim()).find(Boolean) ?? "";
  const snippet = input.links.map((l) => (l.apiSnippet ?? "").trim()).filter(Boolean).join(" \n ");

  const hasAnchorText = !!anchorText;
  const hasPageText = !!(title || snippet || input.deepTitle || input.deepText);

  // 1. Markers in the donor's page material (title, provider snippet, deep-check fetch).
  for (const source of [`${title} ${snippet}`, `${input.deepTitle ?? ""} ${input.deepText ?? ""}`]) {
    for (const { group } of matchMarkers(source)) {
      if (inOwnNiche(ownNiche, group.code)) continue;
      add({ code: group.code, weight: markerWeight(group.code) });
    }
  }

  // 2. Anchors.
  for (const s of anchorSignals(anchorText, ownNiche, siteDomain)) add(s);

  // 3. Alien script in the donor's title (anchors were covered above).
  for (const s of alienScriptSignals(title || (input.deepTitle ?? ""), "alien_script", TOX_WEIGHTS.alienScriptTitle, siteDomain, TOX_WEIGHTS.alienScriptTitleCjk)) {
    add(s);
  }

  // 4. Structure. DR is the freshest non-null value across the donor's rows.
  const dr = input.links.reduce<number | null>(
    (acc, l) => (l.apiDr == null ? acc : Math.max(acc ?? 0, l.apiDr)),
    null,
  );
  const n = input.links.length;
  if (dr != null && dr < SITEWIDE_MAX_DR && n >= SITEWIDE_MIN_LINKS) {
    add({ code: "sitewide_low_dr", weight: TOX_WEIGHTS.sitewideLowDr, detail: `DR ${dr}, ${n} links` });
  }
  if (n >= OUT_OF_CONTENT_MIN_LINKS && input.links.every((l) => l.apiContent === false)) {
    add({ code: "out_of_content", weight: TOX_WEIGHTS.outOfContent, detail: `${n} links` });
  }
  if (isParked(title || (input.deepTitle ?? ""))) {
    add({ code: "donor_parked", weight: TOX_WEIGHTS.donorParked });
  }

  // 5. Score and level. No anchor, no page text and no structural signal → unknown: there was
  //    nothing to judge (null ≠ 0 — never a silent "clean").
  const structural = signals.filter((s) => (BL_STRUCT_SIGNALS as readonly string[]).includes(s.code));
  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  const judged = hasAnchorText || hasPageText || structural.length > 0;
  if (!judged) {
    return { domainFrom: input.domainFrom, level: "unknown", score: 0, signals: [] };
  }
  const level: ToxLevel = score >= TOX_TOXIC_AT ? "toxic" : score >= TOX_SUSPICIOUS_AT ? "suspicious" : "clean";
  return { domainFrom: input.domainFrom, level, score, signals: [...codes] };
}

// ─── profile-level over-optimisation ───────────────────────────────────────────

/**
 * Commercial tokens for the exact-anchor heuristic. Deliberately narrow: the drops lesson
 * (NAME_TOKENS) applies here too — a greedy list flags every "best pizza" blog on the internet.
 * Tokens that name a money transaction or a hard-sell word, in the languages this instance's
 * sites actually run.
 */
export const COMMERCIAL_TOKENS: readonly string[] = [
  "buy", "cheap", "cheapest", "price", "prices", "order", "ordering", "best", "sale", "discount",
  "coupon", "promo", "deal", "deals", "offer", "shop", "store", "service", "services", "repair",
  "заказать", "купить", "цена", "цены", "недорого", "дешево", "дёшево", "скидка", "акция",
  "услуги", "ремонт", "доставка", "οφελεια", // el: offer
];

/** Anchors worth counting: text an SEO would call a money keyword, not a URL/brand/navigation
 *  anchor. A naked URL or the site's own name is navigational and says nothing about stuffing. */
export function isExactCommercialAnchor(anchor: string, siteDomain: string): boolean {
  const a = (anchor ?? "").toLowerCase().trim();
  if (!a || a.length < 3) return false;
  if (/^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/.test(a)) return false; // URL or URL-ish
  const brand = siteDomain.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
  if (brand && a.includes(brand)) return false; // brand/navigational
  return COMMERCIAL_TOKENS.some((token) => new RegExp(`(^|[^\\p{L}])${token}([^\\p{L}]|$)`, "u").test(a));
}

export const OVER_OPT_THRESHOLD = 30; // % of exact commercial anchors
export const OVER_OPT_MIN_ANCHORS = 10; // below this the share means nothing

export interface OverOptResult {
  checked: number;
  exact: number;
  /** 0..100, integer; 0 when there were too few anchors to judge. */
  pct: number;
  over: boolean;
}

/** The over-optimisation banner's numbers. A PROFILE signal (brief §1): it is returned by the
 *  run and shown as a banner, and it never changes any donor's level. */
export function overOptimization(anchors: readonly string[], siteDomain: string): OverOptResult {
  const clean = anchors.map((a) => (a ?? "").trim()).filter(Boolean);
  if (clean.length < OVER_OPT_MIN_ANCHORS) {
    return { checked: clean.length, exact: 0, pct: 0, over: false };
  }
  const exact = clean.filter((a) => isExactCommercialAnchor(a, siteDomain)).length;
  const pct = Math.round((exact / clean.length) * 100);
  return { checked: clean.length, exact, pct, over: pct > OVER_OPT_THRESHOLD };
}

/** Worst-first order for level chips and donor tables. */
export const TOX_LEVEL_ORDER: Record<ToxLevel, number> = { toxic: 3, suspicious: 2, unknown: 1, clean: 0 };

export type { ScriptName };
