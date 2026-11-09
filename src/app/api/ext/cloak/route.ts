import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";
import { SlidingWindowRateLimiter } from "@/lib/ext/rateLimit";
import { assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";
import { analyzeUrl } from "@/lib/seo/googlebot";
import { snippetFound } from "@/lib/ext/snippet";
import { EXT_CLOAK_PER_MIN, type CloakRequest, type CloakResponse } from "@/lib/ext/types";

// POST /api/ext/cloak — does this URL serve the same page to Googlebot and to a browser?
// analyzeUrl fetches both views (Googlebot UA + desktop Chrome, and — that is the gambling
// standard — a Googlebot arriving WITH the SERP Referer), then we match the SERP snippet
// against both bodies. Two page fetches per call, own per-token limiter on top of the global
// 60/min: cloak checks are exactly the thing a curious user clicks in a burst.

const cloakLimiter = new SlidingWindowRateLimiter(EXT_CLOAK_PER_MIN, 60_000);

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;

  const now = Date.now();
  cloakLimiter.prune(now);
  const verdict = cloakLimiter.hit(`cloak:${auth.auth.userId}`, now);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: verdict.retryAfterMs },
      { status: 429, headers: { ...auth.auth.cors, "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)) } },
    );
  }

  let body: CloakRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: auth.auth.cors });
  }
  const url = String(body?.url ?? "");
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: auth.auth.cors });
  }

  try {
    await assertSafeTarget(url);
  } catch (e) {
    if (e instanceof SafeFetchError && e.code === "private_address") {
      return NextResponse.json({ error: "private_host" }, { status: 400, headers: auth.auth.cors });
    }
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: auth.auth.cors });
  }

  const snippet = body?.snippet != null ? String(body.snippet).slice(0, 500) : undefined;

  try {
    const result = await analyzeUrl(url, { samples: 1, referer: true, wayback: false });

    // bot view: the first Googlebot view; browser view: desktop Chrome
    const bot = result.views.find(v => v.ua.startsWith("gb")) ?? result.views[0];
    const browser = result.views.find(v => v.ua === "chrome") ?? result.views[1] ?? null;

    const view = (v: typeof bot | null) => ({
      status: v ? v.finalStatus : null,
      finalUrl: v ? v.finalUrl : null,
      title: v ? (v.signals.title || null) : null,
      snippetFound: v && snippet ? snippetFound(snippet, v.bodyText || "") : null,
    });

    let out: CloakResponse;
    const antiBot = result.antiBot;
    const blocked = (!!antiBot?.blocked && !antiBot?.bypassed) || !!bot?.blocked;
    const reasons = new Set<string>();
    result.diff.flags.forEach(f => reasons.add(f));
    result.refererDiff?.flags.forEach(f => reasons.add(f));
    if (antiBot?.blocked && !antiBot.bypassed && antiBot.provider) reasons.add(`anti_bot:${antiBot.provider}`);
    if (bot?.blocked) reasons.add("anti_bot:blocked");

    if (blocked) {
      out = {
        verdict: "blocked",
        reasons: [...reasons],
        bot: view(bot),
        browser: view(browser),
        checkedAt: new Date().toISOString(),
      };
    } else {
      // worst of the two diffs: cloaking/suspicious → differs, all-clean → same, unknown → error
      const verdicts = [result.diff.verdict, result.refererDiff?.verdict ?? "unknown"];
      let final: CloakResponse["verdict"] = "error";
      if (verdicts.some(v => v === "cloaking" || v === "suspicious")) final = "differs";
      else if (verdicts.every(v => v === "clean")) final = "same";
      const botSnippet = view(bot).snippetFound;
      const browserSnippet = view(browser).snippetFound;
      if (botSnippet === true && browserSnippet === false) {
        reasons.add("snippet_only_bot");
        final = "differs"; // the SERP shows text the visitor never sees — that IS the cloak
      } else if (botSnippet === false && browserSnippet === true) {
        reasons.add("snippet_only_browser");
      }
      out = {
        verdict: final,
        reasons: [...reasons],
        bot: { ...view(bot), snippetFound: botSnippet },
        browser: { ...view(browser), snippetFound: browserSnippet },
        checkedAt: new Date().toISOString(),
      };
    }

    return NextResponse.json(out, { headers: auth.auth.cors });
  } catch (e) {
    if (e instanceof SafeFetchError) {
      const out: CloakResponse = {
        verdict: "error",
        reasons: [e.code],
        bot: { status: null, finalUrl: null, title: null, snippetFound: null },
        browser: { status: null, finalUrl: null, title: null, snippetFound: null },
        checkedAt: new Date().toISOString(),
      };
      return NextResponse.json(out, { headers: auth.auth.cors });
    }
    const out: CloakResponse = {
      verdict: "error",
      reasons: ["exception"],
      bot: { status: null, finalUrl: null, title: null, snippetFound: null },
      browser: { status: null, finalUrl: null, title: null, snippetFound: null },
      checkedAt: new Date().toISOString(),
    };
    return NextResponse.json(out, { headers: auth.auth.cors });
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
