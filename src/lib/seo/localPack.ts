// Local pack ("map pack" — the three businesses Google pins on the map) — pure helpers for
// wave-nov N3. No Prisma, no network: everything here is string/array work over a SERP answer
// that has already arrived, so it is unit-tested against fixtures without a provider.
//
// The one contract this file guards (CONTRACT.md §0.2): the pack is a SEPARATE number from the
// organic position. Nothing here ever writes into `position`; callers store `localPack`
// (1..3 | null) next to it, never inside it.

/** One business in the SERP's map pack, as a provider reported it. Only the top three. */
export interface LocalPackEntry {
  /** Place in the pack, 1..3. */
  position: number;
  /** Business name Google showed — what a human matches against. */
  title: string;
  /** The business's own site, when the pack entry links one; null = no site in the entry. */
  domain: string | null;
  address: string | null;
  /** Star rating, when reported; null = not reported (never 0). */
  rating: number | null;
}

/** How many businesses a map pack holds (Google's three-pack). */
export const PACK_PLACES = 3;

// ─── Folding and name similarity ───────────────────────────────────────────────

/**
 * Fold a business name for comparison: strip diacritics ("Masáž" → "masaz", "Θεσσαλονίκη" →
 * "θεσσαλονικη" via NFD), lowercase, collapse everything that is not a letter or digit into
 * spaces. Two spellings of one name must fold to the same string; two businesses' names must
 * not fold into each other.
 */
export function foldName(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordSet(s: string): Set<string> {
  return new Set(foldName(s).split(" ").filter((w) => w.length >= 2));
}

/** Jaccard similarity of two names' word sets: |A∩B| / |A∪B|. Empty sets never match. */
export function nameSimilarity(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Below this a similarly-spelled name is somebody else's business, not ours. */
export const NAME_MATCH_THRESHOLD = 0.6;

// ─── Matching "us" against a pack ──────────────────────────────────────────────

function foldHost(host: string): string {
  return String(host ?? "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")
    .split("/")[0].replace(/^www\./, "").replace(/\.$/, "");
}

/**
 * Is a pack entry's site OUR site? Dot boundary, `www.` ignored — the same rule `matchesSite`
 * in lib/rank.ts applies to organic results, so a subdomain of the tracked host counts and a
 * look-alike apex ("massagethess-2.gr" next to "massagethess.gr") does not.
 */
export function hostMatchesPackDomain(entryDomain: string, host: string): boolean {
  const d = foldHost(entryDomain);
  const h = foldHost(host);
  if (!d || !h) return false;
  return d === h || d.endsWith("." + h);
}

/**
 * Which pack entry (if any) is us. Domain first — a website in the entry is evidence a name
 * never has; only when no entry carries our domain does the folded-name Jaccard run, against
 * ANY of `names` (the LocalProfile business name + brand words of the host). The first entry
 * that matches wins, because the pack is ordered: place 1 is a better answer than place 3.
 *
 * Returns `{ position, title }` of the matched entry, or null = we are not in this pack.
 */
export function matchLocalPack(
  pack: readonly LocalPackEntry[],
  us: { host: string; names: readonly string[] },
): { position: number; title: string } | null {
  for (const e of pack) {
    if (e.domain && hostMatchesPackDomain(e.domain, us.host)) {
      return { position: e.position, title: e.title };
    }
  }
  for (const e of pack) {
    for (const name of us.names) {
      if (!name) continue;
      if (nameSimilarity(e.title, name) >= NAME_MATCH_THRESHOLD) {
        return { position: e.position, title: e.title };
      }
    }
  }
  return null;
}

/**
 * Brand words of a site host, for name matching when the pack entry has no website:
 * "massagethess.gr" → ["massagethess"], "thessaloniki-taxi.gr" → the label and the split
 * words. Tokens under three characters are dropped — "gr", "co" are TLD debris, and two-letter
 * fragments match everybody's name.
 */
export function brandNamesFromHost(host: string): string[] {
  const label = foldHost(host).split(".")[0] ?? "";
  const out: string[] = [];
  if (label.length >= 3) out.push(label);
  const tokens = label.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (tokens.length > 1) out.push(tokens.join(" "));
  return out;
}

// ─── Location validation (pure; the API route and the UI share these codes) ────

export type LocationProblem = "location_too_long" | "location_bad_coordinates";

export const LOCATION_MAX_LEN = 120;

/** "40.5197,22.9709" → numbers, or null when the string is not two numbers. */
export function parseCoordinates(loc: string): { lat: number; lng: number } | null {
  const m = String(loc ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * A location a tracked keyword can carry: "" (country, the default identity), a city name, or
 * "lat,lng". Validating here keeps the API route and the check honest about the same rule —
 * a "location" that is neither a name a provider can resolve nor in-range coordinates would
 * otherwise fail 20 checks in a row with provider errors nobody can read.
 */
export function validateLocation(raw: unknown): { ok: true; value: string } | { ok: false; error: LocationProblem } {
  const v = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (v === "") return { ok: true, value: "" };
  if (v.length > LOCATION_MAX_LEN) return { ok: false, error: "location_too_long" };
  if (parseCoordinates(v) === null && /^-?\d/.test(v)) {
    // Starts like a number but is not a valid coordinate pair — "40.5,999" or "40.5".
    return { ok: false, error: "location_bad_coordinates" };
  }
  return { ok: true, value: v };
}

// ─── Provider capability ───────────────────────────────────────────────────────

/**
 * Providers that can geolocate a query to a city. GoAnyAPI takes no location at all (its two
 * parameters are keyword and country) and ScrapingRobot's GoogleScraper module has no geo
 * parameter either — for those, a local keyword is refused with `location_unsupported`
 * instead of silently answered at country level: a country position stored as "position in
 * Thessaloniki" is a lie the rank history keeps forever (CONTRACT.md §0.2/§0.3).
 */
export const LOCATION_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(["serper", "dataforseo", "aparser"]);

export function supportsLocation(provider: string): boolean {
  return LOCATION_CAPABLE_PROVIDERS.has(String(provider ?? ""));
}

// ─── DataForSEO task fields ────────────────────────────────────────────────────

/**
 * How a location travels in a DataForSEO task. Coordinates go as `location_coordinate`
 * ("<lat>,<lng>,<radius-km>" — 14 km ≈ a city), a name as `location_name` in DataForSEO's own
 * "City,Region,Country" format; the user's free-text city is sent as typed, and when the API
 * does not recognise it the answer is the `location_unknown` error, not an empty SERP. Either
 * way the field REPLACES `location_code` — the API refuses a task that carries both.
 */
export function dfsLocationParams(loc: string): { location_name: string } | { location_coordinate: string } {
  const coords = parseCoordinates(loc);
  if (coords) return { location_coordinate: `${coords.lat},${coords.lng},14` };
  return { location_name: String(loc ?? "").trim() };
}

// ─── Provider answer → LocalPackEntry[] (tolerant, fixture-tested) ─────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Serper's `places` block (present when the SERP has a map pack): entries carry `position`,
 * `title`, `address`, `rating` and often `website`. Tolerant on purpose — a field Serper adds
 * or renames must cost us that field, not the whole pack.
 */
export function parseSerperPlaces(places: unknown): LocalPackEntry[] {
  if (!Array.isArray(places)) return [];
  const out: LocalPackEntry[] = [];
  for (const p of places) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const title = str(o.title ?? o.name).trim();
    if (!title) continue;
    const position = Number.isInteger(o.position) && Number(o.position) > 0 ? Number(o.position) : out.length + 1;
    const website = str(o.website ?? o.url).trim();
    out.push({
      position,
      title,
      domain: website ? (hostOf(website) || null) : null,
      address: str(o.address).trim() || null,
      rating: num(o.rating),
    });
    if (out.length >= PACK_PLACES) break;
  }
  return out;
}

/**
 * DataForSEO's SERP items of `type: "local_pack"` (Live Advanced): one item per business,
 * with `rank_absolute`, `title`, `domain`, `address` and a nested `rating.value`.
 */
export function parseDfsLocalPack(items: unknown): LocalPackEntry[] {
  if (!Array.isArray(items)) return [];
  const pack = items.filter((it) => it && typeof it === "object" && (it as Record<string, unknown>).type === "local_pack");
  const out: LocalPackEntry[] = [];
  for (const it of pack) {
    const o = it as Record<string, unknown>;
    const title = str(o.title).trim();
    if (!title) continue;
    const rank = Number(o.rank_absolute ?? o.rank_group);
    out.push({
      position: Number.isInteger(rank) && rank > 0 ? rank : out.length + 1,
      title,
      domain: str(o.domain).trim().toLowerCase().replace(/^www\./, "") || null,
      address: str(o.address).trim() || null,
      rating: num((o.rating as Record<string, unknown> | null | undefined)?.value ?? o.rating),
    });
    if (out.length >= PACK_PLACES) break;
  }
  return out;
}

/**
 * A-Parser's SE::Google row: a `local` (or `localResults`) array when the build parses the
 * block at all. The live-probe fixtures carry no such key, so the shape is unknown — entries
 * are read tolerantly (objects with title/link, or bare strings) and an absent key means the
 * provider did not say, which is `hasPack: null`, not "no pack".
 */
export function parseAparserLocal(row: unknown): { pack: LocalPackEntry[]; hasPack: boolean | null } {
  const r = row && typeof row === "object" ? (row as Record<string, unknown>) : null;
  const raw = r ? (Array.isArray(r.local) ? r.local : (Array.isArray(r.localResults) ? r.localResults : null)) : null;
  if (raw === null) return { pack: [], hasPack: null };
  if (raw.length === 0) return { pack: [], hasPack: false };
  const out: LocalPackEntry[] = [];
  for (const e of raw) {
    if (typeof e === "string") {
      const title = e.trim();
      if (title) out.push({ position: out.length + 1, title, domain: null, address: null, rating: null });
    } else if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const title = str(o.title ?? o.anchor ?? o.name).trim();
      if (!title) continue;
      const link = str(o.link ?? o.url).trim();
      out.push({
        position: out.length + 1,
        title,
        domain: link ? (hostOf(link) || null) : null,
        address: str(o.address).trim() || null,
        rating: num(o.rating),
      });
    }
    if (out.length >= PACK_PLACES) break;
  }
  return { pack: out, hasPack: true };
}
