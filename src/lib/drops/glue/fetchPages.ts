import {
  safeFetch,
  SafeFetchError,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from "@/lib/security/safeFetch";
// The UA pair the repo already uses for its "Googlebot View" cloaking diff — same honest
// model: we spoof the User-Agent (UA-based cloaking is the common kind); Google's IP
// ranges are Google's, so IP-based cloaking stays invisible, exactly as documented there.
import { UA } from "@/lib/seo/googlebot";
import type { Finding, GlueReport, PageFacts, PageFetch, Severity } from "./types";
import { canonicalKey, sameUrl } from "./locale";

export interface FetchOptions {
  ua: "browser" | "googlebot";
  timeoutMs?: number; // per request, default 8000
  maxBytes?: number; // body cap, default 1 MB
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1_000_000;
/** The cluster is a drop plus its money pages — ten URLs is a bigger cluster than the scheme ever describes. */
export const MAX_URLS = 10;
const MAX_REDIRECTS = 5;
const PARALLELISM = 4;

const UAS: Record<FetchOptions["ua"], string> = {
  browser: UA.chrome,
  googlebot: UA.gbDesktop,
};

/** Injectable so tests mock the wire without touching safeFetch (same seam as the toxicity collector). */
type Fetcher = (input: string | URL, options: SafeFetchOptions) => Promise<SafeFetchResponse>;

/**
 * Fetches every page of a glue cluster. Redirects are followed manually so the whole chain
 * lands in `redirectChain` — annotations are read from the FINAL response, and "final URL is
 * not the URL you annotated" is itself a finding. Each hop is a separate safeFetch call, so
 * the SSRF guard re-validates every redirect target; nothing here relaxes it.
 *
 * Concurrency: four hosts at a time, one page at a time within a host — a cluster is usually
 * 2–3 hosts, and hammering one host in parallel is how a flaky CDN turns a check into noise.
 */
export async function fetchClusterPages(
  urls: string[],
  opts: FetchOptions,
  deps: { fetch?: Fetcher } = {},
): Promise<PageFetch[]> {
  const fetcher = deps.fetch ?? safeFetch;
  const list = urls.slice(0, MAX_URLS);

  const lanes = new Map<string, number[]>();
  list.forEach((u, i) => {
    let host = u;
    try {
      host = new URL(u).host.toLowerCase();
    } catch {
      // Not a parseable URL — safeFetch will refuse it with a code; keep it in its own lane.
    }
    const bucket = lanes.get(host);
    if (bucket) bucket.push(i);
    else lanes.set(host, [i]);
  });

  const out: PageFetch[] = new Array(list.length);
  const queue = [...lanes.values()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const lane = queue[cursor++];
      for (const i of lane) out[i] = await fetchOne(list[i], opts, fetcher);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLELISM, queue.length) }, worker));
  return out;
}

async function fetchOne(url: string, opts: FetchOptions, fetcher: Fetcher): Promise<PageFetch> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const base: SafeFetchOptions = {
    redirect: "manual",
    timeoutMs,
    maxBytes,
    headers: { "user-agent": UAS[opts.ua] },
  };
  const redirectChain: { url: string; status: number }[] = [];
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: SafeFetchResponse;
    try {
      res = await fetcher(current, base);
    } catch (error) {
      // safeFetch refuses (rather than truncates) a body over maxBytes, and the only part
      // the parser reads — <head> — sits in the first kilobytes. One Range retry gets
      // those bytes from servers that honour it; a server that does not fails honestly.
      if (error instanceof SafeFetchError && error.code === "response_too_large") {
        try {
          res = await fetcher(current, {
            ...base,
            headers: { "user-agent": UAS[opts.ua], range: `bytes=0-${maxBytes - 1}` },
          });
        } catch {
          return failed(url, current, 0, redirectChain, "response_too_large");
        }
      } else {
        return failed(url, current, 0, redirectChain, errText(error));
      }
    }

    const status = res.status;
    const location =
      status >= 300 && status < 400 && status !== 304 ? res.headers.get("location") : null;

    if (location) {
      if (hop === MAX_REDIRECTS) {
        return failed(url, current, status, redirectChain, "too_many_redirects");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return failed(url, current, status, redirectChain, "invalid_redirect");
      }
      redirectChain.push({ url: current, status });
      current = next.toString();
      continue;
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const html = await res.text();
    return {
      requestedUrl: url,
      finalUrl: current,
      status,
      redirectChain,
      headers,
      html: html.slice(0, maxBytes),
    };
  }

  // Unreachable — every loop path returns; here for the compiler.
  return failed(url, current, 0, redirectChain, "too_many_redirects");
}

function failed(
  requestedUrl: string,
  finalUrl: string,
  status: number,
  redirectChain: { url: string; status: number }[],
  error: string,
): PageFetch {
  return { requestedUrl, finalUrl, status, redirectChain, error };
}

function errText(error: unknown): string {
  if (error instanceof SafeFetchError) return error.code;
  if (error instanceof Error) return error.message;
  return "network_error";
}

/**
 * The cloaking diff: same URLs asked twice, once as a browser and once as Googlebot.
 * Only annotation facts are compared — a page may legitimately serve different chrome to
 * bots; what the cluster must never do is tell the bot a different canonical or a
 * different alternate set than it tells the visitor.
 */
export function detectCloaking(browser: PageFacts[], googlebot: PageFacts[]): Finding[] {
  const botByRequest = new Map(googlebot.map((f) => [f.requestedUrl, f]));
  const findings: Finding[] = [];
  for (const page of browser) {
    const bot = botByRequest.get(page.requestedUrl);
    if (!bot || page.error || bot.error) continue;

    const diffs: string[] = [];
    if (!sameUrl(page.canonical, bot.canonical)) {
      diffs.push(`canonical: ${page.canonical ?? "—"} / ${bot.canonical ?? "—"}`);
    }
    const altKey = (f: PageFacts) =>
      f.alternates
        .map((a) => `${a.hreflang.toLowerCase()}=${canonicalKey(a.url)}`)
        .sort()
        .join(" | ");
    if (altKey(page) !== altKey(bot)) {
      diffs.push("alternate");
    }
    if (diffs.length) {
      findings.push({
        code: "cloaked_annotations",
        severity: "warn",
        page: page.requestedUrl,
        detail: diffs.join("; "),
      });
    }
  }
  return findings;
}

/** Folds extra findings (the UA diff) into a finished report, recomputing the summary. */
export function withFindings(report: GlueReport, extra: Finding[]): GlueReport {
  if (!extra.length) return report;
  const findings = [...report.findings, ...extra];
  const counts: Record<Severity, number> = { blocker: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { ...report, ok: counts.blocker === 0, findings, counts };
}
