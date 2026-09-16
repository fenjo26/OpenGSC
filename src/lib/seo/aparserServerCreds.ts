// The owner's A-Parser connection, resolved server-side — for the SERP Monitor collector, the
// Rank Tracker and the probe script, none of which has a browser to read localStorage from.
//
// URL: `resolveBaseUrl` (the env URL outranks a settings URL — see the SSRF note on it).
// Password: BOTH candidates (env, then settings) are probed with a real `ping` when they differ,
// and the first one A-Parser accepts wins — exactly what POST /api/aparser does for the console.
// Before this, the env password was taken blindly: after a password rotation re-tested in
// Settings, the console and the "Connected" badge were green while every SERP Monitor request
// failed with `Auth failed`. When neither answers, the env candidate is returned anyway so the
// real error still surfaces, tagged with its source (`credsTag`).
//
// The winner is cached for a minute per (url, passwords) so a 295-keyword run does not ping
// before every wave; a localhost ping is single-digit milliseconds regardless.

import { getUserSettings } from "@/lib/mcp/shared";
import { aparserPing, envPassword, resolveBaseUrl, setAparserConcurrency, type AparserCreds } from "./aparser";
import { aparserPasswordCandidates, type AparserCredSource } from "./aparserCredCandidates";

export type ServerAparserCreds = AparserCreds & { source: AparserCredSource };

const CACHE_MS = 60_000;
let cache: { key: string; at: number; source: AparserCredSource; password: string } | null = null;

/** Drop the cached winner — call after the settings mirror changes. */
export function resetAparserServerCredsCache(): void {
  cache = null;
}

/** " [creds: env]" — which password went out, never the password itself. */
export function credsTag(creds: { source?: AparserCredSource }): string {
  return creds.source ? ` [creds: ${creds.source}]` : "";
}

/** Password probing only. `null` when neither a URL nor a password is configured. */
export async function resolveAparserPassword(
  baseUrl: string, settingsPassword: string,
): Promise<{ password: string; source: AparserCredSource } | null> {
  const candidates = aparserPasswordCandidates(envPassword(), settingsPassword);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const key = `${baseUrl}\n${candidates.map(c => c.password).join("\n")}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return { password: cache.password, source: cache.source };
  }
  for (const c of candidates) {
    const pong = await aparserPing({ baseUrl, password: c.password });
    if (pong.data) {
      if (c.source !== "env") {
        console.warn("[aparser] OPENGSC_APARSER_PASSWORD is rejected by A-Parser; using the password saved in Settings. Update or remove the env var.");
      }
      cache = { key, at: Date.now(), source: c.source, password: c.password };
      return c;
    }
  }
  // Nobody answered (wrong both times, or the instance is down): not cached, so the next wave
  // re-probes; the env candidate goes out and its error reaches the UI with a [creds: env] tag.
  return candidates[0];
}

/** Owner's A-Parser connection for server-side use. Applies seoAparserConcurrency. null = not configured. */
export async function getAparserServerCreds(userId: string): Promise<ServerAparserCreds | null> {
  try {
    const settings = await getUserSettings(userId);
    // A malformed or missing URL is "not configured", not a thrown error — a half-filled
    // connection must disable the feature, not crash it.
    const base = resolveBaseUrl(String(settings.seoBaseUrl_aparser ?? ""));
    if ("problem" in base) return null;
    const picked = await resolveAparserPassword(base.url, String(settings.seoKey_aparser ?? ""));
    if (!picked) return null;

    const rawConcurrency = settings.seoAparserConcurrency;
    const concurrency = Number(rawConcurrency);
    // The limiter clamps to 1..64 itself; the empty-string guard is for `Number("") === 0`,
    // which would silently look like a real (rejected) value instead of "not set".
    if (rawConcurrency !== "" && rawConcurrency != null && Number.isFinite(concurrency)) {
      setAparserConcurrency(concurrency);
    }

    const configPreset = String(settings.seoAparserConfig ?? "").trim();
    return { baseUrl: base.url, password: picked.password, source: picked.source, ...(configPreset ? { configPreset } : {}) };
  } catch {
    return null;
  }
}
