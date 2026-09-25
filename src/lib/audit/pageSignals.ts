import { parseHreflangHead, type HreflangEntry } from "./hreflang";

const strip = (value: string) => value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (value: string) => value
  .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ");

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (key === "meta" || key === "link" || key === "html" || key === "script") continue;
    result[key] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function metaValues(head: string, key: string): string[] {
  const normalized = key.toLowerCase();
  const values: string[] = [];
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if ((attrs.name || attrs.property || attrs["http-equiv"] || "").toLowerCase() === normalized) {
      values.push(attrs.content ?? "");
    }
  }
  return values;
}

function linkValue(head: string, rel: string): string | null {
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const rels = (attrs.rel || "").toLowerCase().split(/\s+/);
    if (rels.includes(rel)) return attrs.href ?? "";
  }
  return null;
}

function structuredNodes(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(structuredNodes);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, any>;
  return [object, ...structuredNodes(object["@graph"]), ...structuredNodes(object.mainEntity)];
}

export interface AuditHtmlSignals {
  title: string;
  metaDesc: string;
  robots: string;
  canonical: string | null;
  h1Count: number;
  /** Text of the first H1, ≤ 200 chars — the other half of the main-query alignment check. */
  h1Text: string;
  hrefs: string[];
  imagesNoAlt: number;
  /** Images without both width and height (attributes or style) — layout shift risk. */
  imagesNoDimensions: number;
  wordCount: number;
  spaMarker: boolean;
  hasLargeScript: boolean;
  viewportPresent: boolean;
  /** Viewport exists AND allows responsive width and zoom. */
  viewportResponsive: boolean;
  /** Raw content of the viewport meta — evidence for viewport_not_responsive. */
  viewportContent: string;
  htmlLang: string;
  /** <link rel="alternate" hreflang> entries from the head; header/sitemap sources merge in the crawler. */
  hreflang: HreflangEntry[];
  jsonLdCount: number;
  jsonLdInvalid: number;
  organizationSchemaIncomplete: boolean;
  openGraphMissing: string[];
  twitterCardIncomplete: boolean;
  twitterCardMissing: string[];
  mixedContentUrls: string[];
}

export function extractAuditHtml(html: string): AuditHtmlSignals {
  const head = html.slice(0, 200_000);
  const title = decode(strip(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
  const metaDesc = metaValues(head, "description")[0] ?? "";
  const robots = [...metaValues(head, "robots"), ...metaValues(head, "googlebot")].join(", ").toLowerCase();
  const canonical = linkValue(head, "canonical");
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const h1Text = decode(strip(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "")).slice(0, 200);

  const hrefs: string[] = [];
  for (const match of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) hrefs.push(decode(match[1]));

  const imageTags = html.match(/<img\s[^>]*>/gi) ?? [];
  const imagesNoAlt = imageTags.filter(tag => {
    const alt = attributes(tag).alt;
    return alt === undefined || !alt.trim();
  }).length;
  const imagesNoDimensions = imageTags.filter(tag => {
    const attrs = attributes(tag);
    const src = (attrs.src || "").trim();
    if (/^data:/i.test(src)) return false; // inline data-URI icons are exempt
    const width = dimensionOf(attrs.width) ?? styleDimension(attrs.style, "width");
    const height = dimensionOf(attrs.height) ?? styleDimension(attrs.style, "height");
    if (width != null && height != null) return false; // both axes reserved — no shift risk
    // A small explicitly-sized SVG is an icon, not content: exempting it keeps icon sets
    // (which usually carry only one attribute) from flooding the finding.
    const svg = /\.svg(\?|#|$)/i.test(src) || /^data:image\/svg/i.test(src);
    const known = width ?? height;
    if (svg && known != null && known < 32) return false;
    return true;
  }).length;

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  const wordCount = strip(body).split(/\s+/).filter(word => word.length > 1).length;
  const spaMarker = /\bid=["']?(root|__next|__nuxt|app)["']?/i.test(html) || /data-reactroot|data-react-helmet/i.test(html);
  const hasLargeScript = (html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [])
    .reduce((sum, tag) => sum + tag.length, 0) > 50_000;

  const viewportContent = metaValues(head, "viewport").find(value => value.trim().length > 0) ?? "";
  const viewportPresent = viewportContent.length > 0;
  const viewportResponsive = viewportIsResponsive(viewportContent);
  const htmlTag = head.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const htmlLang = attributes(htmlTag).lang?.trim() ?? "";

  let jsonLdCount = 0;
  let jsonLdInvalid = 0;
  const nodes: Record<string, any>[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = attributes(`<script ${match[1]}>`);
    if ((attrs.type || "").toLowerCase().split(";")[0].trim() !== "application/ld+json") continue;
    jsonLdCount++;
    try {
      nodes.push(...structuredNodes(JSON.parse(match[2].trim())));
    } catch { jsonLdInvalid++; }
  }
  const organizationNodes = nodes.filter(node => {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return types.some(type => type === "Organization" || type === "Person");
  });
  const organizationSchemaIncomplete = organizationNodes.some(node =>
    !String(node.name ?? "").trim() || !String(node.url ?? "").trim() ||
    !(Array.isArray(node.sameAs) ? node.sameAs.length : String(node.sameAs ?? "").trim()),
  );

  const openGraphMissing = ["og:title", "og:description", "og:image"]
    .filter(key => !metaValues(head, key).some(value => value.trim()));
  const twitterKeys = ["twitter:card", "twitter:title", "twitter:description", "twitter:image"];
  const twitterValues = twitterKeys.map(key => metaValues(head, key));
  // Which tags are missing, not merely that some are: "twitter:card, twitter:image" is a task,
  // "incomplete" is a riddle. Only reported when the site clearly meant to have a card at all —
  // a page with no Twitter tags whatsoever is a choice, not an oversight.
  const twitterCardMissing = twitterValues.some(values => values.length > 0)
    ? twitterKeys.filter((_, index) => !twitterValues[index].some(value => value.trim()))
    : [];
  const twitterCardIncomplete = twitterCardMissing.length > 0;

  const mixedContentUrls = new Set<string>();
  for (const tag of html.match(/<(?:img|script|iframe|source|video|audio|link|form)\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const resource = attrs.src || attrs.href || attrs.action || "";
    if (/^http:\/\//i.test(resource)) mixedContentUrls.add(resource);
  }

  return {
    title, metaDesc, robots, canonical, h1Count, h1Text, hrefs, imagesNoAlt, imagesNoDimensions, wordCount,
    spaMarker, hasLargeScript, viewportPresent, viewportResponsive, viewportContent, htmlLang, hreflang: parseHreflangHead(html),
    jsonLdCount, jsonLdInvalid,
    organizationSchemaIncomplete, openGraphMissing, twitterCardIncomplete, twitterCardMissing,
    mixedContentUrls: [...mixedContentUrls].slice(0, 20),
  };
}

// ─── dimension parsing for the layout-shift image check ────────────────────────

/** Numeric value of a width/height attribute ("640", "640px", "50%"); null when absent or non-numeric. */
function dimensionOf(value: string | undefined): number | null {
  if (value == null) return null;
  const match = value.trim().match(/^([\d.]+)\s*(px)?$/i);
  return match ? parseFloat(match[1]) : null;
}

/** Numeric px value of `width:`/`height:` inside a style attribute; percentages reserve nothing reliably. */
function styleDimension(style: string | undefined, property: "width" | "height"): number | null {
  if (!style) return null;
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([\\d.]+)\\s*px`, "i"));
  return match ? parseFloat(match[1]) : null;
}

/**
 * A viewport meta that is actually mobile-friendly: it must map to the device width and must
 * not block zoom. `width=device-width` (else the page renders at ~980 px and pinches), and
 * neither `user-scalable=no` nor `maximum-scale < 2` — Google treats zoom-blocking as an
 * accessibility failure and has ignored the directive in Chrome since 2016, so the markup
 * only ever hurts screen-reader and low-vision users.
 */
export function viewportIsResponsive(content: string): boolean {
  const directives = new Map<string, string>();
  for (const part of content.split(",")) {
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    const value = (eq === -1 ? "" : part.slice(eq + 1)).trim().toLowerCase();
    if (key) directives.set(key, value);
  }
  const widths = (directives.get("width") ?? "").split(",").map(s => s.trim());
  if (!widths.includes("device-width")) return false;
  const scalable = directives.get("user-scalable");
  if (scalable === "no" || scalable === "0") return false;
  const maxScale = parseFloat(directives.get("maximum-scale") ?? "");
  if (Number.isFinite(maxScale) && maxScale < 2) return false;
  return true;
}

export function robotsDirectivesConflict(value: string): boolean {
  const has = (directive: string) => new RegExp(`(^|[\\s,;:])${directive}(?=$|[\\s,;])`, "i").test(value);
  return (has("index") && has("noindex")) || (has("follow") && has("nofollow"));
}

export function missingSecurityHeaders(headers: Record<string, string>, isHttps: boolean): string[] {
  const csp = headers["content-security-policy"] ?? "";
  const missing: string[] = [];
  if (!csp) missing.push("Content-Security-Policy");
  if (!headers["x-content-type-options"]?.toLowerCase().includes("nosniff")) missing.push("X-Content-Type-Options");
  if (!headers["referrer-policy"]) missing.push("Referrer-Policy");
  if (!headers["x-frame-options"] && !/frame-ancestors/i.test(csp)) missing.push("frame protection");
  if (isHttps && !headers["strict-transport-security"]) missing.push("Strict-Transport-Security");
  return missing;
}
