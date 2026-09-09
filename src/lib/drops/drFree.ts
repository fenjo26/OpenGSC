// Server-side Ahrefs Domain Rating via the free public endpoint — the drops button's path.
//
// The dashboard's /api/dr takes the key from the browser, because keys there live in
// localStorage. The drops catalogue cannot afford the same dependency: a button that silently
// returns nothing when this particular browser never typed the key reads as "DR doesn't work".
// So the key is resolved from the owner's server settings, in the same order everything
// server-side resolves keys: the free DR key slot first, then the paid Ahrefs key — an APIv3
// key is an APIv3 key, and the free endpoint accepts the paid one too.
//
// DrCache is shared with /api/dr (7-day TTL): whichever path fetched first, the other reuses.
// License: https://ahrefs.com/legal/domain-rating-license — "Domain Rating by Ahrefs"
// attribution is required wherever the number is shown.

import { rawQuery } from "@/lib/db/raw";
import { runUpsert } from "@/lib/db/upsert";
import { recordDrSnapshots } from "@/lib/seo/drHistory";
import { getOwnerSettings } from "@/lib/engineKeysServer";
import { DEFAULT_USER_AGENT } from "@/lib/security/safeFetch";

const TTL_MS = 7 * 24 * 3600 * 1000;
const FREE_CAP = 60;

async function fetchFreeDr(domain: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}&output=json`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const d = await res.json() as { domain_rating?: { domain_rating?: number } | number; dr?: number };
    const dr = Number(d?.domain_rating && typeof d.domain_rating === "object" ? d.domain_rating.domain_rating : d?.domain_rating ?? d?.dr);
    return Number.isFinite(dr) ? dr : null;
  } catch {
    return null;
  }
}

/** The free DR key, then the paid Ahrefs key (mode slots first, legacy global last). */
export async function resolveDrKey(userId: string): Promise<string> {
  const s = await getOwnerSettings(userId);
  const free = String(s.ahrefsDrApiKey || "").trim();
  if (free) return free;
  const provider = s.seoMetricsProvider === "semrush" ? "semrush" : "ahrefs";
  const mode = String(s[`seoMetricsMode_${provider}`] ?? "");
  const slot = mode === "reseller" || mode === "custom" ? `seoKey_${provider}__${mode}` : `seoKey_${provider}`;
  return String(s[slot] ?? s[`seoKey_${provider}`] ?? "").trim();
}

export interface DrResult {
  ratings: Record<string, number>;
  keyFound: boolean;
}

/**
 * DR for a batch of domains, from cache where fresh, fetched where not.
 *
 * `keyFound: false` means nothing could be fetched and nothing new will arrive — the caller
 * must say so out loud rather than show "Обновлено: 0", which reads as a broken button.
 */
export async function drForDomains(userId: string, domains: string[]): Promise<DrResult> {
  const unique = [...new Set(domains.map(d => d.trim().toLowerCase().replace(/^www\./, "")))].filter(Boolean);
  if (!unique.length) return { ratings: {}, keyFound: false };

  const ratings: Record<string, number> = {};
  let cached: Array<{ domain: string; dr: number | string; checkedAt: string }> = [];
  try {
    cached = await rawQuery(
      `SELECT domain, dr, checkedAt FROM "DrCache" WHERE domain IN (${unique.map(() => "?").join(",")})`, ...unique);
  } catch { /* table missing until prisma db push */ }
  const fresh = new Set<string>();
  for (const r of cached) {
    if (Date.now() - new Date(r.checkedAt).getTime() < TTL_MS) {
      ratings[r.domain] = Number(r.dr);
      fresh.add(r.domain);
    }
  }

  const apiKey = await resolveDrKey(userId);
  if (!apiKey) return { ratings, keyFound: false };

  const missing = unique.filter(d => !fresh.has(d)).slice(0, FREE_CAP);
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < missing.length) {
      const domain = missing[i++];
      const dr = await fetchFreeDr(domain, apiKey);
      if (dr == null) continue;
      ratings[domain] = dr;
      try {
        await runUpsert({
          table: "DrCache",
          conflict: ["domain"],
          values: { domain, dr, checkedAt: new Date().toISOString() },
          update: { dr: "set", checkedAt: "set" },
        });
        // Fresh measurement → this month's DrSnapshot row. This is the hook that makes the
        // drops catalogue accumulate its own DR history instead of renting GoAnyAPI's.
        await recordDrSnapshots([{ domain, dr, source: "ahrefs-free" }]);
      } catch { /* cache best-effort, same as /api/dr */ }
    }
  }));

  return { ratings, keyFound: true };
}
