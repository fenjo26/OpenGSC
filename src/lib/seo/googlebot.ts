// Googlebot View — core logic for the SEO Tools module.
//
// Goal: "see" a page the way Google's crawler sees it and surface differences between what
// is served to Googlebot vs a normal browser — i.e. cloaking, hidden redirects, PBN tricks.
//
// Honest technical model (see docs/GOOGLEBOT-VIEW-SPEC.md): we CANNOT source requests from
// Google's IP ranges (those belong to Google). What we do — and what every external tool does —
// is spoof the Googlebot User-Agent and diff the responses. This catches UA-based cloaking
// (the common kind). IP-based cloaking is invisible to any external tool.
//
// No third-party HTML deps — pure regex extraction, same convention as scrape.ts.

import { createHash } from "crypto";
import { safeFetch, type SafeFetchResponse } from "@/lib/security/safeFetch";

// ─── User agents ──────────────────────────────────────────────────────────────
export const UA = {
  // Googlebot Smartphone — Google's primary crawler since mobile-first indexing.
  gbMobile:
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  gbDesktop:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Googlebot/2.1; +http://www.google.com/bot.html",
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
} as const;

export type UaKey = keyof typeof UA;

const MAX_HOPS = 20;
const FETCH_TIMEOUT = 15000;
const MAX_BODY = 2_000_000; // 2 MB cap when reading body
const MAX_HTML_RETURN = 500_000; // cap raw HTML sent back to the client
const MAX_TEXT_RETURN = 40_000; // cap extracted text sent back to the client

// ─── Types ──────────────────────────────────────────────────────────────────
export interface Hop {
  url: string;
  status: number;
  location?: string; // resolved Location target (http redirect) or JS/meta target
  redirectType?: "http" | "meta-refresh" | "js";
  setCookie?: boolean;
}

export interface SeoSignals {
  canonicalHtml?: string; // <link rel="canonical">
  htmlLang?: string; // <html lang="...">
  metaRobots?: string; // <meta name="robots">
  hreflang: { lang: string; href: string }[];
  title: string;
  metaDescription?: string;
  h1?: string;
  jsRedirects: string[]; // meta-refresh / window.location targets found in HTML
  indexable: boolean;
  indexableReasons: string[];
}

export interface ViewResult {
  ua: string;
  ok: boolean;
  rendered?: boolean; // true = JS-executed render via Firecrawl (not a raw fetch)
  blocked?: boolean; // 403/429 — site rejects a fake bot
  hops: Hop[];
  finalUrl: string;
  finalStatus: number;
  headers: {
    xRobotsTag?: string;
    canonicalHeader?: string; // rel=canonical from Link header
    contentType?: string;
    vary?: string;
    cacheControl?: string;
    server?: string;
  };
  signals: SeoSignals;
  bodyHash: string;
  wordCount: number;
  bodyText: string; // extracted visible text (capped) — for the content viewer / word diff
  htmlRaw: string; // raw HTML as delivered (capped) — for the rendered preview / source view
  screenshot?: string; // Firecrawl screenshot URL (rendered views only) — visual "how it looks"
  antiBot?: string; // "cloudflare" | "captcha" | ... — an anti-bot wall was hit, content is not the real page
  error?: string;
}

export interface CloakingDiff {
  verdict: "clean" | "suspicious" | "cloaking" | "unknown";
  score: number;
  flags: string[];
}

export interface WaybackSnapshot {
  available: boolean;
  url?: string; // archived snapshot URL
  timestamp?: string; // YYYYMMDDhhmmss
}

export interface AntiBotInfo {
  blocked: boolean; // the raw fetch hit an anti-bot wall (Cloudflare challenge, captcha…)
  provider?: string; // "cloudflare" | "captcha" | ...
  bypassed: boolean; // did a Firecrawl render get past it and retrieve real content?
}

export interface AnalyzeResult {
  url: string;
  views: ViewResult[];
  diff: CloakingDiff;
  renderedDiff?: CloakingDiff; // separate verdict for the JS-rendered views
  wayback?: WaybackSnapshot | null;
  antiBot?: AntiBotInfo | null;
}

// Detect an anti-bot interstitial (Cloudflare "Just a moment…", captcha, etc.). When this fires,
// the fetched HTML is NOT the real page — it's a challenge wall — so a plain fetch can't see the
// cloaked content. The way past it is a headless render (Firecrawl) that solves/renders the wall.
export function detectAntiBot(status: number, html: string, server?: string | null): string | undefined {
  const s = (server || "").toLowerCase();
  const h = (html || "").slice(0, 6000).toLowerCase();
  const cfSignals = s.includes("cloudflare") || h.includes("__cf_chl") || h.includes("cf-chl") || h.includes("challenge-platform") || h.includes("cf-browser-verification");
  const challengeText = h.includes("just a moment") || h.includes("enable javascript and cookies") || h.includes("checking your browser") || h.includes("attention required") || h.includes("verify you are human");
  if ((cfSignals || status === 403 || status === 503) && challengeText) return "cloudflare";
  if (h.includes("hcaptcha") || h.includes("g-recaptcha") || h.includes("recaptcha/api")) return "captcha";
  if (status === 403 && (h.includes("access denied") || h.includes("you have been blocked"))) return "access_denied";
  return undefined;
}

// ─── HTML helpers (mirror scrape.ts) ─────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? decodeEntities(m[1].trim()) : undefined;
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// ─── HTML signal extraction ──────────────────────────────────────────────────
export function parseSeoSignals(url: string, html: string): SeoSignals {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";

  const descTag = html.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0];
  const metaDescription = descTag ? attr(descTag, "content") : undefined;

  const robotsTag = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i)?.[0];
  const metaRobots = robotsTag ? attr(robotsTag, "content") : undefined;

  // canonical: <link rel="canonical" href="...">
  let canonicalHtml: string | undefined;
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const hreflang: { lang: string; href: string }[] = [];
  for (const tag of linkTags) {
    const rel = (attr(tag, "rel") || "").toLowerCase();
    const href = attr(tag, "href");
    if (!href) continue;
    if (rel === "canonical" && !canonicalHtml) canonicalHtml = resolveUrl(url, href);
    if (rel === "alternate") {
      const lang = attr(tag, "hreflang");
      if (lang) hreflang.push({ lang, href: resolveUrl(url, href) });
    }
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1Match ? stripTags(h1Match[1]) : undefined;

  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0];
  const htmlLang = htmlTag ? attr(htmlTag, "lang") : undefined;

  // Client-side redirects
  const jsRedirects: string[] = [];
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/i)?.[0];
  if (metaRefresh) {
    const content = attr(metaRefresh, "content") || "";
    const urlPart = content.match(/url\s*=\s*(.+)$/i)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (urlPart) jsRedirects.push(resolveUrl(url, urlPart));
  }
  const jsLoc = [...html.matchAll(/(?:window\.location(?:\.href)?|location\.href|location\.replace\s*\()\s*=?\s*["']([^"']+)["']/gi)];
  for (const m of jsLoc) jsRedirects.push(resolveUrl(url, m[1]));

  const bodyText = stripTags(html);
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  // Indexability
  const indexableReasons: string[] = [];
  if (metaRobots && /noindex/i.test(metaRobots)) indexableReasons.push(`meta robots: ${metaRobots}`);
  const indexable = indexableReasons.length === 0;

  return { canonicalHtml, htmlLang, metaRobots, hreflang, title, metaDescription, h1, jsRedirects, indexable, indexableReasons };
}

// Parse rel=canonical out of a Link: header (RFC 8288)
function canonicalFromLinkHeader(link?: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    if (/rel\s*=\s*"?canonical"?/i.test(part)) {
      const m = part.match(/<([^>]+)>/);
      if (m) return m[1].trim();
    }
  }
  return undefined;
}

// ─── Redirect chain follower ─────────────────────────────────────────────────
// Manual follow (redirect: "manual") so we record every hop and which UA triggered it.
export async function followChain(startUrl: string, ua: UaKey, opts?: { referer?: boolean }): Promise<ViewResult> {
  const hops: Hop[] = [];
  let current = startUrl;
  let lastRes: SafeFetchResponse | null = null;
  let html = "";

  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      const headers: Record<string, string> = {
        "User-Agent": UA[ua],
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      };
      if (opts?.referer) headers["Referer"] = "https://www.google.com/";

      const res = await safeFetch(current, {
        headers,
        redirect: "manual",
        timeoutMs: FETCH_TIMEOUT,
        maxBytes: 5 * 1024 * 1024,
      });
      lastRes = res;
      const setCookie = res.headers.has("set-cookie");

      // HTTP redirect
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const loc = resolveUrl(current, res.headers.get("location")!);
        hops.push({ url: current, status: res.status, location: loc, redirectType: "http", setCookie });
        if (hops.some((h, idx) => idx < hops.length - 1 && h.url === loc)) {
          // loop guard
          hops.push({ url: loc, status: 0, redirectType: "http", location: "loop_detected" });
          break;
        }
        current = loc;
        continue;
      }

      // Terminal response — read body (capped), look for client-side redirect
      const ct = res.headers.get("content-type") || "";
      if (/text\/html|application\/xhtml/i.test(ct)) {
        html = (await res.text()).slice(0, MAX_BODY);
      } else {
        html = "";
      }

      const signals = parseSeoSignals(current, html);

      // Client-side redirect → record as a hop and stop (we don't chase JS here)
      if (signals.jsRedirects.length && res.status === 200) {
        const target = signals.jsRedirects[0];
        const type = /<meta[^>]+http-equiv=["']refresh["']/i.test(html) ? "meta-refresh" : "js";
        hops.push({ url: current, status: res.status, location: target, redirectType: type, setCookie });
      } else {
        hops.push({ url: current, status: res.status, setCookie });
      }

      const bodyText = stripTags(html);
      const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
      const antiBot = detectAntiBot(res.status, html, res.headers.get("server"));

      return {
        ua,
        ok: res.ok && !antiBot,
        blocked: res.status === 403 || res.status === 429 || !!antiBot,
        antiBot,
        hops,
        finalUrl: current,
        finalStatus: res.status,
        headers: {
          xRobotsTag: res.headers.get("x-robots-tag") || undefined,
          canonicalHeader: canonicalFromLinkHeader(res.headers.get("link")),
          contentType: ct || undefined,
          vary: res.headers.get("vary") || undefined,
          cacheControl: res.headers.get("cache-control") || undefined,
          server: res.headers.get("server") || undefined,
        },
        signals: {
          ...signals,
          indexable: signals.indexable && !/noindex|none/i.test(res.headers.get("x-robots-tag") || ""),
          indexableReasons: [
            ...signals.indexableReasons,
            ...(/noindex|none/i.test(res.headers.get("x-robots-tag") || "") ? [`X-Robots-Tag: ${res.headers.get("x-robots-tag")}`] : []),
          ],
        },
        bodyHash: createHash("sha1").update(bodyText).digest("hex"),
        wordCount,
        bodyText: bodyText.slice(0, MAX_TEXT_RETURN),
        htmlRaw: html.slice(0, MAX_HTML_RETURN),
      };
    }

    // Ran out of hops
    return blankView(ua, current, lastRes?.status ?? 0, hops, "too_many_redirects");
  } catch (e: any) {
    return blankView(ua, current, 0, hops, e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e));
  }
}

function blankView(ua: string, url: string, status: number, hops: Hop[], error: string): ViewResult {
  return {
    ua, ok: false, hops, finalUrl: url, finalStatus: status,
    headers: {},
    signals: { hreflang: [], title: "", jsRedirects: [], indexable: false, indexableReasons: [error] },
    bodyHash: "", wordCount: 0, bodyText: "", htmlRaw: "", error,
  };
}

// ─── Cloaking diff (Googlebot vs browser) ────────────────────────────────────
export function diffViews(gb: ViewResult, browser: ViewResult): CloakingDiff {
  let score = 0;
  const flags: string[] = [];
  const add = (pts: number, flag: string) => { score += pts; flags.push(flag); };

  const gbHost = safeHost(gb.finalUrl);
  const brHost = safeHost(browser.finalUrl);

  if (gb.ok && browser.ok) {
    if (gbHost && brHost && gbHost !== brHost) add(50, "Разные финальные хосты — редирект только для одного User-Agent");
    if (gb.finalStatus !== browser.finalStatus) add(40, `Разный код ответа: Googlebot ${gb.finalStatus} vs браузер ${browser.finalStatus}`);
    const gbCanon = gb.signals.canonicalHtml, brCanon = browser.signals.canonicalHtml;
    if (gbCanon && brCanon && gbCanon !== brCanon) add(30, "Подмена canonical между ботом и браузером");
    if (gb.signals.indexable !== browser.signals.indexable) add(30, "Различие индексируемости (noindex для одного из UA)");
    const wc1 = gb.wordCount, wc2 = browser.wordCount;
    if (wc1 && wc2 && Math.abs(wc1 - wc2) / Math.max(wc1, wc2) > 0.4) add(25, `Существенно разный объём контента: ${wc1} vs ${wc2} слов`);
    if (gb.bodyHash && browser.bodyHash && gb.bodyHash !== browser.bodyHash && gb.finalStatus === browser.finalStatus && gbHost === brHost) add(15, "Контент страницы отличается при одинаковом URL и статусе");
    const gbJs = gb.signals.jsRedirects.length > 0, brJs = browser.signals.jsRedirects.length > 0;
    if (gbJs !== brJs) add(25, "JS-редирект присутствует только для одного User-Agent");
  }

  if (gb.blocked && browser.ok) add(20, "Сайт блокирует поддельного Googlebot (вероятно, reverse-DNS проверка)");

  const verdict = score >= 50 ? "cloaking" : score >= 20 ? "suspicious" : "clean";
  return { verdict, score: Math.min(score, 100), flags };
}

function safeHost(u: string): string {
  try { return new URL(u).host.toLowerCase(); } catch { return ""; }
}

// ─── JS render via Firecrawl ─────────────────────────────────────────────────
// Raw fetch (followChain) doesn't run JavaScript, so it misses JS-based cloaking — where the
// server sends identical HTML to everyone and the swap happens in the browser via JS. Firecrawl
// renders the page in a headless browser with the User-Agent we pass, so we can diff the
// *rendered* DOM (Googlebot-UA vs browser-UA) and catch that class of cloaking.
export async function renderWithFirecrawl(url: string, uaKey: UaKey, label: string, firecrawlKey: string): Promise<ViewResult> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        // rawHtml = markup the server actually delivered (reveals server-side UA cloaking, e.g. a
        // static SEO article served only to Googlebot). html = post-render DOM. screenshot = visual.
        formats: ["rawHtml", "html", "screenshot"],
        onlyMainContent: false,
        mobile: uaKey === "gbMobile",
        headers: { "User-Agent": UA[uaKey] },
        // "auto" starts cheap and escalates to a stealth residential proxy when it detects an
        // anti-bot wall (Cloudflare) — this is what lets us past "Just a moment…".
        proxy: "auto",
        waitFor: 3500,
        blockAds: true,
        timeout: 55000,
      }),
      signal: AbortSignal.timeout(70000),
    });
    if (!res.ok) throw new Error(`firecrawl ${res.status}`);
    const data = await res.json();
    // Prefer the served rawHtml (best for catching server-side cloaking); fall back to rendered html.
    const rawHtml: string = data?.data?.rawHtml ?? "";
    const renderedHtml: string = data?.data?.html ?? "";
    const html = rawHtml || renderedHtml;
    const screenshot: string | undefined = data?.data?.screenshot || undefined;
    if (!html && !screenshot) throw new Error("empty_render");
    const signals = parseSeoSignals(url, html);
    const bodyText = stripTags(html);
    const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
    const antiBot = detectAntiBot(200, html);
    return {
      ua: label, ok: !antiBot && !!html, rendered: true,
      blocked: !!antiBot, antiBot,
      hops: [{ url, status: 200 }],
      finalUrl: url, finalStatus: 200,
      headers: {},
      signals,
      bodyHash: createHash("sha1").update(bodyText).digest("hex"),
      wordCount,
      bodyText: bodyText.slice(0, MAX_TEXT_RETURN),
      htmlRaw: html.slice(0, MAX_HTML_RETURN),
      screenshot,
    };
  } catch (e: any) {
    const v = blankView(label, url, 0, [], e?.message ?? "render_failed");
    v.rendered = true;
    return v;
  }
}

// ─── Wayback (archive.org) — latest snapshot ─────────────────────────────────
export async function getWayback(url: string): Promise<WaybackSnapshot | null> {
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { available: false };
    const data = await res.json();
    const snap = data?.archived_snapshots?.closest;
    if (snap?.available && snap.url) return { available: true, url: snap.url, timestamp: snap.timestamp };
    return { available: false };
  } catch {
    return null;
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
export async function analyzeUrl(url: string, opts?: { desktop?: boolean; referer?: boolean; firecrawlKey?: string; wayback?: boolean }): Promise<AnalyzeResult> {
  const views: ViewResult[] = [];
  const gbMobile = await followChain(url, "gbMobile");
  const chrome = await followChain(url, "chrome");
  views.push(gbMobile, chrome);
  if (opts?.desktop) views.push(await followChain(url, "gbDesktop"));
  if (opts?.referer) {
    const gbRef = await followChain(url, "gbMobile", { referer: true });
    gbRef.ua = "gbReferer";
    views.push(gbRef);
  }

  const diff = diffViews(gbMobile, chrome);

  // JS-rendered diff (optional, needs a Firecrawl key)
  let renderedDiff: CloakingDiff | undefined;
  if (opts?.firecrawlKey) {
    const gbRender = await renderWithFirecrawl(url, "gbMobile", "gbRender", opts.firecrawlKey);
    const brRender = await renderWithFirecrawl(url, "chrome", "browserRender", opts.firecrawlKey);
    views.push(gbRender, brRender);
    if (gbRender.ok && brRender.ok) {
      renderedDiff = diffViews(gbRender, brRender);
      // Fold rendered findings into the headline verdict
      if (renderedDiff.score > 0) {
        diff.flags.push(...renderedDiff.flags.map(f => `${f} (JS-рендер)`));
        diff.score = Math.min(100, Math.max(diff.score, renderedDiff.score));
        diff.verdict = diff.score >= 50 ? "cloaking" : diff.score >= 20 ? "suspicious" : "clean";
      }
    }
  }

  const wayback = opts?.wayback ? await getWayback(url) : null;

  // Anti-bot summary: did the raw fetch hit a wall, and did a render get past it?
  const rawProvider = gbMobile.antiBot || chrome.antiBot;
  const gbRenderView = views.find(v => v.ua === "gbRender");
  const antiBot: AntiBotInfo | null = rawProvider
    ? { blocked: true, provider: rawProvider, bypassed: !!gbRenderView?.ok }
    : null;

  // Honesty guard: if the direct Googlebot fetch was blocked by an anti-bot wall and nothing we
  // COULD reach showed a difference, we must not report "clean" — we simply never saw the real
  // Googlebot response. This is exactly the IP-gated cloaking case (doorway served only to real
  // Google IPs): undetectable by any external fetch, so mark it inconclusive and point to Google's
  // own tools (Rich Results Test) which crawl as the real Googlebot.
  if (antiBot?.blocked && diff.verdict === "clean") {
    diff.verdict = "unknown";
    diff.flags.unshift(
      "Прямой Googlebot-фетч заблокирован анти-бот защитой — подтвердить или опровергнуть клоаку отсюда нельзя. Такие сайты часто отдают «версию для Googlebot» только на реальный IP Google (IP-клоака), которую не видит ни один внешний фетчер. Проверь через Rich Results Test — он краулит как настоящий Googlebot с IP Google.",
    );
  }

  return { url, views, diff, renderedDiff, wayback, antiBot };
}
