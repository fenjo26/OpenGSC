/**
 * Identity signals a site leaks in its own HTML and DNS.
 *
 * The premise: a private network is cheap to build and expensive to hide. Domains get new
 * registrars, new hosting and new templates, but the same person keeps reusing one analytics
 * property, one tag container, one AdSense publisher id, one nameserver pair — because those are
 * the things that are annoying to duplicate. Collected here, stored per scan, and compared across
 * scans, they answer the question no single-site checker can: who else does this belong to?
 *
 * Pure string extraction, no network, no database — so it is unit-testable and cannot be the thing
 * that makes a scan hang.
 */

export interface Fingerprints {
  ga4: string[];
  ua: string[];
  gtm: string[];
  adsense: string[];
  metrica: string[];
  facebookPixel: string[];
  hotjar: string[];
  clarity: string[];
  copyright: string | null;
}

function unique(values: string[], max = 6): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))].slice(0, max);
}

function matchAll(html: string, pattern: RegExp): string[] {
  return [...html.matchAll(pattern)].map(m => m[1]).filter(Boolean);
}

export function extractFingerprints(html: string): Fingerprints {
  return {
    // G-XXXXXXX appears in gtag config calls and in the loader URL.
    ga4: unique(matchAll(html, /\b(G-[A-Z0-9]{6,12})\b/g)),
    // Legacy Universal Analytics ids still identify old networks built before 2023.
    ua: unique(matchAll(html, /\b(UA-\d{4,10}-\d{1,4})\b/g)),
    gtm: unique(matchAll(html, /\b(GTM-[A-Z0-9]{4,10})\b/g)),
    adsense: unique(matchAll(html, /\b(ca-pub-\d{10,20})\b/g)),
    // Yandex Metrica: ym(NNNNNN, "init") or the counter URL.
    metrica: unique([
      ...matchAll(html, /ym\(\s*(\d{6,10})\s*,/g),
      ...matchAll(html, /mc\.yandex\.ru\/watch\/(\d{6,10})/g),
    ]),
    facebookPixel: unique(matchAll(html, /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g)),
    hotjar: unique(matchAll(html, /hjid\s*[:=]\s*(\d{5,10})/g)),
    clarity: unique(matchAll(html, /clarity\.ms\/tag\/([a-z0-9]{8,14})/gi)),
    // A footer line repeated verbatim across domains is weaker than an analytics id but survives
    // a template reskin, and it is free to collect.
    copyright: (html.match(/(?:©|&copy;|Copyright)\s*([^<\n]{0,80})/i)?.[1] ?? "").trim().slice(0, 80) || null,
  };
}

/** Flat, searchable form: `kind:value`, which is what cross-scan matching compares. */
export function flattenFingerprints(fp: Fingerprints, extra: { ns?: string[]; ips?: string[] } = {}): string[] {
  const out: string[] = [];
  const push = (kind: string, values: string[]) => values.forEach(value => out.push(`${kind}:${value.toLowerCase()}`));
  push("ga4", fp.ga4);
  push("ua", fp.ua);
  push("gtm", fp.gtm);
  push("adsense", fp.adsense);
  push("metrica", fp.metrica);
  push("pixel", fp.facebookPixel);
  push("hotjar", fp.hotjar);
  push("clarity", fp.clarity);
  push("ns", extra.ns ?? []);
  push("ip", extra.ips ?? []);
  return [...new Set(out)];
}

/**
 * How much a shared signal actually means.
 *
 * An analytics or ads account is billed to one person, so sharing one is close to proof of common
 * ownership. A nameserver pair is shared by every customer of a host, and an IP by every site on a
 * shared server, so those are hints at best — reported, but never as a conclusion.
 */
export function fingerprintStrength(key: string): "strong" | "weak" {
  return /^(ga4|ua|gtm|adsense|metrica|pixel|hotjar|clarity):/.test(key) ? "strong" : "weak";
}

export function describeFingerprint(key: string): string {
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  const label: Record<string, string> = {
    ga4: "Google Analytics 4", ua: "Universal Analytics", gtm: "Google Tag Manager",
    adsense: "AdSense", metrica: "Yandex Metrica", pixel: "Meta Pixel",
    hotjar: "Hotjar", clarity: "Microsoft Clarity", ns: "Nameserver", ip: "IP address",
  };
  return `${label[kind] ?? kind} ${value}`;
}
