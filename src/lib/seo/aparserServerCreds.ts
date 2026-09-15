// SERP Monitor — the owner's A-Parser connection, resolved server-side.
//
// The collector, the scheduler and the probe script run without a browser, so the credential
// cannot arrive from localStorage the way the SEO Tools keys do. The resolution mirrors what
// /api/aparser does for its own calls, minus the interactive probing: the deployment env pair
// wins over the owner's stored settings, because a server-side fetch of a URL typed into a
// browser is the shape of an SSRF target (see the long comment on `resolveBaseUrl` — this
// module is not the place that quietly opts out of that rule). `null` means "not configured",
// which callers turn into a refusal before any keyword is spent, not a per-keyword failure.

import { getUserSettings } from "@/lib/mcp/shared";
import { envPassword, resolveBaseUrl, setAparserConcurrency, type AparserCreds } from "./aparser";

/** Owner's A-Parser connection for server-side use: env wins over settings, like /api/aparser. Applies seoAparserConcurrency. null = not configured. */
export async function getAparserServerCreds(userId: string): Promise<AparserCreds | null> {
  try {
    const settings = await getUserSettings(userId);
    // env-first is inside resolveBaseUrl; a malformed or missing URL is "not configured",
    // not a thrown error — a half-filled connection must disable the feature, not crash it.
    const base = resolveBaseUrl(String(settings.seoBaseUrl_aparser ?? ""));
    if ("problem" in base) return null;
    const password = envPassword() || String(settings.seoKey_aparser ?? "").trim();
    if (!password) return null;

    const rawConcurrency = settings.seoAparserConcurrency;
    const concurrency = Number(rawConcurrency);
    // The limiter clamps to 1..64 itself; the empty-string guard is for `Number("") === 0`,
    // which would silently look like a real (rejected) value instead of "not set".
    if (rawConcurrency !== "" && rawConcurrency != null && Number.isFinite(concurrency)) {
      setAparserConcurrency(concurrency);
    }

    const configPreset = String(settings.seoAparserConfig ?? "").trim();
    return { baseUrl: base.url, password, ...(configPreset ? { configPreset } : {}) };
  } catch {
    return null;
  }
}
