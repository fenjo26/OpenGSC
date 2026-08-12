import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { parseSeoSignals } from "@/lib/seo/googlebot";
import { fetchAsGooglebotBrowser } from "@/lib/seo/richResults";
import { assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";

// POST /api/seo/googlebot/rich-results
// body: { url: string, html?: string }
//   - html present → parse that pasted Rich Results HTML (reliable manual path)
//   - html absent  → automate the Rich Results Test via Playwright (experimental)
// → { ok, view?, error?, screenshot? }
//
// The returned `view` mirrors the ViewResult shape used by the main tool so the client can drop
// it straight into the content viewer / signals bar / diff as the authoritative "real Googlebot"
// (from a Google IP) view — the one that exposes IP-based cloaking.

function stripText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildView(url: string, html: string, screenshot?: string) {
  const signals = parseSeoSignals(url, html);
  const bodyText = stripText(html);
  return {
    ua: "gbRichResults",
    ok: true,
    rendered: true,
    hops: [{ url, status: 200 }],
    finalUrl: url,
    finalStatus: 200,
    headers: {},
    signals,
    bodyHash: "",
    wordCount: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
    bodyText: bodyText.slice(0, 40_000),
    htmlRaw: html.slice(0, 500_000),
    screenshot,
  };
}

export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("act");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  let url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return NextResponse.json({ error: "bad_url" }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch { return NextResponse.json({ error: "bad_url" }, { status: 400 }); }

  // Manual paste path — reliable, no automation.
  const pasted = typeof body.html === "string" ? body.html.trim() : "";
  if (pasted) {
    if (pasted.length < 40 || !/<html|<!doctype|<head|<body/i.test(pasted)) {
      return NextResponse.json({ error: "not_html" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, view: buildView(url, pasted) });
  }

  // The automated path launches a browser on the server. Resolve and reject internal targets
  // before Playwright sees the URL; the manual pasted-HTML path above performs no network access.
  let pinnedAddress = "";
  try {
    const target = await assertSafeTarget(url);
    pinnedAddress = target.addresses[0].address;
  } catch (error) {
    const code = error instanceof SafeFetchError && error.code === "private_address" ? "private_host" : "bad_url";
    return NextResponse.json({ error: code }, { status: 400 });
  }

  // Automated path — real headless browser hitting the target directly with Googlebot UA forced
  // at the CDP layer (persists through Cloudflare), optional residential proxy via GOOGLEBOT_PROXY.
  const res = await fetchAsGooglebotBrowser(url, { mobile: true, pinnedAddress });
  if (!res.ok || !res.html) {
    return NextResponse.json({ ok: false, error: res.error || "failed" }, { status: 200 });
  }
  return NextResponse.json({ ok: true, view: buildView(url, res.html, res.screenshot) });
}
