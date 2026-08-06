// Which search market a site belongs to.
//
// Every keyword number in this app is bought per country and cached under `(keyword, country,
// provider)`. That makes the market a correctness property, not a preference: research a Bosnian
// site as `us` and the answer is not merely less useful, it is filed where the Bosnian view will
// never look for it — so the money is spent and the screen still shows an em dash.
//
// Hence the one rule this module exists to enforce: **an unknown market resolves to null, never
// to a default.** Callers must handle null by asking, not by assuming.

/**
 * ccTLDs that name a country unambiguously.
 *
 * Deliberately not exhaustive and deliberately not clever. `.gr` is Greece; `.io`, `.co`, `.ai`,
 * `.tv`, `.me` and friends are sold worldwide as generic names and say nothing about audience —
 * `.me` in particular is Montenegro's ccTLD and is almost never used for Montenegro, so it is
 * absent here on purpose. Only entries that are right far more often than wrong belong in this
 * table; everything else is left to the human.
 */
const CCTLD_MARKET: Record<string, string> = {
  gr: "gr", fr: "fr", de: "de", es: "es", it: "it", pt: "pt", nl: "nl", be: "be",
  pl: "pl", cz: "cz", sk: "sk", hu: "hu", ro: "ro", bg: "bg", hr: "hr", rs: "rs",
  ba: "ba", si: "si", mk: "mk", al: "al", ua: "ua", ru: "ru", by: "by", kz: "kz",
  se: "se", no: "no", dk: "dk", fi: "fi", ie: "ie", at: "at", ch: "ch",
  uk: "gb", ca: "ca", au: "au", nz: "nz", jp: "jp", kr: "kr", cn: "cn", in: "in",
  br: "br", mx: "mx", ar: "ar", cl: "cl", tr: "tr", il: "il", za: "za", eg: "eg",
  ae: "ae", sg: "sg", my: "my", th: "th", vn: "vn", id: "id", ph: "ph",
};

/** The last dot-segment of a hostname, lowercased. `"sc-domain:foo.co.uk"` → `"uk"`. */
export function tldOf(urlOrDomain: string): string {
  const raw = String(urlOrDomain || "")
    .replace(/^sc-domain:/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./i, "")
    .toLowerCase()
    .trim();
  const parts = raw.split(".").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** The market a domain implies on its own, or null when its TLD is generic. */
export function marketFromDomain(urlOrDomain: string): string | null {
  return CCTLD_MARKET[tldOf(urlOrDomain)] ?? null;
}

export interface SiteMarketInput {
  url?: string | null;
  siteId?: string | null;
  market?: string | null;
}

/**
 * The resolution chain, in the only order that is safe:
 *
 *   1. what the human set on the site — always wins, including over a contradicting ccTLD,
 *      because an English-language `.gr` site targeting the UK is a real thing;
 *   2. what the ccTLD says, when it says anything;
 *   3. null — "ask, do not guess".
 */
export function marketFor(site: SiteMarketInput): string | null {
  const explicit = (site.market || "").trim().toLowerCase();
  if (explicit) return explicit;
  return marketFromDomain(site.url || site.siteId || "");
}

/** True when the site has no market and none can be inferred — the case the UI must surface. */
export function marketIsUnknown(site: SiteMarketInput): boolean {
  return marketFor(site) === null;
}
