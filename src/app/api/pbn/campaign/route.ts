import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { fetchLLM } from "@/lib/llm";
import { applyCampaignToSites, siteDiskDir, type CampaignSite, type GenerateSurrounding } from "@/lib/pbn/restore";
import { seedFromString, type AnchorSpec, type AnchorShares } from "@/lib/pbn/anchors";
import type { Rel } from "@/lib/pbn/place";
import { getSite, createCampaign, replaceLinks, pbnSchemaMissing } from "@/lib/pbn/store";

export const dynamic = "force-dynamic";

/**
 * POST { targetUrl, anchors:[{text,kind}], shares, scope, relShares, siteIds, confirm } —
 * применить кампанию ссылок к выбранным сайтам. PAID, если нужна AI-генерация околоссылочного
 * текста (ставится только там, где нет готового блока) — требует confirm:true.
 */
export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const targetUrl = typeof body?.targetUrl === "string" ? body.targetUrl.trim() : "";
    const anchors: AnchorSpec[] = Array.isArray(body?.anchors)
      ? (body.anchors as unknown[]).filter((a): a is AnchorSpec => !!a && typeof (a as AnchorSpec).text === "string").map(a => ({ text: String(a.text), kind: (["exact", "brand", "url", "generic"].includes(String(a.kind)) ? a.kind : "generic") as AnchorSpec["kind"] }))
      : [];
    const shares = (body?.shares && typeof body.shares === "object" ? body.shares : {}) as AnchorShares;
    const relShares = (body?.relShares && typeof body.relShares === "object" ? body.relShares : {}) as Partial<Record<Rel, number>>;
    const siteIds = (Array.isArray(body?.siteIds) ? body.siteIds : []).filter((s: unknown): s is string => typeof s === "string").slice(0, 500);
    const scope = typeof body?.scope === "string" ? body.scope : "homepage_only";
    if (!targetUrl || !siteIds.length) return NextResponse.json({ error: "target_and_sites_required" }, { status: 400 });

    // Сайты на диске.
    const sites: CampaignSite[] = [];
    for (const id of siteIds) {
      const s = await getSite(userId, id);
      if (s?.diskPath) sites.push({ siteId: s.id, domain: s.domain, diskDir: siteDiskDir(userId, s.domain) });
    }
    if (!sites.length) return NextResponse.json({ error: "no_restored_sites" }, { status: 400 });

    // Генератор околоссылочного текста — только если оператор подтвердил трату AI-кредитов.
    let generate: GenerateSurrounding | undefined;
    if (body?.confirm === true) {
      const creds = await resolveAiCreds(userId, body, "dropsHistory");
      if (creds.aiApiKey) {
        generate = async (pageText, anchor, lang) => {
          const prompt = [
            "Write exactly ONE short, natural sentence to host a link, in the SAME language as the page below.",
            lang ? `Page language tag: ${lang}.` : "",
            `The sentence MUST contain the literal token {link} where the anchor "${anchor}" will go.`,
            "No quotes, no markdown, reply with the sentence only.",
            "", "=== page text (excerpt) ===", pageText.slice(0, 600),
          ].filter(Boolean).join("\n");
          const r = await fetchLLM(prompt, creds.aiProvider, creds.aiApiKey, 120, creds.model, creds.aiBaseUrl);
          const t = (r ?? "").trim();
          return t.includes("{link}") ? t : undefined;
        };
      }
    }

    const campaignId = await createCampaign(userId, { targetUrl, anchors, shares, scope, relShares, siteIds });
    const applied = await applyCampaignToSites(sites, anchors, shares, targetUrl, relShares, seedFromString(campaignId), generate);

    // Запись размещений по сайтам.
    const bySite = new Map<string, typeof applied>();
    for (const a of applied) { const l = bySite.get(a.siteId) ?? []; l.push(a); bySite.set(a.siteId, l); }
    for (const [siteId, links] of bySite) {
      await replaceLinks(siteId, campaignId, links.map(l => ({
        siteId, campaignId, pagePath: l.pagePath, anchorText: l.anchorText, anchorKind: l.anchorKind,
        targetUrl: l.targetUrl, rel: l.rel, placement: l.placement, surroundingText: l.surroundingText,
        status: l.status, skipReason: l.skipReason,
      })));
    }

    return NextResponse.json({
      campaignId,
      placed: applied.filter(a => a.status === "placed").length,
      skipped: applied.filter(a => a.status === "skipped").map(a => ({ siteId: a.siteId, reason: a.skipReason })),
      results: applied,
    });
  } catch (e) {
    if (pbnSchemaMissing(e)) return NextResponse.json({ error: "pbn_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
