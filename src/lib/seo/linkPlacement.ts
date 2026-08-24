/**
 * Placement link parser — pure functions over an already-fetched donor page.
 *
 * Behavioral reference: derived from izzipizzy/backlink-finder (MIT),
 * https://github.com/izzipizzy/backlink-finder — the browser-like handling of
 * nested <a> tags, <base href> resolution, the rel flag set and the encoding
 * cascade are a TypeScript port of that CLI's parser.
 *
 * No network, no database, no DOM: fetching, retries and concurrency belong to
 * the placement runner. Every function takes the owned-domain list as an
 * argument — nothing here assumes which domains are "ours".
 *
 * The parser is a hand-rolled tokenizer, deliberately not a regex over <a> tags:
 * anchors, rel values, image alts, <base href> and nested <a> closing all need
 * tag-scoped state that a flat regex cannot keep (see docs/tasks/T2-placement-core.md).
 */

import type { PlacementHit, RelFlags } from "./backlinkTypes";

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Canonicalize anything a user or an HTML page may present as "a domain":
 * scheme, path, query, fragment, userinfo and port are stripped, a leading
 * "www." and trailing dots removed, IDN converted to punycode so that
 * "сайт.рф" and "xn--80aswg.xn--p1ai" produce the same key.
 * Returns null for anything that cannot be a trackable hostname: empty input,
 * malformed labels, localhost, bare or numeric IPs, dotless names.
 */
export function canonicalizeDomain(input: string): string | null {
  let host = (input ?? "").trim().toLowerCase();
  if (!host) return null;
  try {
    if (host.includes("//")) {
      // A URL: let the parser drop scheme/userinfo/port and punycode the host.
      host = new URL(host).hostname;
    } else {
      // Bare-ish host with optional debris: "mysite.com/path?x#y", "user@host".
      host = host.split("/")[0].split("?")[0].split("#")[0].split("@").pop() ?? "";
      if (host.startsWith("[") && host.includes("]")) host = host.slice(1, host.indexOf("]"));
    }
  } catch {
    return null;
  }
  if ((host.match(/:/g) ?? []).length >= 2) return null; // bare IPv6 literal — not a domain we track
  host = host.split(":")[0].replace(/\.+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host) return null;
  try {
    host = new URL(`http://${host}/`).hostname; // unicode host comes back punycoded
  } catch {
    return null;
  }
  if (!host) return null;
  if (IPV4_RE.test(host)) return null;
  const labels = host.split(".");
  if (labels.every((label) => /^\d+$/.test(label))) return null; // "1.2.3.4.5" and friends
  if (labels.length < 2) return null; // dotless ("localhost", "intranet")
  if (!labels.every((label) => LABEL_RE.test(label))) return null; // "a..com", "-bad.com", "bad-.com"
  return host;
}

/** Longest owned domain (already canonical) that `canonicalHost` equals or is a subdomain of. */
function matchCanonical(canonicalHost: string, ownedCanonical: string[]): string | null {
  let best: string | null = null;
  for (const domain of ownedCanonical) {
    if (canonicalHost === domain || canonicalHost.endsWith("." + domain)) {
      if (best === null || domain.length > best.length) best = domain;
    }
  }
  return best;
}

/**
 * Match a link host against the owned-domain list. Subdomains count as owned;
 * when several configured domains match, the most specific one wins
 * ("shop.mysite.com" for a host under it when both it and "mysite.com" are
 * configured). Matching is label-boundary only: "notmysite.com" never matches
 * "mysite.com". Both sides are canonicalized, so callers may pass raw input.
 */
export function matchOwnedDomain(host: string, owned: string[]): string | null {
  const canonicalHost = canonicalizeDomain(host);
  if (!canonicalHost) return null;
  const ownedCanonical: string[] = [];
  for (const candidate of owned) {
    const canonical = canonicalizeDomain(candidate);
    if (canonical) ownedCanonical.push(canonical);
  }
  return matchCanonical(canonicalHost, ownedCanonical);
}

// ---------------------------------------------------------------------------
// rel
// ---------------------------------------------------------------------------

/**
 * Parse rel into independent flags. Any whitespace separates tokens, case is
 * irrelevant. `dofollow` is true only when none of nofollow/sponsored/ugc is
 * set — rel="sponsored" passes no weight even though "nofollow" is absent.
 */
export function parseRel(rel: string | null | undefined): RelFlags {
  const raw = (rel ?? "").trim();
  const tokens = new Set(raw.toLowerCase().split(/\s+/));
  const nofollow = tokens.has("nofollow");
  const sponsored = tokens.has("sponsored");
  const ugc = tokens.has("ugc");
  return { raw, nofollow, sponsored, ugc, dofollow: !(nofollow || sponsored || ugc) };
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

const META_CHARSET_RE = /<meta[^>]+charset=["']?\s*([a-z0-9_.:+-]+)/i;
const XML_DECL_RE = /^\s*<\?xml[^>]*?encoding=["']([a-z0-9_.:+-]+)["']/i;
const HEAD_SCAN_BYTES = 4096;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return false;
  return true;
}

/** WHATWG TextDecoder has no UTF-32, so BOM-tagged UTF-32 is decoded by hand. */
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = "";
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4) out += String.fromCodePoint(view.getUint32(i, littleEndian));
  return out;
}

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null; // unknown label or invalid byte sequence — try the next candidate
  }
}

function decodeReplacing(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  }
}

function asAscii(bytes: Uint8Array): string {
  let out = "";
  const chunk = 2048;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

/**
 * Decode a response body to text. Priority: BOM (UTF-8/16/32) → charset from
 * the Content-Type header → <meta charset> / <?xml encoding?> in the first
 * ~4 KB → strict UTF-8 → windows-1251 → windows-1252.
 *
 * CP1251 sits before CP1252 in the final fallback (a deliberate deviation
 * from the reference CLI, which ends at cp1252): Russian-segment donor sites
 * regularly serve CP1251 with no BOM and no declared charset, and every
 * CP1251 byte string that fails strict UTF-8 is far more likely to be
 * Cyrillic than anything CP1252-specific. ASCII text decodes identically in
 * all of these encodings, so only high-byte content is affected at all.
 */
export function decodeBody(buf: ArrayBuffer, contentTypeHeader: string): string {
  const bytes = new Uint8Array(buf);

  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return decodeReplacing(bytes.subarray(3), "utf-8");
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00])) return decodeUtf32(bytes.subarray(4), true); // must precede UTF-16LE
  if (startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) return decodeUtf32(bytes.subarray(4), false);
  if (startsWith(bytes, [0xff, 0xfe])) return decodeReplacing(bytes.subarray(2), "utf-16le");
  if (startsWith(bytes, [0xfe, 0xff])) return decodeReplacing(bytes.subarray(2), "utf-16be");

  const candidates: string[] = [];
  const header = (contentTypeHeader ?? "").trim().toLowerCase();
  const headerCharset = header.match(/charset\s*=\s*"?([a-z0-9_.:+-]+)"?/);
  if (headerCharset) candidates.push(headerCharset[1]);
  else if (header && !header.includes("/")) candidates.push(header); // bare label like "windows-1251"

  const head = asAscii(bytes.subarray(0, HEAD_SCAN_BYTES));
  const meta = head.match(META_CHARSET_RE);
  if (meta) candidates.push(meta[1]);
  const xml = head.match(XML_DECL_RE);
  if (xml) candidates.push(xml[1]);
  candidates.push("utf-8", "windows-1251", "windows-1252");

  for (const label of candidates) {
    if (!label) continue;
    const decoded = tryDecode(bytes, label);
    if (decoded !== null) return decoded;
  }
  return decodeReplacing(bytes, "utf-8");
}

// ---------------------------------------------------------------------------
// HTML tokenizer
// ---------------------------------------------------------------------------

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)(\/?)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Named entities HTML authors actually put into anchors and hrefs; numeric
// references cover the rest. Not the full HTML5 table — exotic names survive
// as-is rather than pulling one in.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  deg: "°", middot: "·", bull: "•", dagger: "†", sect: "§", para: "¶",
  plusmn: "±", times: "×", divide: "÷", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾",
  euro: "€", pound: "£", yen: "¥", cent: "¢", rub: "₽",
};

function fromCodePointSafe(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[a-zA-Z][a-zA-Z0-9]*;)/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return fromCodePointSafe(parseInt(body.slice(2).replace(/;$/, ""), 16), match);
    if (body.startsWith("#")) return fromCodePointSafe(parseInt(body.slice(1).replace(/;$/, ""), 10), match);
    const named = NAMED_ENTITIES[body.slice(0, -1).toLowerCase()];
    return named ?? match;
  });
}

interface AnchorDraft {
  href: string;
  relRaw: string;
  text: string;
  hasImg: boolean;
}

interface TokenizeResult {
  anchors: AnchorDraft[];
  /** Raw <base href> value from <head> if present, unresolved. */
  baseHref: string | null;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (name in attrs) continue; // first occurrence wins, like a browser
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Single-pass tokenizer. Keeps only the state a link extractor needs:
 * the currently-open <a>, the CDATA element (<script>/<style>) whose raw
 * content must not be parsed as markup, and the first <base href> inside
 * <head> (a <base> after </head> or <body> is ignored, as in browsers).
 * Nested <a> is invalid HTML — an opening <a> closes the previous one, so
 * text never leaks from one link into another.
 */
function tokenize(html: string): TokenizeResult {
  const anchors: AnchorDraft[] = [];
  let current: AnchorDraft | null = null;
  let baseHref: string | null = null;
  let skipTag: string | null = null; // "script" | "style" while inside their CDATA content
  let inHead = true; // implicit head until </head> or <body>

  const appendData = (text: string): void => {
    if (!skipTag && current) current.text += text;
  };

  const handleTag = (closing: boolean, tag: string, attrSource: string, selfClosing: boolean): void => {
    if (tag === "script" || tag === "style") {
      // Browsers treat their content as CDATA: nothing inside is markup, and
      // only the matching close tag ends it (a JS string with "<a href=...>"
      // must not become a hit).
      if (closing) {
        if (skipTag === tag) skipTag = null;
      } else if (!selfClosing) {
        skipTag = tag;
      }
      return;
    }
    if (skipTag) return; // any other tag inside script/style is plain text
    if (closing) {
      if (tag === "a") current = null;
      else if (tag === "head") inHead = false;
      return;
    }
    if (tag === "a") {
      current = null; // an opening <a> always ends the previous one
      const attrs = parseAttrs(attrSource);
      const href = (attrs.href ?? "").trim();
      if (!href) return;
      current = { href, relRaw: (attrs.rel ?? "").trim(), text: "", hasImg: false };
      anchors.push(current);
      return; // a trailing "/" does not self-close <a> in HTML browsers
    }
    if (tag === "base") {
      if (inHead && baseHref === null) {
        const href = parseAttrs(attrSource).href?.trim();
        if (href) baseHref = href;
      }
      return;
    }
    if (tag === "img") {
      if (current) {
        const alt = parseAttrs(attrSource).alt?.trim();
        if (alt) current.text += " " + alt;
        current.hasImg = true;
      }
      return;
    }
    if (tag === "head") inHead = true;
    else if (tag === "body") inHead = false;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      appendData(html.slice(i));
      break;
    }
    if (lt > i) appendData(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const match = TAG_RE.exec(html);
    if (!match || match.index !== lt) {
      appendData("<"); // stray "<" is text, e.g. "a < b"
      i = lt + 1;
      continue;
    }
    handleTag(match[1] === "/", match[2].toLowerCase(), match[3] ?? "", match[4] === "/");
    i = lt + match[0].length;

    if (skipTag) {
      // Inside script/style CDATA: jump straight to its close tag; an
      // unterminated one swallows the rest of the document, as in a browser.
      const closeRe = new RegExp(`</${skipTag}(?=[\\s/>])`, "gi");
      closeRe.lastIndex = i;
      const close = closeRe.exec(html);
      if (!close) break;
      i = close.index; // the main loop will parse "</script>" and clear skipTag
    }
  }
  return { anchors, baseHref };
}

// ---------------------------------------------------------------------------
// Public extraction API
// ---------------------------------------------------------------------------

function safeUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/**
 * First <base href> from <head>, resolved against the URL that actually
 * answered. Pages without a usable <base> get `finalUrl` back — callers use
 * the return value as the resolution base unconditionally.
 */
export function extractBaseHref(html: string, finalUrl: string): string {
  const { baseHref } = tokenize(html);
  if (!baseHref) return finalUrl;
  return safeUrl(baseHref, finalUrl)?.toString() ?? finalUrl;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Find every link on a donor page pointing at one of `ownedDomains`.
 *
 * Relative hrefs resolve against the page that actually answered
 * (`finalUrl`, i.e. after redirects), honoring <base href>; only http/https
 * targets are kept (mailto:, tel:, javascript:, data: and in-page "#frag"
 * anchors are skipped); hits are deduplicated per page by the
 * (linkUrl, anchor, rel.raw) triple — the same target with a different
 * anchor stays a separate row. `sourceUrl` in every hit is `opts.sourceUrl`
 * when given, else `finalUrl`.
 */
export function findPlacements(
  html: string,
  finalUrl: string,
  ownedDomains: string[],
  opts?: { sourceUrl?: string },
): PlacementHit[] {
  const { anchors, baseHref } = tokenize(html);
  const base = baseHref ? (safeUrl(baseHref, finalUrl)?.toString() ?? finalUrl) : finalUrl;

  const ownedCanonical: string[] = [];
  for (const candidate of ownedDomains) {
    const canonical = canonicalizeDomain(candidate);
    if (canonical) ownedCanonical.push(canonical);
  }
  const hostCache = new Map<string, string | null>();

  const seen = new Set<string>();
  const hits: PlacementHit[] = [];
  for (const anchor of anchors) {
    if (anchor.href.startsWith("#")) continue;
    const absolute = safeUrl(anchor.href, base);
    if (!absolute) continue;
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;

    let canonicalHost = hostCache.get(absolute.hostname);
    if (canonicalHost === undefined) {
      canonicalHost = canonicalizeDomain(absolute.hostname);
      hostCache.set(absolute.hostname, canonicalHost);
    }
    if (!canonicalHost) continue;
    const matched = matchCanonical(canonicalHost, ownedCanonical);
    if (!matched) continue;

    // Entities decode on the assembled text: a data chunk boundary may split
    // "&amp;" in half, so per-chunk decoding is not enough.
    const text = collapseWhitespace(decodeEntities(anchor.text)).slice(0, 200);
    const rel = parseRel(anchor.relRaw);
    const key = `${absolute.toString()}\n${text}\n${rel.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    hits.push({
      sourceUrl: opts?.sourceUrl ?? finalUrl,
      finalUrl,
      matchedDomain: matched,
      linkUrl: absolute.toString(),
      anchor: text,
      isImage: anchor.hasImg,
      rel,
    });
  }
  return hits;
}
