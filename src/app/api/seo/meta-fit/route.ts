import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { rawQuery, rawExec } from "@/lib/db/raw";
import { fitMeta, readMetaBlock, writeMetaBlock } from "@/lib/seo/metaFit";
import type { MetaFitItem, MetaFitResponse } from "@/lib/seo/metaLimits";

// POST /api/seo/meta-fit (CONTRACT.md §4, wave-oct T1).
//
// Brings title/description inside the audit band, by code — the model cannot count characters.
//   body: { items: MetaFitItem[] (≤ 50), allowLlm?: boolean, historyIds?: string[] (≤ 50),
//           language?: string (for historyIds items), aiProvider?/aiApiKey?/model?/aiBaseUrl? }
//   → { results: MetaFitResponse[] }
//
// Without `allowLlm` the call is pure string work and needs only "act". With `allowLlm` each
// item costs up to 2 repair calls on the user's key → "spend", refused with 403 spend_required
// when the actor lacks it. Provider keys resolve exactly the way genText does server-side:
// explicit body credentials win (that is what the browser posts), otherwise the stored
// per-task settings mirror (that is what MCP/server callers rely on).
//
// `historyIds` fits the meta of already-saved articles in place: the article string is read
// from SeoHistory.data, the head block is re-fitted and written back. Items without
// historyIds are pure suggestions — nothing is stored (T5's audit button depends on that).

const MAX_ITEMS = 50;

// SeoHistory.data always holds JSON (the article string is JSON-encoded on write), but older
// rows and hand-imports may carry the raw text — same fallback the History route uses.
const safeParse = (s: string): string => { try { const v = JSON.parse(s); return typeof v === "string" ? v : s; } catch { return s; } };

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const allowLlm = b.allowLlm === true;
  if (allowLlm) {
    const spender = await workspaceUserId("spend");
    if (!spender) return NextResponse.json({ error: "spend_required" }, { status: 403 });
  }

  // Items: caller-supplied suggestions, always capped and sanitized.
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length > MAX_ITEMS) return NextResponse.json({ error: "too_many_items" }, { status: 400 });
  const items: MetaFitItem[] = rawItems.map((x: unknown, i: number) => {
    const it = (x ?? {}) as Record<string, unknown>;
    return {
      id: it.id != null ? String(it.id) : `item-${i}`,
      keyword: String(it.keyword ?? "").slice(0, 300),
      language: String(it.language ?? "en").slice(0, 8),
      title: it.title != null ? String(it.title) : undefined,
      description: it.description != null ? String(it.description) : undefined,
      titleOptions: Array.isArray(it.titleOptions) ? it.titleOptions.map((o) => String(o ?? "")).slice(0, 10) : undefined,
      descriptionOptions: Array.isArray(it.descriptionOptions) ? it.descriptionOptions.map((o) => String(o ?? "")).slice(0, 10) : undefined,
      brand: it.brand != null ? String(it.brand).slice(0, 100) : undefined,
    };
  });

  // historyIds: articles already in SeoHistory, fitted and saved back in place. A record
  // without a head block has nothing to fit and is silently skipped (the caller's items stay
  // the source of truth for what was requested; the response simply has no entry for it).
  const historyIds = (Array.isArray(b.historyIds) ? b.historyIds : []).map(String).filter(Boolean).slice(0, MAX_ITEMS);
  const historyLang = String(b.language ?? "en").slice(0, 8);
  const articles = new Map<string, string>();
  if (historyIds.length) {
    if (items.length + historyIds.length > MAX_ITEMS) {
      return NextResponse.json({ error: "too_many_items" }, { status: 400 });
    }
    try {
      const ph = historyIds.map(() => "?").join(",");
      const rows: { id: string; keyword: string | null; data: string | null }[] = await rawQuery(
        `SELECT id, keyword, data FROM "SeoHistory" WHERE userId = ? AND id IN (${ph})`,
        userId, ...historyIds);
      for (const row of rows) {
        const text = safeParse(String(row.data ?? ""));
        const block = readMetaBlock(text);
        if (!block) continue;
        articles.set(row.id, text);
        items.push({
          id: row.id,
          keyword: String(row.keyword ?? "").slice(0, 300),
          language: historyLang,
          title: block.title,
          description: block.description,
        });
      }
    } catch {
      return NextResponse.json({ error: "db: table not available (run: npx prisma db push)" }, { status: 500 });
    }
  }

  if (!items.length) return NextResponse.json({ results: [] });

  // Provider credentials: explicit body values first (the browser sends the set it resolved
  // for the text task), else the stored mirror — the same chain the background jobs use.
  let llm: { allow: boolean; provider?: string; apiKey?: string; model?: string; baseUrl?: string } = { allow: false };
  if (allowLlm) {
    const bodyKey = String(b.aiApiKey ?? "").trim();
    if (bodyKey) {
      llm = {
        allow: true,
        provider: String(b.aiProvider ?? "anthropic"),
        apiKey: bodyKey,
        model: b.model ? String(b.model) : undefined,
        baseUrl: b.aiBaseUrl ? String(b.aiBaseUrl) : undefined,
      };
    } else {
      const creds = await resolveAiCreds(userId, b, "text").catch(() => null);
      if (!creds?.aiApiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });
      llm = {
        allow: true, provider: creds.aiProvider, apiKey: creds.aiApiKey,
        model: creds.model, baseUrl: creds.aiBaseUrl,
      };
    }
  }

  // The repair calls are provider calls: they belong in the provider log under this feature.
  const captureBodies = await resolveCaptureBodies(userId);
  const results: MetaFitResponse[] = await withCallContext({ userId, feature: "meta-fit", captureBodies }, async () => {
    const out: MetaFitResponse[] = [];
    for (const item of items) {
      // One bad item must not cost the caller the batch: a thrown fit (e.g. a provider error
      // inside the repair call) collapses to that item's local result.
      try {
        out.push(await fitMeta(item, llm));
      } catch {
        out.push({ id: item.id, llmCalls: 0 });
      }
    }
    return out;
  });

  // Write fitted meta back into the saved articles. Unfixable fields carry `after === before`,
  // so the comparison below skips them naturally — nothing out of band is ever stored.
  for (let i = 0; i < items.length; i++) {
    const id = items[i].id;
    if (!id || !articles.has(id)) continue;
    const r = results[i];
    if (!r) continue;
    const text = articles.get(id)!;
    const block = readMetaBlock(text);
    if (!block) continue;
    const patch: { title?: string; description?: string } = {};
    if (r.title?.after && r.title.after !== block.title) patch.title = r.title.after;
    if (r.description?.after && r.description.after !== block.description) patch.description = r.description.after;
    if (patch.title == null && patch.description == null) continue;
    const updated = writeMetaBlock(text, patch);
    try {
      await rawExec(
        `UPDATE "SeoHistory" SET data = ?, updatedAt = ? WHERE userId = ? AND id = ?`,
        JSON.stringify(updated), new Date().toISOString(), userId, id);
    } catch { /* table not migrated — the result is still returned as a suggestion */ }
  }

  return NextResponse.json({ results });
}
