import { prisma } from "@/lib/prisma";
import { isHttpUrl, normalizeProspectDomain, OUTREACH_STAGE_SET } from "./types";

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

function optionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_date");
  return date;
}

async function ownedCampaign(userId: string, campaignId: unknown) {
  const id = text(campaignId, 100);
  if (!id) return null;
  const campaign = await prisma.outreachCampaign.findFirst({ where: { id, userId }, select: { id: true } });
  if (!campaign) throw new Error("campaign_not_found");
  return campaign.id;
}

async function ownedBacklink(userId: string, backlinkId: unknown, wonBacklinkUrl: unknown) {
  const id = text(backlinkId, 100);
  const url = text(wonBacklinkUrl, 2000);
  if (url && !isHttpUrl(url)) throw new Error("invalid_backlink_url");
  if (id) {
    const backlink = await prisma.backlink.findFirst({ where: { id, site: { userId } }, select: { id: true, url: true } });
    if (!backlink) throw new Error("backlink_not_found");
    return backlink;
  }
  if (url) {
    const backlink = await prisma.backlink.findFirst({ where: { url, site: { userId } }, select: { id: true, url: true } });
    return backlink ?? { id: null, url };
  }
  return { id: null, url: "" };
}

export async function listOutreach(userId: string, filters: { stage?: string; campaignId?: string } = {}) {
  const where = {
    userId,
    ...(filters.stage && OUTREACH_STAGE_SET.has(filters.stage) ? { stage: filters.stage } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
  };
  const [campaigns, prospects, backlinks] = await Promise.all([
    prisma.outreachCampaign.findMany({ where: { userId }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }] }),
    prisma.outreachProspect.findMany({
      where,
      include: { campaign: { select: { id: true, name: true, targetAsset: true } }, events: { orderBy: { createdAt: "desc" }, take: 20 } },
      orderBy: [{ nextFollowUpAt: "asc" }, { updatedAt: "desc" }],
      take: 1000,
    }),
    prisma.backlink.findMany({
      where: { site: { userId } },
      select: { id: true, siteId: true, url: true, title: true, isAlive: true, aliveStatus: true, aliveChecked: true, site: { select: { url: true } } },
      orderBy: { addedAt: "desc" },
      take: 500,
    }),
  ]);

  const backlinkById = new Map(backlinks.map(link => [link.id, link]));
  const byStage = Object.fromEntries([...OUTREACH_STAGE_SET].map(stage => [stage, 0])) as Record<string, number>;
  for (const prospect of prospects) byStage[prospect.stage] = (byStage[prospect.stage] ?? 0) + 1;
  const now = Date.now();
  const open = prospects.filter(prospect => prospect.stage !== "won" && prospect.stage !== "lost");
  const due = open.filter(prospect => prospect.nextFollowUpAt && prospect.nextFollowUpAt.getTime() <= now).length;
  const won = byStage.won ?? 0;

  const campaignCounts = new Map<string, { total: number; won: number }>();
  for (const prospect of prospects) {
    if (!prospect.campaignId) continue;
    const count = campaignCounts.get(prospect.campaignId) ?? { total: 0, won: 0 };
    count.total++;
    if (prospect.stage === "won") count.won++;
    campaignCounts.set(prospect.campaignId, count);
  }

  return {
    campaigns: campaigns.map(campaign => ({ ...campaign, ...(campaignCounts.get(campaign.id) ?? { total: 0, won: 0 }) })),
    prospects: prospects.map(prospect => ({ ...prospect, backlink: prospect.backlinkId ? backlinkById.get(prospect.backlinkId) ?? null : null })),
    backlinks,
    stats: {
      total: prospects.length,
      open: open.length,
      due,
      won,
      conversionPercent: prospects.length ? Math.round((won / prospects.length) * 1000) / 10 : 0,
      byStage,
    },
  };
}

export async function createOutreachCampaign(userId: string, input: Record<string, unknown>) {
  const name = text(input.name, 120);
  if (!name) throw new Error("campaign_name_required");
  try {
    return await prisma.outreachCampaign.create({
      data: { userId, name, targetAsset: text(input.targetAsset, 1000), notes: text(input.notes, 5000) },
    });
  } catch (error: any) {
    if (error?.code === "P2002") throw new Error("campaign_name_exists");
    throw error;
  }
}

export async function updateOutreachCampaign(userId: string, id: string, input: Record<string, unknown>) {
  const existing = await prisma.outreachCampaign.findFirst({ where: { id, userId } });
  if (!existing) throw new Error("campaign_not_found");
  const name = input.name === undefined ? undefined : text(input.name, 120);
  if (name === "") throw new Error("campaign_name_required");
  const status = input.status === undefined ? undefined : text(input.status, 20);
  if (status && status !== "active" && status !== "archived") throw new Error("invalid_campaign_status");
  try {
    return await prisma.outreachCampaign.update({
      where: { id },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(input.targetAsset === undefined ? {} : { targetAsset: text(input.targetAsset, 1000) }),
        ...(input.notes === undefined ? {} : { notes: text(input.notes, 5000) }),
        ...(status === undefined ? {} : { status }),
      },
    });
  } catch (error: any) {
    if (error?.code === "P2002") throw new Error("campaign_name_exists");
    throw error;
  }
}

export async function deleteOutreachCampaign(userId: string, id: string) {
  const result = await prisma.outreachCampaign.deleteMany({ where: { id, userId } });
  if (!result.count) throw new Error("campaign_not_found");
}

export async function createOutreachProspect(userId: string, input: Record<string, unknown>) {
  const requestedDomain = normalizeProspectDomain(text(input.domain, 500));
  const requestedUrl = text(input.sourceUrl, 2000);
  if (requestedUrl && !isHttpUrl(requestedUrl)) throw new Error("invalid_source_url");

  const mention = requestedUrl
    ? await prisma.linkMention.findFirst({ where: { userId, urlFrom: requestedUrl, ...(requestedDomain ? { domainFrom: requestedDomain } : {}) }, orderBy: { drFrom: "desc" } })
    : requestedDomain
      ? await prisma.linkMention.findFirst({ where: { userId, domainFrom: requestedDomain }, orderBy: { drFrom: "desc" } })
      : null;
  const domain = normalizeProspectDomain(mention?.domainFrom || requestedDomain || requestedUrl);
  if (!domain || !domain.includes(".")) throw new Error("prospect_domain_required");
  const campaignId = await ownedCampaign(userId, input.campaignId);

  const existing = await prisma.outreachProspect.findUnique({ where: { userId_domain: { userId, domain } } });
  if (existing) return { prospect: existing, created: false };

  try {
    const prospect = await prisma.$transaction(async tx => {
      const created = await tx.outreachProspect.create({
        data: {
          userId,
          campaignId,
          domain,
          sourceUrl: mention?.urlFrom || requestedUrl,
          sourceTitle: mention?.title || text(input.sourceTitle, 500),
          sourceBrand: mention?.brand || text(input.sourceBrand, 300),
          sourceAnchor: mention?.anchor || text(input.sourceAnchor, 500),
          sourceDr: mention?.drFrom || Number(input.sourceDr) || 0,
          sourceFirstSeen: mention?.firstSeen || text(input.sourceFirstSeen, 100),
          sourceDofollow: mention?.dofollow ?? input.sourceDofollow !== false,
          targetAsset: text(input.targetAsset, 1000),
          pitchAngle: text(input.pitchAngle, 2000),
          notes: text(input.notes, 5000),
        },
      });
      await tx.outreachStageEvent.create({
        data: { prospectId: created.id, userId, fromStage: "", toStage: "discovered", note: "prospect_created" },
      });
      return created;
    });
    return { prospect, created: true };
  } catch (error: any) {
    // Two tabs can save the same domain at the same time. The unique key is the final
    // arbiter; return the already-created row instead of surfacing an avoidable 500.
    if (error?.code === "P2002") {
      const raced = await prisma.outreachProspect.findUnique({ where: { userId_domain: { userId, domain } } });
      if (raced) return { prospect: raced, created: false };
    }
    throw error;
  }
}

export async function updateOutreachProspect(userId: string, id: string, input: Record<string, unknown>) {
  const existing = await prisma.outreachProspect.findFirst({ where: { id, userId } });
  if (!existing) throw new Error("prospect_not_found");
  const stage = input.stage === undefined ? existing.stage : text(input.stage, 30);
  if (!OUTREACH_STAGE_SET.has(stage)) throw new Error("invalid_stage");
  const campaignId = input.campaignId === undefined ? undefined : await ownedCampaign(userId, input.campaignId);
  const contactUrl = input.contactUrl === undefined ? undefined : text(input.contactUrl, 2000);
  if (contactUrl && !isHttpUrl(contactUrl)) throw new Error("invalid_contact_url");
  const email = input.contactEmail === undefined ? undefined : text(input.contactEmail, 320);
  if (email && (!email.includes("@") || /\s/.test(email))) throw new Error("invalid_contact_email");
  const backlink = input.backlinkId === undefined && input.wonBacklinkUrl === undefined
    ? undefined
    : await ownedBacklink(userId, input.backlinkId, input.wonBacklinkUrl);
  const nextFollowUpAt = optionalDate(input.nextFollowUpAt);
  const lastContactAt = optionalDate(input.lastContactAt);
  const stageChanged = stage !== existing.stage;
  const now = new Date();

  return prisma.$transaction(async tx => {
    const updated = await tx.outreachProspect.update({
      where: { id },
      data: {
        stage,
        ...(campaignId === undefined ? {} : { campaignId }),
        ...(input.contactName === undefined ? {} : { contactName: text(input.contactName, 200) }),
        ...(email === undefined ? {} : { contactEmail: email }),
        ...(contactUrl === undefined ? {} : { contactUrl }),
        ...(input.contactSource === undefined ? {} : { contactSource: text(input.contactSource, 500) }),
        ...(input.pitchAngle === undefined ? {} : { pitchAngle: text(input.pitchAngle, 2000) }),
        ...(input.targetAsset === undefined ? {} : { targetAsset: text(input.targetAsset, 1000) }),
        ...(input.notes === undefined ? {} : { notes: text(input.notes, 5000) }),
        ...(nextFollowUpAt === undefined ? {} : { nextFollowUpAt }),
        ...(lastContactAt === undefined ? {} : { lastContactAt }),
        ...(stageChanged && stage === "contacted" && !existing.lastContactAt && lastContactAt === undefined ? { lastContactAt: now } : {}),
        ...(backlink === undefined ? {} : { backlinkId: backlink.id, wonBacklinkUrl: backlink.url }),
        ...(stageChanged && stage === "won" ? { wonAt: now } : stageChanged && existing.stage === "won" ? { wonAt: null } : {}),
      },
    });
    if (stageChanged) {
      await tx.outreachStageEvent.create({
        data: { prospectId: id, userId, fromStage: existing.stage, toStage: stage, note: text(input.stageNote, 1000) },
      });
    }
    return updated;
  });
}

export async function deleteOutreachProspect(userId: string, id: string) {
  const result = await prisma.outreachProspect.deleteMany({ where: { id, userId } });
  if (!result.count) throw new Error("prospect_not_found");
}
