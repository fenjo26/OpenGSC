import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLM } from "@/lib/llm";
import { runSerp, SerpEngine } from "@/lib/seo/serp";
import { scrapeMany } from "@/lib/seo/scrape";
import { buildFactCheckSectionPrompt, extractJson } from "@/lib/seo/prompts";

// POST /api/seo/factcheck-section
// body: { heading, text, keyword, serpProvider, serpKey, engine?, gl?, hl?, aiProvider, aiApiKey, model? }
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const heading = String(b.heading ?? "");
  const text = String(b.text ?? "");
  if (!text.trim()) return NextResponse.json({ error: "no_text" }, { status: 400 });

  const aiProvider = String(b.aiProvider ?? "anthropic");
  const aiKey = String(b.aiApiKey ?? "");
  if (!aiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });

  // 1) gather real sources. Cost saver: if the client supplies a shared competitor corpus
  // (reuse-corpus mode), use it directly and skip the per-section SERP + scrape entirely.
  let sources: { title: string; snippet: string; url: string; domain: string }[] =
    Array.isArray(b.sources) ? b.sources.filter((s: any) => s && s.url) : [];
  if (!sources.length && b.serpKey) {
    // Query MUST be topic-led: searching the bare heading ("Key Facts at a Glance",
    // "Transport Modes Comparison") returns generic/off-topic pages. Prefix the main keyword
    // so sources are about the actual subject (and right country/language).
    const kw = String(b.keyword ?? "").trim();
    // Strip first-person heading decoration («Mon Avis sur…», «Ce Que J'ai Découvert»,
    // "My Experience with…") — noise for search; keep the topical words.
    const cleanHeading = heading
      .replace(/\((.*?)\)/g, " $1 ")
      .replace(/\b(mon|ma|mes|je|j'ai|j'en|my|мой|моя|мои|avis|opinion|expérience|experience|découverts?|découvert|pense|complète|complete)\b/gi, " ")
      .replace(/[«»"“”?!—–]/g, " ")
      .replace(/\s+/g, " ").trim();
    const query = [kw, cleanHeading].filter(Boolean).join(" ").trim() || kw || heading;
    const serp = await runSerp(String(b.serpProvider || "serper"), String(b.serpKey), query, {
      gl: b.gl, hl: b.hl, num: 15, engine: (b.engine as SerpEngine) ?? "google",
    });
    const results = serp.results || [];
    const scrapeCount = Math.max(0, Math.min(10, Number(b.scrapeCount ?? 6)));
    const topUrls = results.slice(0, scrapeCount).map(r => r.url);
    let scraped: any[] = [];
    if (scrapeCount > 0) { try { scraped = await scrapeMany(topUrls, b.firecrawlKey ? String(b.firecrawlKey) : undefined, 4); } catch {} }
    sources = results.map(r => {
      const sc = scraped.find(s => s.url === r.url);
      const evidence = sc?.ok ? `${sc.metaDescription || ""} ${sc.textSample || ""}`.trim().slice(0, 1100) : "";
      return { title: r.title, snippet: evidence || r.snippet, url: r.url, domain: r.domain };
    });
  }

  // 2) LLM verifies the section's claims against the numbered sources
  const prompt = buildFactCheckSectionPrompt({ heading, text, keyword: String(b.keyword ?? ""), sources });
  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;
  let raw = await fetchLLM(prompt, aiProvider, aiKey, 3000, model, baseUrl);
  let parsed = extractJson<any>(raw);
  if (!parsed) { raw = await fetchLLM(prompt + "\n\nВерни ТОЛЬКО валидный JSON.", aiProvider, aiKey, 3000, model, baseUrl); parsed = extractJson<any>(raw); }
  if (!parsed) return NextResponse.json({ error: "parse_failed", heading, sources }, { status: 502 });

  return NextResponse.json({ heading, status: parsed.status ?? "partial", facts: parsed.facts ?? [], sources });
}
