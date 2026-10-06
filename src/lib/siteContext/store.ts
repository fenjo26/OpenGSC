// Site context (Project Memory) — the shared AI context per site.
//
// Adapted in design from OpenSEO's "Project memory" spec (every-app/open-seo, MIT): one
// store, read first by every agent surface, writable back by them, inspectable by the
// operator. The deviations from the port: our unit is the site (not their "project"), the
// competitor list is Site.aeoCompetitors — already shared with AI share of voice, so there
// is one list and not two — and the research log exists to stop re-buying paid research,
// which our own caches only half-cover (a cache answers "was this exact call made", never
// "what did we conclude").
//
// Every read degrades to the empty context before `prisma db push` (the post-initial-schema
// convention): the feature is absent, not broken. Every write validates and caps before it
// touches the database, because both writers — the UI and the MCP tool — pass through here.

import { prisma } from "@/lib/prisma";
import { rawExec } from "@/lib/db/raw";
import { hostOf } from "@/lib/seo/aeo";
import type { AiCompetitor } from "@/lib/visibility/types";

// ─── vocabulary + caps ─────────────────────────────────────────────────────────

export const TYPED_SECTION_KEYS = ["business_overview", "current_goal", "positioning", "writing_preferences"] as const;
export type TypedSectionKey = (typeof TYPED_SECTION_KEYS)[number];

export const SECTION_LABELS: Record<TypedSectionKey, string> = {
  business_overview: "Business overview",
  current_goal: "Current goal",
  positioning: "Positioning",
  writing_preferences: "Writing preferences",
};

export const KEY_PAGE_ROLES = ["money", "hub", "spoke", "other"] as const;
export type KeyPageRole = (typeof KEY_PAGE_ROLES)[number];

export const SECTION_MAX_CHARS = 4_000;
export const CUSTOM_SECTION_MAX = 20;
export const COMPETITOR_MAX = 10;   // same cap as AI share of voice — one list, one ceiling
export const KEY_PAGE_MAX = 100;
export const RESEARCH_LOG_DAYS = 90;
export const RESEARCH_LOG_RETURN = 50;

export function isTypedSectionKey(v: unknown): v is TypedSectionKey {
  return typeof v === "string" && (TYPED_SECTION_KEYS as readonly string[]).includes(v);
}

function isCustomKey(v: string): boolean {
  return /^custom:[a-z0-9][a-z0-9-]{0,63}$/.test(v);
}

/** Prisma P2025/P2021 — the Site context tables are missing, i.e. `npx prisma db push` has not
 *  run on this instance yet. Readers translate this to the empty context per the wave rules. */
export function contextTablesMissing(e: unknown): boolean {
  const v = e as { code?: string; message?: string } | undefined;
  if (v?.code === "P2021" || v?.code === "P2022" || v?.code === "P2023") return true;
  return /SiteContextSection|SiteKeyPage|SiteResearchLog.*(does not exist|no such table)/i
    .test(String(v?.message ?? ""));
}

// ─── normalization ─────────────────────────────────────────────────────────────

/** Key page identity: a path is kept relative to the site ("/pricing"), an absolute URL is
 *  normalized to host+path — so the operator's "/pricing" and the agent's absolute URL meet
 *  on one row instead of fighting over the unique key. */
export function normalizeKeyPageUrl(input: string, siteHost = ""): string {
  let u = String(input ?? "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) {
    try { const p = new URL(u); u = p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/+$/, "") + p.search; }
    catch { return ""; }
  } else {
    if (!u.startsWith("/")) u = "/" + u;
    u = u.replace(/\/+$/, "") || "/";
    if (siteHost) u = siteHost.replace(/^www\./, "") + u;
  }
  return u.slice(0, 500);
}

export function normalizeCompetitorDomain(raw: string): string {
  return hostOf(String(raw ?? ""));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "section";
}

// ─── the context shape ─────────────────────────────────────────────────────────

export interface ContextSection {
  key: string;
  title: string;
  content: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ContextKeyPage {
  id: string;
  url: string;
  role: KeyPageRole | string;
  topic: string;
  notes: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ContextResearchEntry {
  id: string;
  entryDate: string;
  summary: string;
  createdBy: string;
}

export interface SiteContext {
  siteId: string;
  siteDomain: string;
  sections: ContextSection[];
  /** typed keys with no content yet — the agent's to-do list, and the reason it knows what
   *  to ask instead of re-interviewing everything */
  missingSections: string[];
  competitors: AiCompetitor[];
  keyPages: ContextKeyPage[];
  researchLog: ContextResearchEntry[];
}

export async function getSiteContext(siteId: string): Promise<SiteContext> {
  const empty: SiteContext = {
    siteId, siteDomain: "", sections: [], missingSections: [...TYPED_SECTION_KEYS],
    competitors: [], keyPages: [], researchLog: [],
  };
  try {
    const [site, sections, keyPages, log] = await Promise.all([
      prisma.site.findUnique({ where: { id: siteId }, select: { url: true, aeoCompetitors: true } }),
      prisma.siteContextSection.findMany({ where: { siteId } }),
      prisma.siteKeyPage.findMany({ where: { siteId }, orderBy: { url: "asc" } }),
      prisma.siteResearchLog.findMany({
        where: { siteId }, orderBy: { createdAt: "desc" }, take: RESEARCH_LOG_RETURN,
      }),
    ]);
    if (!site) return empty;
    let competitors: AiCompetitor[] = [];
    try {
      const parsed = JSON.parse(site.aeoCompetitors ?? "[]");
      if (Array.isArray(parsed)) competitors = parsed;
    } catch { /* an unreadable list reads as none */ }
    const filled = new Set(sections.filter(s => s.content.trim()).map(s => s.key));
    return {
      siteId,
      siteDomain: hostOf(site.url),
      sections: sections.map(s => ({
        key: s.key,
        title: s.title || (isTypedSectionKey(s.key) ? SECTION_LABELS[s.key] : s.key),
        content: s.content,
        updatedBy: s.updatedBy,
        updatedAt: s.updatedAt.toISOString(),
      })),
      missingSections: TYPED_SECTION_KEYS.filter(k => !filled.has(k)),
      competitors,
      keyPages: keyPages.map(p => ({
        id: p.id, url: p.url, role: p.role, topic: p.topic, notes: p.notes,
        updatedBy: p.updatedBy, updatedAt: p.updatedAt.toISOString(),
      })),
      researchLog: log.map(e => ({ id: e.id, entryDate: e.entryDate, summary: e.summary, createdBy: e.createdBy })),
    };
  } catch (e) {
    if (contextTablesMissing(e)) return empty;
    throw e;
  }
}

/** The markdown digest an agent actually reads: everything, in reading order, with the
 *  gaps named. Kept pure — the MCP text block and any future surface render the same text. */
export function renderContextMarkdown(ctx: SiteContext): string {
  const lines: string[] = [`# Site context: ${ctx.siteDomain || ctx.siteId}`];
  for (const key of TYPED_SECTION_KEYS) {
    const s = ctx.sections.find(x => x.key === key);
    lines.push(`\n## ${SECTION_LABELS[key]}`);
    lines.push(s?.content.trim() ? s.content.trim() : "_(empty)_");
  }
  const customs = ctx.sections.filter(s => s.key.startsWith("custom:"));
  for (const s of customs) {
    lines.push(`\n## ${s.title || s.key}`);
    lines.push(s.content.trim() || "_(empty)_");
  }
  lines.push(`\n## Competitors`);
  lines.push(ctx.competitors.length
    ? ctx.competitors.map(c => `- ${c.name}${c.domain ? ` (${c.domain})` : ""}${c.notes ? ` — ${c.notes}` : ""}`).join("\n")
    : "_(none saved)_");
  lines.push(`\n## Key pages`);
  lines.push(ctx.keyPages.length
    ? ctx.keyPages.map(p => `- ${p.url} [${p.role}]${p.topic ? ` — targets "${p.topic}"` : ""}${p.notes ? ` — ${p.notes}` : ""}`).join("\n")
    : "_(none saved)_");
  lines.push(`\n## Research log (newest first, 30-day reuse rule)`);
  lines.push(ctx.researchLog.length
    ? ctx.researchLog.map(e => `- ${e.entryDate} ${e.summary}`).join("\n")
    : "_(empty — no paid research recorded)_");
  if (ctx.missingSections.length) {
    lines.push(`\nMissing sections: ${ctx.missingSections.join(", ")} — fill via update_site_context (or ask the operator) before relying on them.`);
  }
  return lines.join("\n");
}

// ─── updates ───────────────────────────────────────────────────────────────────

export type ContextPatchOp =
  | { section: string; content: string; title?: string }
  | { deleteCustomSection: string }
  | { addCompetitors: Array<{ name: string; domain?: string; notes?: string; terms?: string[] }> }
  | { removeCompetitors: string[] }
  | { addKeyPages: Array<{ url: string; role?: string; topic?: string; notes?: string }> }
  | { removeKeyPages: string[] }
  | { appendResearchLog: { summary: string } }
  | { removeResearchLog: string[] };

export interface AppliedUpdate {
  applied: number;
  skipped: string[];
}

/**
 * Apply a batch of patch ops. One bad op skips itself with a reason in `skipped` — a batch
 * from an agent must not die on its first typo, and the caller shows the skips, so nothing
 * fails silently. `who` records provenance ("user" from the UI, "mcp" from the tool).
 */
export async function applyContextUpdates(
  siteId: string,
  updates: unknown[],
  who: "user" | "mcp",
): Promise<AppliedUpdate> {
  const out: AppliedUpdate = { applied: 0, skipped: [] };
  if (!Array.isArray(updates) || updates.length === 0) return out;
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, url: true, aeoCompetitors: true } });
  if (!site) throw new Error("site_not_found");
  const siteHost = hostOf(site.url);

  const tableMissing = (e: unknown): boolean => {
    if (contextTablesMissing(e)) { out.skipped.push("context tables not migrated — run prisma db push"); return true; }
    return false;
  };

  for (const raw of updates) {
    const op = raw as Record<string, unknown>;
    try {
      if (typeof op.section === "string") {
        const key = op.section;
        const content = String(op.content ?? "").slice(0, SECTION_MAX_CHARS);
        if (isTypedSectionKey(key)) {
          await prisma.siteContextSection.upsert({
            where: { siteId_key: { siteId, key } },
            create: { siteId, key, content, updatedBy: who },
            update: { content, updatedBy: who },
          });
          out.applied++;
        } else if (isCustomKey(key) || key.startsWith("custom:")) {
          const safeKey = key.startsWith("custom:") && isCustomKey(key) ? key : `custom:${slugify(key.replace(/^custom:?/, ""))}`;
          if (!content.trim()) {
            // An emptied custom section is deleted, not kept as an empty husk.
            await prisma.siteContextSection.deleteMany({ where: { siteId, key: safeKey } });
            out.applied++;
          } else {
            const title = String(op.title ?? safeKey.replace(/^custom:/, "")).slice(0, 80);
            await prisma.siteContextSection.upsert({
              where: { siteId_key: { siteId, key: safeKey } },
              create: { siteId, key: safeKey, title, content, updatedBy: who },
              update: { title, content, updatedBy: who },
            });
            const customs = await prisma.siteContextSection.count({ where: { siteId, key: { startsWith: "custom:" } } });
            if (customs > CUSTOM_SECTION_MAX) {
              await prisma.siteContextSection.delete({ where: { siteId_key: { siteId, key: safeKey } } });
              out.skipped.push(`custom section cap (${CUSTOM_SECTION_MAX}) reached`);
              continue;
            }
            out.applied++;
          }
        } else {
          out.skipped.push(`unknown section key "${key.slice(0, 40)}"`);
        }
      } else if (typeof op.deleteCustomSection === "string") {
        const key = op.deleteCustomSection;
        if (!key.startsWith("custom:")) { out.skipped.push("deleteCustomSection refuses typed keys"); continue; }
        await prisma.siteContextSection.deleteMany({ where: { siteId, key } });
        out.applied++;
      } else if (Array.isArray(op.addCompetitors)) {
        let list: AiCompetitor[] = [];
        try { list = JSON.parse(site.aeoCompetitors ?? "[]"); } catch { /* unreadable reads as none */ }
        if (!Array.isArray(list)) list = [];
        for (const c of op.addCompetitors) {
          const name = String((c as AiCompetitor)?.name ?? "").trim().slice(0, 80);
          if (!name) { out.skipped.push("competitor without a name"); continue; }
          const domain = normalizeCompetitorDomain(String((c as AiCompetitor)?.domain ?? ""));
          const keyOf = (x: AiCompetitor) => (x.domain || x.name).toLowerCase();
          const entry: AiCompetitor = {
            name,
            domain,
            terms: Array.isArray((c as AiCompetitor).terms)
              ? (c as AiCompetitor).terms.map(t => String(t).trim().slice(0, 80)).filter(Boolean).slice(0, 10)
              : [name],
            ...(String((c as AiCompetitor).notes ?? "").trim().slice(0, 200) ? { notes: String((c as AiCompetitor).notes ?? "").trim().slice(0, 200) } : {}),
          };
          // Upsert by domain when it exists, by name otherwise (a rival with no site).
          const idx = list.findIndex(x => keyOf(x) === keyOf(entry));
          if (idx >= 0) list[idx] = { ...list[idx], ...entry };
          else if (list.length >= COMPETITOR_MAX) { out.skipped.push(`competitor cap (${COMPETITOR_MAX}) reached`); continue; }
          else list.push(entry);
        }
        // Written immediately via raw SQL (portableSql rewrites the quoting per dialect): the
        // competitor list belongs to Site, and a prisma site.update validates every model
        // column — more machine than this one field deserves. The local copy stays in sync so
        // a later removeCompetitors in the SAME batch sees this batch's adds.
        site.aeoCompetitors = JSON.stringify(list);
        await rawExec(`UPDATE "Site" SET "aeoCompetitors" = ? WHERE "id" = ?`, site.aeoCompetitors, siteId);
        out.applied++;
      } else if (Array.isArray(op.removeCompetitors)) {
        let list: AiCompetitor[] = [];
        try { list = JSON.parse(site.aeoCompetitors ?? "[]"); } catch { /* as above */ }
        const gone = new Set(op.removeCompetitors.map((d: unknown) => String(d ?? "").toLowerCase()));
        const kept = list.filter(x => !gone.has(x.domain.toLowerCase()) && !gone.has(x.name.toLowerCase()));
        if (kept.length !== list.length) {
          site.aeoCompetitors = JSON.stringify(kept);
          await rawExec(`UPDATE "Site" SET "aeoCompetitors" = ? WHERE "id" = ?`, site.aeoCompetitors, siteId);
        }
        out.applied++;
      } else if (Array.isArray(op.addKeyPages)) {
        for (const p of op.addKeyPages) {
          const url = normalizeKeyPageUrl(String((p as ContextKeyPage)?.url ?? ""), siteHost);
          if (!url) { out.skipped.push("key page without a url"); continue; }
          const role = KEY_PAGE_ROLES.includes((p as { role?: string })?.role as KeyPageRole) ? (p as { role: KeyPageRole }).role : "other";
          const topic = String((p as ContextKeyPage)?.topic ?? "").slice(0, 200);
          const notes = String((p as ContextKeyPage)?.notes ?? "").slice(0, 300);
          const count = await prisma.siteKeyPage.count({ where: { siteId } });
          const exists = await prisma.siteKeyPage.findUnique({ where: { siteId_url: { siteId, url } } });
          if (!exists && count >= KEY_PAGE_MAX) { out.skipped.push(`key page cap (${KEY_PAGE_MAX}) reached`); continue; }
          await prisma.siteKeyPage.upsert({
            where: { siteId_url: { siteId, url } },
            create: { siteId, url, role, topic, notes, updatedBy: who },
            update: { role, topic, notes, updatedBy: who },
          });
        }
        out.applied++;
      } else if (Array.isArray(op.removeKeyPages)) {
        for (const u of op.removeKeyPages) {
          const url = normalizeKeyPageUrl(String(u ?? ""), siteHost);
          if (url) await prisma.siteKeyPage.deleteMany({ where: { siteId, url } });
        }
        out.applied++;
      } else if (op.appendResearchLog && typeof (op.appendResearchLog as { summary?: unknown }).summary === "string") {
        const summary = String((op.appendResearchLog as { summary: string }).summary).trim().slice(0, 500);
        if (!summary) { out.skipped.push("empty research log entry"); continue; }
        await prisma.siteResearchLog.create({
          data: { siteId, entryDate: new Date().toISOString().slice(0, 10), summary, createdBy: who },
        });
        // The log is a working memory, not an archive: appending prunes past RESEARCH_LOG_DAYS.
        await prisma.siteResearchLog.deleteMany({
          where: { siteId, createdAt: { lt: new Date(Date.now() - RESEARCH_LOG_DAYS * 86_400_000) } },
        });
        out.applied++;
      } else if (Array.isArray(op.removeResearchLog)) {
        await prisma.siteResearchLog.deleteMany({ where: { siteId, id: { in: op.removeResearchLog.map(String) } } });
        out.applied++;
      } else {
        out.skipped.push(`unrecognized op: ${JSON.stringify(op).slice(0, 80)}`);
      }
    } catch (e) {
      if (tableMissing(e)) return out;
      out.skipped.push(String((e as Error)?.message ?? e).slice(0, 120));
    }
  }
  return out;
}
