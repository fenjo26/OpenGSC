// T1 — User-Agent parity probe.
//
// robots.txt says what a site *asks* AI crawlers to do. This asks what the server *does* when
// one shows up: the homepage is requested as a desktop browser (twice) and as four AI crawlers,
// and each bot's answer is compared to the browser's.
//
// What this can and cannot prove — keep the wording in the UI honest about it:
//   • It is a probe by User-Agent from OUR address. A WAF that verifies crawler IPs (Cloudflare's
//     "verified bots") may refuse our imitation and admit the real crawler, or the reverse. So a
//     verdict here reads "a request announcing itself as GPTBot was refused", not "GPTBot is
//     blocked". An IP/ASN vector is out of scope (CONTRACT §7).
//   • Change over time is not change by audience. The browser baseline is taken twice; what the
//     two differ by is the page's own noise (rotating blocks, tokens), and a bot is charged only
//     for divergence beyond it — the cloaking engine's principle, with the same metric.

import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import { textSimilarity } from "@/lib/seo/textSimilarity";
import { htmlToText } from "@/lib/ext/snippet";
import type { ParityReport, ParityRow, ParityVerdict } from "./types";

export interface ProbeIdentity { id: string; label: string; engine: string; ua: string }

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// User-Agent strings as each operator documents them. Engines are proper nouns, hardcoded like
// "ChatGPT" elsewhere in the codebase.
export const BOT_IDENTITIES: ProbeIdentity[] = [
  { id: "gptbot", label: "GPTBot", engine: "ChatGPT / OpenAI", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)" },
  { id: "claudebot", label: "ClaudeBot", engine: "Claude / Anthropic", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { id: "perplexitybot", label: "PerplexityBot", engine: "Perplexity", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
  { id: "ccbot", label: "CCBot", engine: "Common Crawl", ua: "CCBot/2.0 (https://commoncrawl.org/faq/)" },
];

/** Divergence a bot must show on top of the page's own noise before it counts as "different". */
export const PARITY_DELTA = 0.35;
/** A bot answer with less than this share of the browser's text is "different" regardless. */
export const THIN_RATIO = 0.2;
const TEXT_CAP = 40_000; // same cap the cloaking engine compares at
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 3 * 1024 * 1024;

/** One fetch, reduced to what the comparison needs. */
export interface ProbeSample {
  status: number | null;
  finalHost: string | null;
  text: string;
  challenge: boolean;
  error: string | null;
}

// ─── Pure half ────────────────────────────────────────────────────────────────

const CHALLENGE_MARKERS = [
  "_cf_chl_opt", "cf-chl-", "challenge-platform", "just a moment...", "attention required! | cloudflare",
  "px-captcha", "sgcaptcha", "ddos-guard", "g-recaptcha", "h-captcha", "verify you are human",
  "checking your browser", "enable javascript and cookies to continue",
];

/**
 * Is this response an anti-bot interstitial rather than the page? The header is authoritative;
 * body markers only count on a short document or a refusal status, because a real page may
 * legitimately embed a captcha widget in a form.
 */
export function looksLikeChallenge(status: number, headers: Headers, html: string): boolean {
  if ((headers.get("cf-mitigated") ?? "").toLowerCase().includes("challenge")) return true;
  const refused = status === 403 || status === 429 || status === 503;
  if (!refused && html.length > 20_000) return false;
  const lower = html.slice(0, 60_000).toLowerCase();
  return CHALLENGE_MARKERS.some(m => lower.includes(m));
}

const ok2xx = (s: ProbeSample) => s.status != null && s.status >= 200 && s.status < 300 && !s.challenge && !s.error;
const bareHost = (h: string | null) => (h ?? "").toLowerCase().replace(/^www\./, "");

/** How much the page differs from itself between two browser fetches. Null if either failed. */
export function noiseFloorOf(a: ProbeSample, b: ProbeSample): number | null {
  if (!ok2xx(a) || !ok2xx(b)) return null;
  return 1 - textSimilarity(a.text, b.text);
}

/**
 * Verdict for one bot sample against the browser baseline (one or two usable samples).
 * `baselines` holds only the browser fetches that came back 2xx without a challenge.
 */
export function classifyBot(bot: ProbeSample, baselines: ProbeSample[], noiseFloor: number): { verdict: ParityVerdict; similarity: number | null } {
  if (!baselines.length) return { verdict: "inconclusive", similarity: null };
  if (bot.error) return { verdict: "error", similarity: null };
  if (bot.challenge) return { verdict: "challenge", similarity: null };
  if (bot.status == null || bot.status < 200 || bot.status >= 300) return { verdict: "blocked", similarity: null };
  if (!baselines.some(b => bareHost(b.finalHost) === bareHost(bot.finalHost))) return { verdict: "redirected", similarity: null };

  const similarity = Math.max(...baselines.map(b => textSimilarity(bot.text, b.text)));
  const baseLen = Math.max(...baselines.map(b => b.text.length));
  // A near-empty answer to a bot where the browser got a page is the common "soft" block
  // (200 with a stub). Only meaningful when the browser page has real text to begin with.
  const thin = baseLen >= 500 && bot.text.length < baseLen * THIN_RATIO;
  const diverged = 1 - similarity > noiseFloor + PARITY_DELTA;
  return { verdict: thin || diverged ? "different" : "same", similarity: Math.round(similarity * 1000) / 1000 };
}

export function buildParityReport(url: string, browser: [ProbeSample, ProbeSample], bots: Array<{ identity: ProbeIdentity; sample: ProbeSample }>): ParityReport {
  const baselines = browser.filter(ok2xx);
  const noise = noiseFloorOf(browser[0], browser[1]);
  const rows: ParityRow[] = bots.map(({ identity, sample }) => {
    const { verdict, similarity } = classifyBot(sample, baselines, noise ?? 0);
    return { id: identity.id, label: identity.label, engine: identity.engine, status: sample.status, verdict, similarity };
  });
  return {
    url,
    baselineStatus: (baselines[0] ?? browser[0]).status,
    noiseFloor: noise == null ? null : Math.round(noise * 1000) / 1000,
    conclusive: baselines.length > 0,
    rows,
  };
}

// ─── Network half ─────────────────────────────────────────────────────────────

async function fetchAs(url: string, ua: string): Promise<ProbeSample> {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
    });
    const html = await res.text();
    let finalHost: string | null = null;
    try { finalHost = new URL(res.url).hostname; } catch { /* keep null */ }
    return {
      status: res.status,
      finalHost,
      text: htmlToText(html).slice(0, TEXT_CAP),
      challenge: looksLikeChallenge(res.status, res.headers, html),
      error: null,
    };
  } catch (e) {
    return { status: null, finalHost: null, text: "", challenge: false, error: e instanceof SafeFetchError ? e.code : "network_error" };
  }
}

/** Six GETs of one URL: browser ×2, then the four bots. Bots go out together, after the baseline. */
export async function probeParity(url: string): Promise<ParityReport> {
  const browser = await Promise.all([fetchAs(url, BROWSER_UA), fetchAs(url, BROWSER_UA)]) as [ProbeSample, ProbeSample];
  // No usable baseline — do not spend four more requests on a comparison that cannot be made.
  if (!browser.some(ok2xx)) {
    const blank: ProbeSample = { status: null, finalHost: null, text: "", challenge: false, error: null };
    return buildParityReport(url, browser, BOT_IDENTITIES.map(identity => ({ identity, sample: blank })));
  }
  const samples = await Promise.all(BOT_IDENTITIES.map(i => fetchAs(url, i.ua)));
  return buildParityReport(url, browser, BOT_IDENTITIES.map((identity, i) => ({ identity, sample: samples[i] })));
}
