// MCP tools for backlink toxicity / disavow (N2). Both are LOCAL/READ-ONLY over stored data:
// the classification run is the scheduler's and the button's job, not an agent's — it rewrites
// every donor row of a site, and an agent looping "recalculate" would churn the profile for
// nothing. The disavow decision itself has no tool on purpose: it is the operator's explicit
// PATCH, never something an assistant may set.

import { resolveSite, siteArg, lim, type Json, type McpTool } from "./shared";
import { backlinksNotMigrated, buildDisavowForSite, readToxicityOverview } from "@/lib/backlinks/store";

function notMigrated(hint: string) {
  return { notMigrated: true, hint };
}

export const BACKLINK_TOX_TOOLS: McpTool[] = [
  {
    name: "get_backlink_toxicity",
    cost: "local",
    readOnly: true,
    description:
      "Toxicity of the site's own backlink profile, judged for THE SITE'S NICHE: Site.backlinkNiche " +
      "names marker groups that are NOT toxic here (a casino anchor on a gambling site is a normal " +
      "topical link; pharma/adult/hack stay toxic). Returns the niche, the donor distribution " +
      "(clean/suspicious/toxic/unknown), the worst donors with their signal codes (marker groups from " +
      "the drops vocabulary plus sitewide_low_dr / out_of_content / donor_parked), and the " +
      "over-optimisation share of exact commercial anchors. LOCAL/READ-ONLY — it reads the last " +
      "classification run; recalculating is the UI button or the hourly scheduler.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        limit: { type: "number", description: "Max donor rows (default 100, max 500)" },
      },
      required: ["site"],
    },
    handler: async (userId, args: Json) => {
      const site = await resolveSite(userId, args.site);
      try {
        const overview = await readToxicityOverview(site.id);
        const limit = lim(args.limit, 100, 500);
        return { ...overview, donorRows: overview.donorRows.slice(0, limit) };
      } catch (error) {
        if (backlinksNotMigrated(error)) {
          return notMigrated("Run `npx prisma db push` to create the tox* columns on SiteBacklink.");
        }
        throw error;
      }
    },
  },
  {
    name: "get_disavow_file",
    cost: "local",
    readOnly: true,
    description:
      "The Google disavow file for the links the OPERATOR marked (PATCH /api/backlinks/disavow — " +
      "nothing is ever marked automatically). Returns the file text verbatim: header, one comment " +
      "line per donor with the reason (operator note or tox signals) and the link count, then " +
      "`domain:` lines for donors whose every link is marked — per-URL lines for partially marked " +
      "donors, or everywhere in urls mode. Upload target: " +
      "https://search.google.com/search-console/disavow-links. LOCAL/READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        mode: { type: "string", enum: ["domain", "urls"], description: "domain = domain: lines where the whole donor is marked (default); urls = individual URLs everywhere" },
      },
      required: ["site"],
    },
    handler: async (userId, args: Json) => {
      const site = await resolveSite(userId, args.site);
      const mode = args.mode === "urls" ? "urls" : "domain";
      try {
        const file = await buildDisavowForSite(site.id, mode);
        return { fileName: file.fileName, mode, donors: file.donors, links: file.links, text: file.text };
      } catch (error) {
        if (backlinksNotMigrated(error)) {
          return notMigrated("Run `npx prisma db push` to create the disavow columns on SiteBacklink.");
        }
        throw error;
      }
    },
  },
];
