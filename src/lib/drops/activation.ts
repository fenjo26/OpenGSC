// Pure helpers for the activation of acquired drops. No server imports, no database —
// the same file is safe to use from routes, the store and the client panel.
// Contract: docs/tasks/drops-activation/CONTRACT.md.

export type ActivationStage = "new" | "harvesting" | "ready" | "live" | "paused";

export const ACTIVATION_STAGES: readonly ActivationStage[] = [
  "new", "harvesting", "ready", "live", "paused",
];

/// A doorway counts as "confirmed crawled by Google" at this many hits over the last
/// DOORWAY_WINDOW_DAYS days. 1000/30d selects the three domains Google actually visits
/// in today's network; a literal >0 would select 10 of 13, including domains Google
/// touched 4–7 times in a month. The list itself is never stored — it is recomputed
/// from IndexerDailyStat on every run (see eligibleDoorways).
export const GOOGLE_CRAWL_MIN_HITS = 1000;
export const DOORWAY_WINDOW_DAYS = 30;

/// IndexNow accepts up to 10 000 URLs per request.
export const INDEXNOW_BATCH = 10_000;

/// Whole days between UTC midnights. The local-calendar version in wayback.ts
/// (daysBetween) drifted a day whenever the server's timezone differed from the
/// viewer's — the exact case this function exists to not repeat.
export function utcMidnightDaysBetween(a: Date, b: Date): number {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((day(b) - day(a)) / 86_400_000);
}

const stripWww = (host: string) => host.replace(/^www\./, "");

function parseHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

/**
 * Normalize one harvested URL against the asset host. Returns null for anything that is
 * not http(s), not on the host or its www twin, or malformed — the caller drops it.
 * The fragment is stripped (it never identifies a resource), the query is kept.
 */
export function normalizeLegacyUrl(raw: string, host: string): string | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  const asset = stripWww(host.trim().toLowerCase());
  if (!asset || stripWww(u.hostname.toLowerCase()) !== asset) return null;
  u.hash = "";
  return u.toString();
}

/**
 * THE footprint rule of the activation wave: the indexer network links to donor pages
 * only, never to the asset. A donor on the asset's own host (or subdomain, www
 * included) is exactly the "дорвей → наш домен" edge that must not exist.
 */
export function isDonorAllowed(assetDomain: string, donorUrl: string): boolean {
  const u = parseHttpUrl(donorUrl);
  if (!u) return false;
  const asset = stripWww(assetDomain.trim().toLowerCase());
  if (!asset) return false;
  const donor = stripWww(u.hostname.toLowerCase());
  return donor !== asset && !donor.endsWith("." + asset);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A valid urlset sitemap from the stored legacy URLs. */
export function buildSitemapXml(urls: string[], opts?: { lastmod?: Date }): string {
  const lastmod = opts?.lastmod ? `    <lastmod>${opts.lastmod.toISOString()}</lastmod>\n` : "";
  const items = urls
    .map(u => `  <url>\n    <loc>${escapeXml(u)}</loc>\n${lastmod}  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
}

/** Disallows nothing, points at the sitemap. */
export function buildRobotsTxt(sitemapUrl: string): string {
  return `User-agent: *\nDisallow:\n\nSitemap: ${sitemapUrl}\n`;
}

/** Body of the IndexNow key file served at /{key}.txt — just the key. */
export function indexnowKeyFile(key: string): string {
  return key;
}

/**
 * Ordered nginx locations for the activation bundle. The three files MUST be served
 * before the catch-all 301: after it, robots.txt and the key file redirect away and
 * IndexNow rejects the push silently — the #1 "everything looks done, nothing happens"
 * cause of this pipeline.
 */
export const NGINX_SNIPPET = `# ── drops-activation bundle ──────────────────────────────────────────────
# These locations MUST stay ABOVE the catch-all 301. Below it the files redirect
# away and IndexNow rejects the key file silently.
location = /robots.txt    { root /srv/activation/<host>; }
location = /sitemap.xml   { root /srv/activation/<host>; }
location ~ ^/[0-9a-f]{32}\\.txt$ { root /srv/activation/<host>; }
# ── existing catch-all 301 stays below this line ──────────────────────────
`;
