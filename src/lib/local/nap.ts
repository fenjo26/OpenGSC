// NAP extraction and comparison (N4, brief §2). Pure HTML/text functions — the routes do the
// safeFetch, this turns one page's HTML into { name, phones, address } and diffs it against the
// profile. Kept free of Prisma so nap.test.ts runs without a database.

import { normalizeToE164, phonesMatch } from "./phone";
import type { LocalProfileData, NapDiff, NapField, NapFound } from "./types";

// ─── folding ───────────────────────────────────────────────────────────────────

/** Case-fold, drop accents and every non-letter-or-digit, for language-agnostic comparison. */
export function fold(value: string): string {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks — Greek τόνος, French accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Legal-form suffixes that are NOT a name difference: "Massage Thessaloniki IKE" ≡ "Massage Thessaloniki". */
const LEGAL_FORMS = new Set([
  "ike", "ικε", "ι κ ε", "oe", "ο ε", "llc", "ltd", "limited", "gmbh", "ag", "sa", "sarl",
  "bv", "nv", "srl", "sro", "inc", "co", "company", "ooo", "ооо", "ип", "еоод",
].map(s => fold(s)));

/** Word-level Jaccard similarity of two folded strings. */
export function jaccard(a: string, b: string): number {
  const wa = new Set(fold(a).split(" ").filter(Boolean));
  const wb = new Set(fold(b).split(" ").filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

// ─── comparison (profile ↔ found) ──────────────────────────────────────────────

/** Names agree when the folded strings are equal, or equal after legal-form words are dropped. */
export function namesMatch(expected: string, foundName: string): boolean {
  const a = fold(expected);
  const b = fold(foundName);
  if (!a || !b) return false;
  if (a === b) return true;
  return dropLegalTail(a) === dropLegalTail(b);
}

/** Drop legal forms from a folded name: single words ("ike", "llc") and 1-3-word tails
 *  ("ι κ ε") — the suffix form is what dotted Greek legal abbrevinations fold into. */
function dropLegalTail(s: string): string {
  const words = s.split(" ").filter(Boolean);
  // Single-word forms anywhere in the name (rare, but "Ltd Foo" exists).
  const noWords = words.filter(w => !LEGAL_FORMS.has(w));
  for (let k = 1; k <= 3; k++) {
    if (noWords.length > k && LEGAL_FORMS.has(noWords.slice(-k).join(" "))) {
      return noWords.slice(0, -k).join(" ");
    }
  }
  return noWords.join(" ");
}

/** Address folding: like fold(), but spaces between digits are removed first so "546 22" and
 *  "54622" compare equal — postal codes are printed both ways on the same site. */
export function foldAddress(value: string): string {
  return fold(String(value || "").replace(/(\d)\s+(?=\d)/g, "$1"));
}

/** Addresses agree on folded word Jaccard ≥ 0.7 (brief §2). */
export function addressesMatch(expected: string, foundAddress: string): boolean {
  if (!fold(expected) || !fold(foundAddress)) return false;
  const wa = new Set(foldAddress(expected).split(" ").filter(Boolean));
  const wb = new Set(foldAddress(foundAddress).split(" ").filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared) >= 0.7;
}

/** Full-line address of the profile, the way pages print it. The ISO country code is included
 *  because postalAddressLine (the JSON-LD reader) includes addressCountry — both sides must
 *  compare the same shape. */
export function profileAddress(p: Pick<LocalProfileData, "street" | "locality" | "region" | "postalCode" | "country">): string {
  return [p.street, p.locality, p.region, p.postalCode, p.country].map(s => (s || "").trim()).filter(Boolean).join(", ");
}

/** The NAP core: street + locality + postal code. Region and country spellings ("GR" vs
 *  "Greece" vs absent) are not NAP consistency — pages legitimately vary them. Kept for
 *  callers that want to display the core trio only. */
export function napAddressCore(parts: { street: string; locality: string; postalCode: string }): string {
  return [parts.street, parts.locality, parts.postalCode].map(s => (s || "").trim()).filter(Boolean).join(", ");
}

/** Compare one page's found NAP against the profile → diffs (never throws, never empty for a page). */
export function compareNapPage(p: LocalProfileData, url: string, found: NapFound | null): NapDiff[] {
  const diffs: NapDiff[] = [];
  const push = (field: NapField, expected: string, foundValue: string, ok: boolean) => {
    diffs.push({
      field,
      expected,
      found: foundValue,
      url,
      status: !foundValue ? "missing" : ok ? "match" : "differs",
    });
  };

  push("name", p.name, found?.name ?? "", found ? namesMatch(p.name, found.name) : false);
  const expectedPhone = p.phone || "";
  // Phones: the page may print several; a match on ANY of them is a match (mobile + landline).
  const pagePhones = found?.phones ?? [];
  const phoneFoundText = pagePhones.join(" · ");
  const phoneOk = expectedPhone
    ? pagePhones.some(ph => phonesMatch(expectedPhone, ph))
    : false; // no expected phone — any printed number is a profile gap, shown as "differs"
  push("phone", expectedPhone, phoneFoundText, phoneOk);
  push("address", profileAddress(p), found?.address ?? "", found ? addressesMatch(profileAddress(p), found.address) : false);
  return diffs;
}

// ─── JSON-LD ───────────────────────────────────────────────────────────────────

interface JsonMap { [k: string]: unknown }

/** Parse every <script type="application/ld+json"> block; malformed blocks are skipped, not fatal. */
export function parseJsonLdBlocks(html: string): JsonMap[] {
  const out: JsonMap[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (item && typeof item === "object") out.push(item as JsonMap);
      } else if (parsed && typeof parsed === "object") {
        out.push(parsed as JsonMap);
        // @graph is the other way multiple entities ship in one block.
        const graph = (parsed as JsonMap)["@graph"];
        if (Array.isArray(graph)) {
          for (const item of graph) if (item && typeof item === "object") out.push(item as JsonMap);
        }
      }
    } catch { /* one broken block must not sink the page */ }
  }
  return out;
}

const isObj = (v: unknown): v is JsonMap => !!v && typeof v === "object" && !Array.isArray(v);

const ADDRESS_SUBPROPS = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"];

/**
 * The page's best local-business JSON-LD node — the one NAP fields are read from. Sites mark
 * their business up as DaySpa, TaxiService, [LocalBusiness, DaySpa]… and no fixed list of types
 * can keep up, so the node is chosen by what it CARRIES: an address scores highest, then a
 * telephone, then a name. A node scoring below 2 is not a business node (a bare WebSite with a
 * name must not win over a full LocalBusiness later in the page).
 */
export function localBusinessNode(html: string): JsonMap | null {
  let best: JsonMap | null = null;
  let bestScore = 0;
  for (const node of parseJsonLdBlocks(html)) {
    if (node["@type"] == null) continue;
    let score = 0;
    const address = node.address;
    if (isObj(address) && ADDRESS_SUBPROPS.some(k => typeof address[k] === "string")) score += 3;
    if (typeof node.telephone === "string") score += 2;
    if (typeof node.name === "string" && node.name.trim()) score += 1;
    if (score > bestScore) { bestScore = score; best = node; }
  }
  return bestScore >= 2 ? best : null;
}

/** All JSON-LD nodes whose @type list contains `type` (case-insensitive; nested arrays unwound). */
export function jsonLdNodesOfType(html: string, type: string): JsonMap[] {
  const wanted = type.toLowerCase();
  return parseJsonLdBlocks(html).filter(node => {
    const t = node["@type"];
    const types = Array.isArray(t) ? t.map(String) : t != null ? [String(t)] : [];
    return types.some(x => x.toLowerCase() === wanted);
  });
}

/** Flatten a schema.org PostalAddress (or any address-ish node) into one printable line. */
export function postalAddressLine(node: unknown): string {
  if (!isObj(node)) return "";
  const parts = [
    typeof node.streetAddress === "string" ? node.streetAddress : "",
    typeof node.addressLocality === "string" ? node.addressLocality : "",
    typeof node.addressRegion === "string" ? node.addressRegion : "",
    typeof node.postalCode === "string" ? node.postalCode : "",
    typeof node.addressCountry === "string" ? node.addressCountry : "",
  ];
  return parts.map(s => s.trim()).filter(Boolean).join(", ");
}

// ─── extraction ────────────────────────────────────────────────────────────────

/** tel: links come first — a machine-readable phone beats any regex over visible text. */
export function extractTelLinks(html: string): string[] {
  const out: string[] = [];
  const re = /href=["']tel:([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeEntities(m[1]);
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/gi, " ");
}

const PHONE_RE = /\+?\d[\d\s().\-–—]{5,17}\d/g;

/**
 * Phone candidates from visible text: strip tags, then match digit runs. Deliberately greedy —
 * normalisation and dedupe happen in normalizePhoneCandidates, and postal codes are filtered by
 * the E.164 plausibility gate.
 */
export function extractPhoneTexts(html: string): string[] {
  const text = decodeEntities(String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(PHONE_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].trim();
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** tel: links first, then text matches — both normalised to E.164 with the profile country. */
export function extractPhones(html: string, country = ""): string[] {
  const out: string[] = [];
  for (const raw of [...extractTelLinks(html), ...extractPhoneTexts(html)]) {
    const norm = normalizeToE164(raw, country);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/** Business name: the local-business JSON-LD node's name first, then og:site_name, then <title>. */
export function extractBusinessName(html: string): string {
  const node = localBusinessNode(html);
  if (node && typeof node.name === "string" && node.name.trim()) return node.name.trim();
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (og) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return decodeEntities(title[1]).trim().split(/[|–—-]/)[0].trim();
  return "";
}

/** Microdata address: a window after itemprop="address", mined for the address sub-properties. */
export function extractMicrodataAddress(html: string): string {
  const at = html.search(/itemprop=["']address["']/i);
  if (at < 0) return "";
  const window = html.slice(at, at + 1200);
  const pick = (prop: string) => {
    const m = window.match(new RegExp(`itemprop=["']${prop}["'][^>]*>([^<]+)<`, "i"))
      ?? window.match(new RegExp(`content=["']([^"']+)["'][^>]*itemprop=["']${prop}["']`, "i"));
    return m ? decodeEntities(m[1]).trim() : "";
  };
  return [pick("streetAddress"), pick("addressLocality"), pick("postalCode")].filter(Boolean).join(", ");
}

/**
 * Address, best effort: JSON-LD PostalAddress → microdata → text search for the profile's own
 * street and postal code (a page mentioning neither is honestly "not found").
 */
export function extractAddress(html: string, p: Pick<LocalProfileData, "street" | "locality" | "region" | "postalCode" | "country">): { address: string; fromJsonLd: boolean } {
  const node = localBusinessNode(html);
  if (node) {
    const line = postalAddressLine(node.address);
    if (line) return { address: line, fromJsonLd: true };
  }
  const micro = extractMicrodataAddress(html);
  if (micro) return { address: micro, fromJsonLd: false };

  // Text fallback: look for the profile's street and/or postal code, then take the surrounding
  // line — the way a human reads a footer.
  const text = decodeEntities(String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
  const lines = text.split(/<[^>]+>|\n|\r|·|\|/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 300);
  const streetFold = fold(p.street || "");
  const postal = (p.postalCode || "").trim();
  for (const line of lines) {
    if (streetFold && fold(line).includes(streetFold)) return { address: line, fromJsonLd: false };
    if (postal && new RegExp(`(^|\\D)${escapeRe(postal)}(\\D|$)`).test(line) && fold(line).includes(fold(p.locality || "___never___"))) {
      return { address: line, fromJsonLd: false };
    }
  }
  return { address: "", fromJsonLd: false };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One page → NapFound. Pure; the caller owns the fetch. `profileAnchor` (the site's own
 * LocalProfile fields) is what lets the text fallback recognise "the street from the profile" —
 * without it only JSON-LD and microdata addresses are found.
 */
export function extractNap(
  html: string,
  country = "",
  profileAnchor?: Pick<LocalProfileData, "street" | "locality" | "region" | "postalCode" | "country">,
): NapFound {
  const phones = extractPhones(html, country);
  const address = extractAddress(html, profileAnchor ?? { street: "", locality: "", region: "", postalCode: "", country: "" });
  return {
    name: extractBusinessName(html),
    phones,
    phoneRaw: [...extractTelLinks(html), ...extractPhoneTexts(html)],
    address: address.address,
    jsonLdAddress: address.fromJsonLd,
  };
}

// ─── contact page discovery (brief §2) ─────────────────────────────────────────

const CONTACT_WORDS = ["contact", "kontakt", "contactus", "contact-us", "επικοινωνία", "επικοινωνια", "контакты", "about", "impressum", "where", "find-us", "findus"];

/**
 * Absolute contact-ish page URLs from the homepage HTML: a link whose path or text contains a
 * contact word (en/de/el/ru + the generic about/impressum). Deduped, ≤ 10, same origin only.
 */
export function contactPageLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 50) {
    const href = decodeEntities(m[1]).trim();
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u: URL;
    try { u = new URL(href, base); } catch { continue; }
    if (u.origin !== base.origin) continue;
    const label = fold(decodeEntities(String(m[2]).replace(/<[^>]+>/g, " ")));
    const path = fold(u.pathname);
    if (!CONTACT_WORDS.some(w => path.includes(w) || label.includes(w))) continue;
    u.hash = "";
    u.search = "";
    const clean = u.toString().replace(/\/$/, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.slice(0, 10);
}

/** Homepage URL from a site row's url/siteId — the two spellings the DB holds. */
export function homepageUrl(siteUrl: string): string {
  const raw = (siteUrl || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^sc-domain:/i.test(raw)) return `https://${raw.slice("sc-domain:".length).replace(/^\/+/, "")}`;
  return `https://${raw.replace(/^\/+/, "")}`;
}

// ─── "Fill from the site" (brief §1) ───────────────────────────────────────────

/** Partial profile harvested from the homepage's JSON-LD + meta — the user confirms before saving. */
export function fillFromSite(html: string, country = ""): Partial<LocalProfileData> {
  const out: Partial<LocalProfileData> = {};
  const name = extractBusinessName(html);
  if (name) out.name = name;

  const node = localBusinessNode(html);
  if (node) {
    if (typeof node.telephone === "string") {
      const norm = normalizeToE164(node.telephone, country);
      if (norm) out.phone = norm;
    }
    if (typeof node.email === "string" && node.email.includes("@")) out.email = node.email.trim();
    if (typeof node.priceRange === "string" && node.priceRange.trim()) out.priceRange = node.priceRange.trim();
    const t = node["@type"];
    const types = Array.isArray(t) ? t.map(String) : t != null ? [String(t)] : [];
    if (types.length) out.businessType = types[0];
    const addr = node.address;
    if (isObj(addr)) {
      if (typeof addr.streetAddress === "string") out.street = addr.streetAddress.trim();
      if (typeof addr.addressLocality === "string") out.locality = addr.addressLocality.trim();
      if (typeof addr.addressRegion === "string") out.region = addr.addressRegion.trim();
      if (typeof addr.postalCode === "string") out.postalCode = addr.postalCode.trim();
      if (typeof addr.addressCountry === "string") {
        const c = String(addr.addressCountry).trim();
        if (/^[a-zA-Z]{2}$/.test(c)) out.country = c.toUpperCase();
      }
    }
    // Geo: only from the page's own JSON-LD — no paid geocoder (brief §1).
    if (isObj(node.geo)) {
      const lat = Number(node.geo.latitude);
      const lng = Number(node.geo.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) { out.lat = lat; out.lng = lng; }
    }
    if (typeof node.sameAs === "string") out.sameAs = [node.sameAs.trim()];
    else if (Array.isArray(node.sameAs)) out.sameAs = node.sameAs.filter((s): s is string => typeof s === "string" && !!s.trim());
  }
  if (!out.phone) {
    const phones = extractPhones(html, country);
    if (phones.length) out.phone = phones[0];
  }
  return out;
}
