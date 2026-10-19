// Provider resolution — turns the operator's stored tokens into live clients.
//
// Tokens live in the same settings mirror every other provider key uses (localStorage key
// `seoKey_fieldlink` / `seoKey_magic369`, synced into User.seoSettings by SeoKeysSync), with
// the deployment env vars winning over them, exactly like the A-Parser credentials. The base
// URLs are fixed vendor endpoints, so unlike A-Parser there is nothing user-named to guard.

import { getUserSettings } from "@/lib/mcp/shared";
import { Magic369Client, MAGIC369_DEFAULT_BASE } from "./magic369";
import { FieldLinkClient, FIELDLINK_DEFAULT_BASE, POST_UNIT_MINOR, LINK_TIERS } from "./fieldlink";
import { PROVIDER_FIELDLINK, PROVIDER_FIELDLINK_LINKS, PROVIDER_MAGIC369, PROVIDER_MAGIC369_LINKS, type BuyProductId } from "./purchases";

const envToken = (name: string) => (process.env[name] ?? "").trim() || undefined;

export function fieldLinkEnv(): { token?: string; base: string } {
  return {
    token: envToken("OPENGSC_FIELDLINK_TOKEN"),
    base: (process.env.OPENGSC_FIELDLINK_BASE_URL ?? "").trim() || FIELDLINK_DEFAULT_BASE,
  };
}

export function magic369Env(): { token?: string; base: string } {
  return {
    token: envToken("OPENGSC_MAGIC369_TOKEN"),
    base: (process.env.OPENGSC_MAGIC369_BASE_URL ?? "").trim() || MAGIC369_DEFAULT_BASE,
  };
}

/** Client for the acting user, or null while no token is stored anywhere. Null is not an
 *  error: the buy flow simply points at the settings screen instead of quoting. */
export async function fieldLinkClientFor(userId: string): Promise<FieldLinkClient | null> {
  const env = fieldLinkEnv();
  const token = env.token ?? String((await getUserSettings(userId)).seoKey_fieldlink ?? "").trim();
  return token ? new FieldLinkClient(token, env.base) : null;
}

export async function magic369ClientFor(userId: string): Promise<Magic369Client | null> {
  const env = magic369Env();
  const token = env.token ?? String((await getUserSettings(userId)).seoKey_magic369 ?? "").trim();
  return token ? new Magic369Client(token, env.base) : null;
}

export interface MagicProviderInfo {
  id: BuyProductId;
  name: string;
  /** Balance unit for labelling sums in the UI: "cr." (FieldLink credits) or "$" (369 Links
   *  Market — its API says "tokens", but the vendor prices and tops up in US dollars 1:1). */
  unit: string;
  configured: boolean;
  balanceMinor: number | null;
  /** Current price of one placement, minor units; null when unknown. For 369Team articles this
   *  is the FIRST volume tier — larger orders are cheaper, the quote applies the real tier. */
  priceMinor: number | null;
  error: string | null;
}

/** Live balances of every provider — the buy modal picks its default provider by them. 369Team
 *  appears twice (articles and homepage links): one token, one balance, two products. */
export async function magicProviderInfos(userId: string): Promise<MagicProviderInfo[]> {
  const fieldlink = await fieldLinkClientFor(userId);
  const m369 = await magic369ClientFor(userId);

  const [fl, m] = await Promise.all([
    fieldlink
      ? fieldlink.balance()
        // A personal post price (prices.post) wins over the default; the quote stays the truth.
        .then(b => ({ configured: true, balanceMinor: b.balanceMinor as number | null, priceMinor: (Number(b.prices?.post) > 0 ? Number(b.prices?.post) : POST_UNIT_MINOR) as number | null, error: null as string | null }))
        .catch((e: Error) => ({ configured: true, balanceMinor: null, priceMinor: null, error: e.message }))
      : Promise.resolve({ configured: false, balanceMinor: null, priceMinor: null, error: null }),
    m369
      ? m369.balance()
        .then(b => ({ configured: true, balanceMinor: b.balanceMinor as number | null, priceMinor: b.priceMinor as number | null, linkPriceMinor: b.linkPriceMinor as number | null, error: null as string | null }))
        .catch((e: Error) => ({ configured: true, balanceMinor: null, priceMinor: null, linkPriceMinor: null, error: e.message }))
      : Promise.resolve({ configured: false, balanceMinor: null, priceMinor: null, linkPriceMinor: null, error: null }),
  ]);

  return [
    { id: PROVIDER_FIELDLINK, name: "FieldLink · Posts", unit: "cr.", configured: fl.configured, balanceMinor: fl.balanceMinor, priceMinor: fl.priceMinor, error: fl.error },
    { id: PROVIDER_FIELDLINK_LINKS, name: "FieldLink · Homepage links", unit: "cr.", configured: fl.configured, balanceMinor: fl.balanceMinor, priceMinor: LINK_TIERS[0].creditsMinor, error: fl.error },
    { id: PROVIDER_MAGIC369, name: "369 Links Market · Magic links", unit: "$", configured: m.configured, balanceMinor: m.balanceMinor, priceMinor: m.priceMinor, error: m.error },
    { id: PROVIDER_MAGIC369_LINKS, name: "369 Links Market · Homepage links", unit: "$", configured: m.configured, balanceMinor: m.balanceMinor, priceMinor: m.linkPriceMinor, error: m.error },
  ];
}
