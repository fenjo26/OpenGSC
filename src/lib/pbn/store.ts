// Слой доступа к БД для PBN-модуля. Как в drops/store.ts, работаем через dbAny: сгенерированный
// Prisma-клиент в этой среде не обновляется, типы новых моделей появятся только после db push.
// Чистая логика живёт в anchors/score/clean/place; здесь — только чтение/запись.

import { dbAny } from "@/lib/prisma";
import type { AnchorSpec, AnchorShares } from "./anchors";
import type { Rel } from "./place";

export function pbnSchemaMissing(error: unknown): boolean {
  const v = error as { code?: string; message?: string } | undefined;
  return v?.code === "P2021" || /Pbn(?:Site|Page|Campaign|Link).*(?:does not exist|no such table)/i.test(String(v?.message ?? ""));
}

export interface PbnSiteRow {
  id: string;
  domain: string;
  snapshotTimestamp: string | null;
  status: string;
  pagesRequested: number;
  pagesRestored: number;
  pagesFailed: string;
  cleanedStats: string;
  diskPath: string | null;
  assetDomain: string | null;
}

export async function createOrGetSite(userId: string, domain: string): Promise<PbnSiteRow> {
  const existing = await dbAny.pbnSite.findUnique({ where: { userId_domain: { userId, domain } } });
  if (existing) return existing as PbnSiteRow;
  return (await dbAny.pbnSite.create({ data: { userId, domain } })) as PbnSiteRow;
}

export async function getSite(userId: string, id: string): Promise<PbnSiteRow | null> {
  return (await dbAny.pbnSite.findFirst({ where: { id, userId } })) as PbnSiteRow | null;
}

export async function listSites(userId: string): Promise<PbnSiteRow[]> {
  return (await dbAny.pbnSite.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 500 })) as PbnSiteRow[];
}

export async function updateSite(userId: string, id: string, data: Partial<Omit<PbnSiteRow, "id" | "domain">>): Promise<void> {
  await dbAny.pbnSite.updateMany({ where: { id, userId }, data });
}

export interface PbnPageRow {
  id: string;
  path: string;
  title: string | null;
  textChars: number;
  blocks: string;
  status: string;
}

/** Переписать набор страниц сайта (после восстановления). Удаляет старые, пишет новые. */
export async function replacePages(siteId: string, pages: { path: string; title?: string; textChars: number; blocks: unknown; status: string }[]): Promise<void> {
  await dbAny.pbnPage.deleteMany({ where: { siteId } });
  for (let i = 0; i < pages.length; i += 200) {
    await dbAny.pbnPage.createMany({
      data: pages.slice(i, i + 200).map(p => ({
        siteId, path: p.path, title: p.title ?? null, textChars: p.textChars,
        blocks: JSON.stringify(p.blocks ?? []), status: p.status,
      })),
    });
  }
}

export async function listPages(siteId: string): Promise<PbnPageRow[]> {
  return (await dbAny.pbnPage.findMany({ where: { siteId }, orderBy: { path: "asc" }, take: 2000 })) as PbnPageRow[];
}

export interface CampaignInput {
  targetUrl: string;
  anchors: AnchorSpec[];
  shares: AnchorShares;
  scope: string;
  relShares: Partial<Record<Rel, number>>;
  siteIds: string[];
}

export async function createCampaign(userId: string, c: CampaignInput): Promise<string> {
  const row = await dbAny.pbnCampaign.create({
    data: {
      userId, targetUrl: c.targetUrl,
      anchors: JSON.stringify(c.anchors), shares: JSON.stringify(c.shares),
      scope: c.scope, relShares: JSON.stringify(c.relShares), siteIds: JSON.stringify(c.siteIds),
    },
  });
  return row.id as string;
}

export interface PbnLinkInput {
  siteId: string;
  campaignId?: string;
  pagePath: string;
  anchorText: string;
  anchorKind: string;
  targetUrl: string;
  rel: string;
  placement: string;
  surroundingText?: string;
  status: string;
  skipReason?: string;
}

/** Заменить ссылки сайта от данной кампании (идемпотентность повторного применения). */
export async function replaceLinks(siteId: string, campaignId: string | undefined, links: PbnLinkInput[]): Promise<void> {
  await dbAny.pbnLink.deleteMany({ where: { siteId, ...(campaignId ? { campaignId } : {}) } });
  for (let i = 0; i < links.length; i += 200) {
    await dbAny.pbnLink.createMany({
      data: links.slice(i, i + 200).map(l => ({
        siteId: l.siteId, campaignId: l.campaignId ?? null, pagePath: l.pagePath,
        anchorText: l.anchorText, anchorKind: l.anchorKind, targetUrl: l.targetUrl, rel: l.rel,
        placement: l.placement, surroundingText: l.surroundingText ?? null,
        status: l.status, skipReason: l.skipReason ?? null,
      })),
    });
  }
}

export async function listLinks(siteId: string): Promise<PbnLinkInput[]> {
  return (await dbAny.pbnLink.findMany({ where: { siteId }, orderBy: { createdAt: "asc" }, take: 2000 })) as PbnLinkInput[];
}
