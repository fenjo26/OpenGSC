// MCP tools for site context (Project Memory): the shared AI context per site.
//
// get_site_context is designed to be an agent's FIRST call for a site — free, local, and the
// reason it does not re-interview the user. update_site_context is the write-back: sections,
// competitors (the same list AI share of voice reads), key pages, and the research log whose
// 30-day reuse rule stops re-buying paid research. The Context card in the site's settings
// tab writes through the same store, so the operator can inspect and correct everything.

import { type McpTool, type Json } from "./shared";
import { resolveSite } from "./shared";
import { getSiteContext, renderContextMarkdown, applyContextUpdates } from "@/lib/siteContext/store";

const PATCH_OPS_DESC = `updates: an array of patch ops —
{ section, content, title? } — set a typed section (business_overview | current_goal | positioning | writing_preferences) or a custom one (key "custom:<slug>"; empty content deletes it)
{ deleteCustomSection: "custom:<slug>" }
{ addCompetitors: [{ name, domain?, notes?, terms? }] } — upsert by domain (or name when no site); same list AI share of voice uses
{ removeCompetitors: [domainOrName] }
{ addKeyPages: [{ url, role?: money|hub|spoke|other, topic?, notes? }] } — upsert by url; a curated shortlist, not a sitemap inventory
{ removeKeyPages: [url] }
{ appendResearchLog: { summary } } — "<what>: <inputs>. Verdict: <conclusion>"; the server stamps the date and prunes past 90 days
{ removeResearchLog: [id] }`;

export const CONTEXT_TOOLS: McpTool[] = [
  {
    name: "get_site_context",
    cost: "local",
    readOnly: true,
    description:
      "The site's shared AI context (Project Memory): business overview, current goal, positioning, writing preferences, custom sections, the competitor list (same as AI share of voice), key pages (money/hub/spoke) and the research log. Call this FIRST for any site work — it grounds every workflow and its missingSections list tells you what to fill instead of re-interviewing the user. The research log's rule: if the same research ran within the last 30 days, reuse that result and say so — do not re-buy it. Free, local; empty (not an error) before the context tables are migrated.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site — id, exact URL, or domain substring" },
      },
      required: ["site"],
    },
    handler: async (userId: string, args: Json) => {
      const site = await resolveSite(userId, args.site);
      if (!site) return { error: "site_not_found" };
      const ctx = await getSiteContext(site.id);
      return {
        siteId: ctx.siteId,
        siteDomain: ctx.siteDomain,
        missingSections: ctx.missingSections,
        sections: ctx.sections,
        competitors: ctx.competitors,
        keyPages: ctx.keyPages,
        researchLog: ctx.researchLog,
        markdown: renderContextMarkdown(ctx),
      };
    },
  },
  {
    name: "update_site_context",
    cost: "local",
    readOnly: false,
    idempotent: true,
    description:
      "Write back to the site's shared AI context (Project Memory) — the same store get_site_context reads and the Context card in the site's settings tab edits. Use it for durable learnings (positioning the user explained, competitors worth tracking, pages that matter, writing preferences) and to append a research-log entry whenever a session spent paid units. One bad op skips itself with a reason in `skipped`; the rest of the batch still applies.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site — id, exact URL, or domain substring" },
        updates: { type: "array", description: PATCH_OPS_DESC, items: { type: "object" } },
      },
      required: ["site", "updates"],
    },
    handler: async (userId: string, args: Json) => {
      const site = await resolveSite(userId, args.site);
      if (!site) return { error: "site_not_found" };
      const updates = Array.isArray(args.updates) ? args.updates : [];
      if (!updates.length) return { error: "updates must be a non-empty array of patch ops" };
      const result = await applyContextUpdates(site.id, updates, "mcp");
      return result;
    },
  },
];
