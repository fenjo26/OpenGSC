import type { CSSProperties } from "react";

// The partner wall of the "Support Developer" view: rendered compactly (logo tiles
// only) in the FeedbackModal and in full, with descriptions, on the /partners page.
// To add a partner: drop the logo into public/partners/ and add a `partners<Id>`
// description key to every src/locales/*.json. tileBg must contrast with the logo
// fills: light-filled logos (Pay2.House) need the dark tile, dark logos on white
// (Cloaking.House) need "#ffffff" — otherwise they vanish on light theme / dark tile.
type PartnerEntry<Id extends string = string> = {
  id: Id;
  name: string;
  href: string;
  logo: string;
  tileBg: string;
  imgStyle: CSSProperties;
  /** Translation key of a running promo badge; omit when the partner has none. */
  promo?: "partnersPromoMarket369";
};

// 369 Links Market leads the wall while their top-up bonus promo runs (user's call,
// 2026-10-22); everyone else keeps the historical join order.
const PARTNERS = [
  {
    id: "Market369",
    name: "369 Links Market",
    href: "https://t.me/marketplace369_bot?start=ref_58bsvidx",
    logo: "/partners/369market-logo.png",
    tileBg: "#000000",
    imgStyle: { maxHeight: "40px" } as CSSProperties,
    promo: "partnersPromoMarket369",
  },
  {
    id: "Pay2house",
    name: "Pay2.House",
    href: "https://pay2.house/p/kc9oevv0?utm_source=opengsc",
    logo: "/partners/pay2house-logo.svg",
    tileBg: "#0b0e16",
    imgStyle: { maxWidth: "78px", maxHeight: "18px" } as CSSProperties,
  },
  {
    id: "Groupbuyseo",
    name: "GroupBuySEO",
    href: "https://my.groupbuyseo.org/register?affiliate_key=8ino4XJTwJ7EJooF67JUOt2tmbcFk1",
    logo: "/partners/groupbuyseo-logo.svg",
    tileBg: "#0b0e16",
    imgStyle: { maxHeight: "30px" } as CSSProperties,
  },
  {
    id: "Cloakinghouse",
    name: "Cloaking.House",
    href: "https://cloaking.house/?utm_source=opengsc",
    logo: "/partners/cloakinghouse-logo.png",
    tileBg: "#ffffff",
    imgStyle: { maxHeight: "30px" } as CSSProperties,
  },
  {
    id: "Helodata",
    name: "Helodata",
    href: "https://helodata.com?ref=ruslan1",
    logo: "/partners/helodata-logo.png",
    tileBg: "#ffffff",
    imgStyle: { maxHeight: "32px" } as CSSProperties,
  },
  {
    id: "Accsly",
    name: "Accsly.io",
    href: "https://accsly.io/?utm_source=opengsc&utm_medium=referral",
    logo: "/partners/accsly-logo.svg",
    tileBg: "#ffffff",
    imgStyle: { maxHeight: "30px" } as CSSProperties,
  },
  {
    id: "Orbitra",
    name: "Orbitra.link",
    href: "https://orbitra.link/?utm_source=opengsc",
    logo: "/partners/orbitra-logo.svg",
    tileBg: "#ffffff",
    imgStyle: { maxHeight: "28px" } as CSSProperties,
  },
  {
    id: "Novproxy",
    name: "Novproxy",
    href: "https://novproxy.com?kwd=tt-orb",
    logo: "/partners/novproxy-logo.svg",
    tileBg: "#ffffff",
    imgStyle: { maxWidth: "84px", maxHeight: "18px" } as CSSProperties,
  },
  {
    id: "Fieldlink",
    name: "FieldLink",
    href: "https://seoboost-root.info/r/flt_oW6P5bnPM5JTkU44PxbVxFWBUF4e8MBRFDy0kG17t5Y",
    logo: "/partners/fieldlink-logo.svg",
    tileBg: "#07110c",
    imgStyle: { maxHeight: "32px" } as CSSProperties,
  },
  {
    id: "Tradeproxy",
    name: "TradeProxy",
    href: "https://tradeproxy.net/?utm_source=opengsc",
    logo: "/partners/tradeproxy-logo.png",
    tileBg: "#0b0e16",
    imgStyle: { maxHeight: "30px" } as CSSProperties,
  },
  {
    id: "Proxy1024",
    name: "1024proxy",
    href: "https://1024proxy.com/?kwd=channel-fj",
    logo: "/partners/1024proxy-logo.svg",
    tileBg: "#ffffff",
    imgStyle: { maxWidth: "84px", maxHeight: "24px" } as CSSProperties,
  },
  {
    id: "Ipfoxy",
    name: "IPFoxy",
    href: "https://www.ipfoxy.com/?r=lk_OpenGSC",
    logo: "/partners/ipfoxy-logo.png",
    tileBg: "#ffffff",
    imgStyle: { maxWidth: "84px", maxHeight: "22px" } as CSSProperties,
  },
  {
    id: "9http",
    name: "9HTTP",
    href: "https://www.9http.com?ref=opengsc",
    logo: "/partners/9http-logo.png",
    tileBg: "#ffffff",
    imgStyle: { maxWidth: "84px", maxHeight: "30px" } as CSSProperties,
  },
  {
    id: "Sk5data",
    name: "sk5data",
    href: "https://www.sk5data.com?ref=opengsc",
    logo: "/partners/sk5data-logo.png",
    tileBg: "#ffffff",
    imgStyle: { maxWidth: "84px", maxHeight: "30px" } as CSSProperties,
  },
] as const satisfies readonly PartnerEntry[];

export type PartnerId = (typeof PARTNERS)[number]["id"];

// Widened to a uniform shape: plain `as const` leaves a union where partners without a
// promo simply lack the property, and `p.promo` would not type-check at the render sites.
// The annotation keeps the id literals (so `partners${p.id}` stays a valid translation
// key) while making the optional promo present on every entry.
export const SUPPORT_PARTNERS: readonly PartnerEntry<PartnerId>[] = PARTNERS;

// Donation address of the "Support Developer" view — shared by the modal and /partners
// so the two surfaces can never drift apart.
export const USDT_ADDRESS = "TN7v2NArTXd5J2eMuGFpXmgzAFsoZpWcZu";
