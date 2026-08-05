
import { rawQuery } from "@/lib/db/raw";// Server-side mirror of resolveEngineKey (src/lib/engineKeys.ts). The browser normally holds
// the Bing/Yandex key and passes it per-request, but that doesn't work for guests opening a
// share link (they don't have the owner's localStorage). Since SeoKeysSync backs those keys
// up to User.seoSettings, the server can resolve the right key for a site the same way the
// client does — honouring the per-site account selection.
type Engine = "bing" | "yandex";

export function resolveEngineKeyFromSettings(settings: Record<string, any>, engine: Engine, siteId: string): string {
  const s = settings || {};
  const globalKey = (s[`seoKey_${engine}`] || "").trim();
  let accounts: { id: string; key: string }[] = [];
  try { accounts = JSON.parse(s[`seoKey_${engine}_accounts_list`] || "[]"); } catch { accounts = []; }
  const sel = s[`seoKey_${engine}_account_select_${siteId}`] || "";

  if (sel === "custom") return (s[`seoKey_${engine}_${siteId}`] || accounts[0]?.key || globalKey || "").trim();
  if (sel) {
    const acc = accounts.find(a => a.id === sel);
    if (acc?.key) return acc.key.trim();
  }
  return (accounts[0]?.key || globalKey || "").trim();
}

// The owner's full saved settings snapshot (read once, then resolve many sites in-memory).
export async function getOwnerSettings(ownerUserId: string): Promise<Record<string, any>> {
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, ownerUserId);
    return rows?.[0]?.seoSettings ? JSON.parse(rows[0].seoSettings) : {};
  } catch {
    return {};
  }
}

// Reads the owner's saved settings and resolves the engine key for one of their sites.
export async function getOwnerEngineKey(ownerUserId: string, engine: Engine, siteId: string): Promise<string> {
  return resolveEngineKeyFromSettings(await getOwnerSettings(ownerUserId), engine, siteId);
}

// Every key/token configured for an engine (all connected accounts + the legacy global),
// deduped — used to enumerate the engine's OWN verified sites across all accounts.
export function listEngineKeys(settings: Record<string, any>, engine: Engine): string[] {
  const out: string[] = [];
  try { for (const a of JSON.parse(settings[`seoKey_${engine}_accounts_list`] || "[]")) if (a?.key) out.push(String(a.key).trim()); } catch { /* ignore */ }
  const g = (settings[`seoKey_${engine}`] || "").trim();
  if (g) out.push(g);
  return [...new Set(out.filter(Boolean))];
}
