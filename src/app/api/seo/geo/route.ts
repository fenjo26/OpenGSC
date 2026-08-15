import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { OPENAI_FALLBACK_MODELS } from "@/lib/seo/models";
import { prisma } from "@/lib/prisma";
import { runGeoAudit, type GeoEngine, type GeoAnalysisCreds } from "@/lib/seo/geo";

// GeoAudit isn't in the committed generated client until `prisma generate` re-runs on
// build; access it via a loose handle so types resolve everywhere (mirrors SeoJob).
const audits = () => (prisma as any).geoAudit;

// Detached background run — not awaited by the request, so the result is persisted even
// if the client navigates away. The API key lives only in memory for the run.
function runAudit(id: string, params: { query: string; language: string; country: string; model: string; apiKey: string; engine: GeoEngine; analysisModel?: string; analysis?: GeoAnalysisCreds }) {
  runGeoAudit(params)
    .then(async (r) => {
      if (r.ok) await audits().update({ where: { id }, data: { status: "completed", report: JSON.stringify(r.data) } });
      else await audits().update({ where: { id }, data: { status: "error", error: r.error } });
    })
    .catch(async (e: any) => {
      try { await audits().update({ where: { id }, data: { status: "error", error: String(e?.message ?? e) } }); } catch {}
    });
}

// POST /api/seo/geo — start a GEO audit. body: { query, language?, country?, model?, apiKey }
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const query = String(b.query ?? "").trim().slice(0, 300);
  if (!query) return NextResponse.json({ error: "no_query" }, { status: 400 });
  const apiKey = String(b.apiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_key" }, { status: 400 });
  const engine: GeoEngine = b.engine === "kie" ? "kie" : "openai";
  const language = String(b.language ?? "en");
  const country = String(b.country ?? "us");
  const model = String(b.model ?? "") || (engine === "kie" ? "gpt-5-5" : OPENAI_FALLBACK_MODELS[0]);
  // Stage-2 model, sent by the client from the `utility` task setting. Optional: an older
  // client that does not send it falls back inside runGeoAudit rather than failing.
  const analysisModel = String(b.analysisModel ?? "") || undefined;
  // Stage-2 provider + key, from the same `utility` task setting. The search pass needs a hosted
  // web_search tool and so stays on OpenAI or kie.ai; the analysis pass only reads a trace and
  // writes JSON, so it follows the user's per-task choice like every other analysis step — and
  // can therefore run on a cheaper gateway than the one doing the searching.
  //
  // Validated field by field rather than spread from the body: this object reaches an outbound
  // fetch, and `baseUrl` in particular decides where a key is sent.
  const a = b.analysis;
  const analysis: GeoAnalysisCreds | undefined =
    a && typeof a.provider === "string" && a.provider.trim() && typeof a.apiKey === "string" && a.apiKey.trim()
      ? {
          provider: a.provider.trim(),
          apiKey: a.apiKey.trim(),
          model: typeof a.model === "string" && a.model.trim() ? a.model.trim() : undefined,
          baseUrl: typeof a.baseUrl === "string" && a.baseUrl.trim() ? a.baseUrl.trim() : undefined,
        }
      : undefined;

  let rec: any;
  try {
    rec = await audits().create({ data: { userId, query, language, country, model, status: "processing" } });
  } catch (e: any) {
    return NextResponse.json({ error: `db: ${String(e?.message ?? e)} (run: npx prisma db push)` }, { status: 500 });
  }

  runAudit(rec.id, { query, language, country, model, apiKey, engine, analysisModel, analysis }); // fire-and-forget
  return NextResponse.json({ id: rec.id });
}

// GET /api/seo/geo — list the user's recent audits (metadata only, no full report).
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // Auto-fail audits stuck "processing" past the max window (server may have restarted).
    const cutoff = new Date(Date.now() - 20 * 60 * 1000);
    try { await audits().updateMany({ where: { userId, status: "processing", updatedAt: { lt: cutoff } }, data: { status: "error", error: "stale_timeout" } }); } catch {}
    const list = await audits().findMany({
      where: { userId }, orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, query: true, language: true, country: true, model: true, status: true, error: true, createdAt: true, updatedAt: true },
    });
    return NextResponse.json({ audits: list });
  } catch {
    return NextResponse.json({ audits: [] }); // table not migrated yet → empty, no crash
  }
}
