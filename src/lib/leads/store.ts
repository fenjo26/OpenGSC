// N9 — lead persistence and the "new lead" notification.
//
// The public routes call createLead only after a one-time audit token was consumed, so a
// Lead row always corresponds to a real audit. ipHash arrives already salted+hashed
// (./ratelimit.ts) — the raw IP never reaches this module, the DB, or the notification.

import "server-only";
import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang, type NotifyLang } from "@/lib/notifyI18n";
import { localizeFindings } from "./i18n";
import { topFindings } from "./liteAudit";
import { LEAD_STATUSES, type LeadFinding, type LeadFull, type LeadLang, type LeadListItem, type LeadStatus, type LiteAuditReport } from "./types";

/** Same contract as drops/store.ts: a table missing before `db push` is a state, not a 500. */
export function leadsSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /Lead.*(does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

export class LeadStoreError extends Error {
  constructor(public readonly code: string) { super(code); }
}

type LeadRow = {
  id: string; userId: string; domain: string; email: string; name: string; message: string;
  score: number; findings: string; source: string; status: string; ipHash: string;
  origin: string; proposal: string | null; createdAt: Date; updatedAt: Date;
  orbitraCampaignId: number | null; orbitraAlias: string | null;
};

function parseFindings(raw: string): LeadFinding[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LeadFinding[]) : [];
  } catch {
    return [];
  }
}

function toListItem(row: LeadRow): LeadListItem {
  const findings = parseFindings(row.findings);
  return {
    id: row.id,
    domain: row.domain,
    email: row.email,
    name: row.name,
    message: row.message,
    score: row.score,
    top: topFindings(findings, 3).map(f => f.title),
    source: row.source,
    origin: row.origin,
    status: (LEAD_STATUSES as readonly string[]).includes(row.status) ? row.status as LeadStatus : "new",
    createdAt: row.createdAt.toISOString(),
    proposal: row.proposal,
    orbitraCampaignId: row.orbitraCampaignId ?? null,
    orbitraAlias: row.orbitraAlias ?? null,
  };
}

function toFull(row: LeadRow): LeadFull {
  return { ...toListItem(row), findings: parseFindings(row.findings) };
}

// ─── create (public contour) ──────────────────────────────────────────────────

export interface CreateLeadInput {
  userId: string;
  domain: string;
  email: string;
  name: string;
  message: string;
  origin: string;
  ipHash: string;
  lang: LeadLang;
  report: LiteAuditReport;
}

export async function createLead(input: CreateLeadInput): Promise<LeadFull> {
  const findings = localizeFindings(input.report.findings, input.lang);
  try {
    const row = await prisma.lead.create({
      data: {
        userId: input.userId,
        domain: input.domain,
        email: input.email,
        name: input.name,
        message: input.message,
        score: input.report.score,
        findings: JSON.stringify(findings),
        source: "widget",
        status: "new",
        ipHash: input.ipHash,
        origin: input.origin,
      },
    });
    void notifyNewLead({ ...input, leadId: row.id, findings, score: input.report.score });
    return toFull(row as unknown as LeadRow);
  } catch (error) {
    if (leadsSchemaMissing(error)) throw new LeadStoreError("notMigrated");
    throw error;
  }
}

/** Fire-and-forget owner notification on the `lead` channel (wave-nov event). */
async function notifyNewLead(input: CreateLeadInput & { leadId: string; findings: LeadFinding[]; score: number }): Promise<void> {
  try {
    const lang = await ownerNotifyLang(input.userId);
    const L = NOTIFY_L[lang];
    const top = topFindings(input.findings, 3).map(f => f.title).join("; ");
    const title = L.leadNewTitle(input.domain);
    const text = L.leadNewMsg(input.domain, input.email, input.score, top);
    await notifyUser(input.userId, text, { event: "lead", title });
  } catch (error) {
    console.warn("[leads] owner notification failed:", (error as Error)?.message ?? error);
  }
}

/** The owner's alert language (alertSettings.lang), read raw like the alert scheduler does. */
async function ownerNotifyLang(userId: string): Promise<NotifyLang> {
  try {
    const rows = await rawQuery<{ alertSettings?: string | null }[]>(
      `SELECT alertSettings FROM "User" WHERE id = ?`, userId,
    );
    const raw = rows?.[0]?.alertSettings;
    if (!raw) return "en";
    return normalizeLang((JSON.parse(raw) as { lang?: unknown }).lang);
  } catch {
    return "en";
  }
}

// ─── read (dashboard + MCP) ───────────────────────────────────────────────────

export interface LeadFilter {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// The Orbitra bridge writes here: the campaign reference on a won lead. Never set by the
// UI directly — only by /api/leads/[id]/orbitra after the tracker confirms creation.
export async function setLeadOrbitra(
  userId: string,
  id: string,
  ref: { campaignId: number | null; alias: string },
): Promise<LeadFull | null> {
  const hit = await prisma.lead.updateMany({
    where: { id, userId },
    data: { orbitraCampaignId: ref.campaignId, orbitraAlias: ref.alias },
  });
  if (hit.count === 0) return null;
  return getLead(userId, id);
}

export async function listLeads(userId: string, filter: LeadFilter): Promise<{ leads: LeadListItem[]; total: number; notMigrated?: boolean }> {
  const status = filter.status && (LEAD_STATUSES as readonly string[]).includes(filter.status) ? filter.status : undefined;
  const q = (filter.q ?? "").trim();
  const where = {
    userId,
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ domain: { contains: q } }, { email: { contains: q } }, { name: { contains: q } }] } : {}),
  };
  try {
    const [rows, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(200, Math.max(1, filter.limit ?? 50)),
        skip: Math.max(0, filter.offset ?? 0),
      }),
      prisma.lead.count({ where }),
    ]);
    return { leads: rows.map(row => toListItem(row as unknown as LeadRow)), total };
  } catch (error) {
    if (leadsSchemaMissing(error)) return { leads: [], total: 0, notMigrated: true };
    throw error;
  }
}

export async function getLead(userId: string, id: string): Promise<LeadFull | null> {
  try {
    const row = await prisma.lead.findFirst({ where: { id, userId } });
    return row ? toFull(row as unknown as LeadRow) : null;
  } catch (error) {
    if (leadsSchemaMissing(error)) return null;
    throw error;
  }
}

export async function updateLead(
  userId: string,
  id: string,
  patch: { status?: string; proposal?: string },
): Promise<LeadFull> {
  const data: { status?: string; proposal?: string } = {};
  if (patch.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(patch.status)) throw new LeadStoreError("invalid_status");
    data.status = patch.status;
  }
  if (patch.proposal !== undefined) data.proposal = String(patch.proposal).slice(0, 60_000);
  try {
    // findFirst on {id, userId} FIRST: an update-then-check would write another workspace's row.
    const existing = await prisma.lead.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) throw new LeadStoreError("not_found");
    const row = await prisma.lead.update({ where: { id }, data });
    return toFull(row as unknown as LeadRow);
  } catch (error) {
    if (error instanceof LeadStoreError) throw error;
    if (leadsSchemaMissing(error)) throw new LeadStoreError("notMigrated");
    throw error;
  }
}
