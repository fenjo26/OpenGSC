// Provider balance cache — the server half of the balances page and the source of truth for
// the balance_low alert. Values are the provider's OWN counters (authoritative: they include
// spend made outside this app on the same key), fetched on demand and stored in the
// ProviderBalance table; nothing here runs on a page load.
//
// Only providers with a verified balance endpoint are wired: DataForSEO (appendix/user_data),
// Ahrefs (subscription-info/limits-and-usage — which doubles as a connectivity probe: it
// answers 200 even when every data endpoint on the host is failing), OpenRouter (/api/v1/key)
// and 2index.ninja (/api/v1/balance). Providers that publish no such endpoint are invisible
// here by design — for those, the provider_down alert over the call log is the coverage.
import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { getOwnerSettings } from "@/lib/engineKeysServer";

// Loose handle: the table exists after the migration even before `prisma generate` re-runs
// (same stance as GeoAudit in the geo route).
const balances = () => (prisma as any).providerBalance;

export interface BalanceFetch {
  provider: string;
  unit: string;
  left: number | null;
  limit: number | null;
  resetAt: Date | null;
  ok: boolean;
  error?: string;
}

const timeout = (ms: number) => AbortSignal.timeout(ms);

async function fetchAhrefs(key: string): Promise<BalanceFetch> {
  const res = await fetch("https://api.ahrefs.com/v3/subscription-info/limits-and-usage", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: timeout(15_000),
  });
  if (!res.ok) return { provider: "ahrefs", unit: "units", left: null, limit: null, resetAt: null, ok: false, error: `HTTP ${res.status}` };
  const d: any = await res.json();
  const limit = Number(d?.units_limit_workspace);
  const usage = Number(d?.units_usage_workspace);
  if (!isFinite(limit) || !isFinite(usage)) return { provider: "ahrefs", unit: "units", left: null, limit: null, resetAt: null, ok: false, error: "no units fields" };
  const reset = d?.usage_reset_date ? new Date(d.usage_reset_date) : null;
  return { provider: "ahrefs", unit: "units", left: Math.max(0, limit - usage), limit, resetAt: reset && !isNaN(reset.getTime()) ? reset : null, ok: true };
}

async function fetchDataForSeo(key: string): Promise<BalanceFetch> {
  // The stored key is "login:password" — DataForSEO speaks HTTP Basic with exactly that pair.
  const res = await fetch("https://api.dataforseo.com/v3/appendix/user_data", {
    headers: { Authorization: `Basic ${Buffer.from(key).toString("base64")}`, Accept: "application/json" },
    signal: timeout(15_000),
  });
  if (!res.ok) return { provider: "dataforseo", unit: "USD", left: null, limit: null, resetAt: null, ok: false, error: `HTTP ${res.status}` };
  const d: any = await res.json();
  const money = d?.tasks?.[0]?.result?.[0]?.money;
  const left = Number(money?.balance);
  if (!isFinite(left)) return { provider: "dataforseo", unit: "USD", left: null, limit: null, resetAt: null, ok: false, error: "no money.balance" };
  return { provider: "dataforseo", unit: "USD", left, limit: null, resetAt: null, ok: true };
}

async function fetchOpenRouter(key: string): Promise<BalanceFetch> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
    signal: timeout(15_000),
  });
  if (!res.ok) return { provider: "openrouter", unit: "USD", left: null, limit: null, resetAt: null, ok: false, error: `HTTP ${res.status}` };
  const d: any = await res.json();
  const k = d?.data ?? {};
  const left = Number(k.limit_remaining);
  // No limit on the key = pay-as-you-go with nothing to run out of: report the spend rate is
  // not knowable here and let the provider's own dashboard own that question.
  if (!isFinite(left)) return { provider: "openrouter", unit: "USD", left: null, limit: null, resetAt: null, ok: true };
  const limit = Number(k.limit);
  return { provider: "openrouter", unit: "USD", left, limit: isFinite(limit) ? limit : null, resetAt: null, ok: true };
}

async function fetch2Index(token: string): Promise<BalanceFetch> {
  const res = await fetch("https://2index.ninja/api/v1/balance", {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) return { provider: "2index", unit: "pages", left: null, limit: null, resetAt: null, ok: false, error: "invalid token" };
  if (!res.ok) return { provider: "2index", unit: "pages", left: null, limit: null, resetAt: null, ok: false, error: `HTTP ${res.status}` };
  const d: any = await res.json().catch(() => ({}));
  const left = Number(d?.balance);
  return { provider: "2index", unit: "pages", left: isFinite(left) ? left : null, limit: null, resetAt: null, ok: isFinite(left) };
}

// Resolve one provider's credential from the owner's mirrored settings (same storage names the
// SeoKeysSync mirror writes) or, for 2index, the dedicated User column.
async function credentialFor(userId: string, provider: string): Promise<string | null> {
  const s = await getOwnerSettings(userId);
  if (provider === "ahrefs") {
    const key = String(s.seoKey_ahrefs ?? "").trim();
    return key || null;
  }
  if (provider === "dataforseo") {
    const key = String(s.seoKey_dataforseo ?? s.dataforseoKey ?? "").trim();
    return key || null;
  }
  if (provider === "openrouter") {
    const key = String(s.aiKey_openrouter ?? s.seoKey_openrouter ?? "").trim();
    return key || null;
  }
  if (provider === "2index") {
    const rows: any[] = await rawQuery(`SELECT "twoIndexToken" FROM "User" WHERE id = ?`, userId);
    const token = String(rows?.[0]?.twoIndexToken ?? "").trim();
    return token || null;
  }
  return null;
}

const FETCHERS: Record<string, (key: string) => Promise<BalanceFetch>> = {
  ahrefs: fetchAhrefs,
  dataforseo: fetchDataForSeo,
  openrouter: fetchOpenRouter,
  "2index": fetch2Index,
};

export const BALANCE_PROVIDERS = Object.keys(FETCHERS);

// Refresh every configured provider's row. A provider with no key configured is skipped
// silently (nothing to show, nothing to alert on); a failed fetch is stored as ok=false so
// the page can say "the check itself failed" instead of showing a stale number as fresh.
export async function refreshProviderBalances(userId: string): Promise<BalanceFetch[]> {
  const out: BalanceFetch[] = [];
  for (const provider of BALANCE_PROVIDERS) {
    const key = await credentialFor(userId, provider);
    if (!key) continue;
    let result: BalanceFetch;
    try {
      result = await FETCHERS[provider](key);
    } catch (e: any) {
      result = { provider, unit: "", left: null, limit: null, resetAt: null, ok: false, error: String(e?.message ?? e) };
    }
    try {
      await balances().upsert({
        where: { userId_provider: { userId, provider } },
        create: { userId, provider, unit: result.unit, left: result.left, limit: result.limit, resetAt: result.resetAt, ok: result.ok, error: result.error ?? null },
        update: { unit: result.unit, left: result.left, limit: result.limit, resetAt: result.resetAt, ok: result.ok, error: result.error ?? null, fetchedAt: new Date() },
      });
    } catch { /* table not migrated yet — nothing to persist, nothing to crash */ }
    out.push(result);
  }
  return out;
}

// The read side (page + alert). Never fetches: it returns the cached rows as-is, including
// failed ones, so the caller can distinguish "no key", "checked and fine" and "check failed".
export async function getProviderBalances(userId: string): Promise<any[]> {
  try {
    return await balances().findMany({ where: { userId } });
  } catch {
    return []; // table not migrated yet
  }
}
