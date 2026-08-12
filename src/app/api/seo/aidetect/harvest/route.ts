import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { runSerp } from "@/lib/seo/serp";
import { scrapeMany } from "@/lib/seo/scrape";
import { normalizeForCorpus, tokenize } from "@/lib/seo/aidetect";

// POST /api/seo/aidetect/harvest — collect a HUMAN reference corpus for the fingerprint model.
//
// Server-side because it needs the SERP key and cross-origin scraping; the training itself runs in
// the browser (it's plain arithmetic) so nothing heavy has to round-trip. Reuses the existing
// SERP + scrape stack, which means Firecrawl fallback and anti-bot handling come for free.
//
// Accepts either a keyword (top-N organic results) or an explicit URL list — the latter matters
// because the best reference pages are usually ones the operator already knows are human-written.
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const keyword = String(b.keyword ?? "").trim();
  const urls: string[] = Array.isArray(b.urls) ? b.urls.map(String).filter(Boolean) : [];
  const want = Math.max(3, Math.min(30, Number(b.count) || 12));

  let targets = urls.slice(0, want);
  let serpError: string | undefined;

  if (!targets.length) {
    if (!keyword) return NextResponse.json({ error: "no_keyword" }, { status: 400 });
    const serpKey = String(b.serpKey ?? "");
    if (!serpKey) return NextResponse.json({ error: "no_serp_key" }, { status: 400 });
    const serp = await runSerp(String(b.serpProvider || "serper"), serpKey, keyword, {
      gl: b.gl, hl: b.hl, num: want, engine: "google",
    });
    if (serp.error) serpError = serp.error;
    targets = (serp.results || []).map(r => r.url).slice(0, want);
  }
  if (!targets.length) return NextResponse.json({ error: serpError || "no_results" }, { status: 502 });

  const pages = await scrapeMany(targets, b.firecrawlKey ? String(b.firecrawlKey) : undefined, 4);

  // Only keep pages with enough prose to produce at least one scoreable window. A 200-word
  // cookie-banner page would otherwise enter the corpus as a "human" sample and poison the weights.
  const docs = pages
    .filter(p => p.ok)
    .map(p => {
      const text = normalizeForCorpus(`${p.title} ${p.metaDescription} ${p.textSample}`);
      return { url: p.url, title: p.title, via: p.via, words: tokenize(text).length, text };
    })
    .filter(d => d.words >= 150);

  return NextResponse.json({
    docs,
    requested: targets.length,
    scraped: pages.filter(p => p.ok).length,
    kept: docs.length,
    skipped: pages.filter(p => p.ok).length - docs.length,
  });
}
