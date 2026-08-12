import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { expandKeywords, type KwSource } from "@/lib/seo/keywordSource";
import { priceExpand, type IdeaMode } from "@/lib/seo/metrics";
import { readUsage, recordUsage, withinCap, releaseUnusedUnits } from "@/lib/seo/metricsStore";

// POST /api/seo/keyword-ideas
//   { seed, country, language?, limit?, withDifficulty?, mode?,
//     source, apiKey?, baseUrl?, cap?, fetch? }
//
// Replaces `/api/seo/keywords`, which was a thin wrapper over DataForSEO and nothing else. Same
// job — turn a seed into keywords with volumes — but the provider is now whatever the user
// configured, and the price is charged against the same monthly cap as every other paid call.
//
// `fetch: false` returns the price and buys nothing, so the button can quote itself. That is the
// default: the content tools must not be able to spend money by rendering.

const SOURCES: KwSource[] = ["ahrefs", "semrush", "dataforseo", "off"];

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const seed = String(b.seed ?? b.keyword ?? "").trim();
  const country = String(b.country ?? b.gl ?? "").trim().toLowerCase();
  const language = String(b.language ?? b.hl ?? "en").toLowerCase();
  const limit = Math.max(10, Math.min(200, Number(b.limit ?? 100)));
  const withDifficulty = !!b.withDifficulty;
  const mode: IdeaMode = b.mode === "related" ? "related" : "matching";
  const source = (SOURCES.includes(b.source) ? b.source : "off") as KwSource;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  const cap = Number(b.cap ?? 0);
  const wantFetch = !!b.fetch;

  if (!seed) return NextResponse.json({ error: "no_seed", items: [] }, { status: 400 });
  // Not defaulted to "us". A seed researched against the wrong market is filed under that market
  // in the shared cache and stays wrong for everyone who reads it later.
  if (!country) return NextResponse.json({ error: "no_country", items: [] }, { status: 400 });

  const provider = source === "ahrefs" || source === "semrush" ? source : null;
  const price = priceExpand(source, limit, withDifficulty, mode);
  const usage = provider ? await readUsage(userId, provider) : null;

  if (!wantFetch) {
    return NextResponse.json({
      items: [], source, units: price.units, usd: price.usd, usage,
      ...(source === "off" ? { error: "source_off" } : {}),
      ...(source !== "off" && !apiKey ? { error: "no_key" } : {}),
    });
  }

  if (source === "off") return NextResponse.json({ items: [], source, error: "source_off" }, { status: 400 });
  if (!apiKey) return NextResponse.json({ items: [], source, error: "no_key" }, { status: 400 });

  // Charged before the call, like every other paid path in this codebase: the price follows from
  // the row limit and the field selection, both known here.
  if (provider && price.units) {
    if (!(await withinCap(userId, provider, price.units, cap))) {
      return NextResponse.json({
        items: [], source, units: 0, usd: 0, usage,
        error: "cap_exceeded", wouldSpend: price.units,
      }, { status: 429 });
    }
    await recordUsage(userId, provider, price.units);
  }

  let res;
  try {
    res = await expandKeywords({ source, apiKey, baseUrl }, seed, {
      country, language, limit, withDifficulty, mode, fetch: true,
    });
  } catch (e: any) {
    // A thrown error here is a bug, not a provider refusal — providers return their errors inside
    // the result. Surfacing it as JSON (rather than a bare 500) means the UI can show what broke
    // instead of silently doing nothing.
    return NextResponse.json({
      items: [], source, units: 0, usd: 0,
      usage: provider ? await readUsage(userId, provider) : null,
      error: `internal: ${String(e?.message ?? e).slice(0, 300)}`,
    }, { status: 500 });
  }

  // The reservation above priced `limit` rows; Ahrefs billed the rows it actually returned. Give
  // the difference back before answering, so the month's counter tracks money rather than intent.
  if (provider && price.units) {
    await releaseUnusedUnits(userId, provider, price.units, res.units || 0);
  }

  if (res.error && !res.rows.length) {
    return NextResponse.json({
      items: [], source: res.source, units: res.units, usd: res.usd,
      usage: provider ? await readUsage(userId, provider) : null,
      error: res.error,
    }, { status: 502 });
  }

  return NextResponse.json({
    // `items` keeps the field name the old route used, so a caller can be moved over without
    // touching how it reads the response.
    items: res.rows,
    source: res.source,
    units: res.units,
    usd: res.usd,
    usage: provider ? await readUsage(userId, provider) : null,
    ...(res.error ? { error: res.error } : {}),
  });
}
