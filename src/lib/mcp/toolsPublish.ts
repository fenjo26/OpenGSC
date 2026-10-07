// MCP tools for publishing (wave P1+P2) — the /publishing page as an agent surface.
//
// The heavy lifting is the SAME store the API routes run (lib/publish/store.ts) so the flows
// cannot drift. Costs: listing connections and posts is a local read; publish_post creates
// real posts on the user's blog ("net" — it leaves the server) and, with respin on, spends
// one cheap AI call per platform on the owner's respin slot, so the tool is marked "paid",
// names the spend in its description, and requires confirm: true before running the respin.
// Without respin it still creates live content — readOnly: false, like the rest of the
// mutating registry entries.

import { type McpTool, resolveSite, siteArg, lim, assertConfirmed, resolveAiCreds } from "./shared";
import { listConnections, listPosts, runPublish } from "@/lib/publish/store";

export const PUBLISH_TOOLS: McpTool[] = [
  {
    name: "publish_list_connections",
    cost: "local",
    readOnly: true,
    description:
      "The site's publishing connections (P1: WordPress) with platform, label, site URL, verification status (unverified | ok | error with the real lastError), lastVerifiedAt and a MASKED credential preview (first 3 chars). Full credentials are never returned. Free local read.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const connections = await listConnections(userId, site.id);
      return { site: site.url, connections };
    },
  },
  {
    name: "publish_post",
    cost: "paid",
    readOnly: false,
    idempotent: false,
    description:
      "Publish a post to the site's blog connections (P1: WordPress). Source is a SeoHistory record (historyId — text/landing types carry the body; find ids with get_generations) or literal title + markdown. Publishes to every connectionId from publish_list_connections, sequentially; each connection is independent — one failure does not abort the rest, and failed posts can be re-sent via the /publishing Retry (posts keep status publishing/published/failed with the platform's own error). With respin: true it first makes ONE CHEAP AI CALL PER PLATFORM on the instance's respin task slot to adapt tone/length while preserving facts, structure and links (needs confirm: true — it spends the owner's AI credits). Every successful publish feeds the existing backlink loop: a SiteBacklink row with source \"self\" pointing the new post's URL at the money-site link it contains.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        historyId: { type: "string", description: "SeoHistory id to publish (type text or landing)" },
        title: { type: "string", description: "Literal title when no historyId is given (or as a fallback body source)" },
        markdown: { type: "string", description: "Literal markdown body when no historyId is given" },
        connectionIds: { type: "array", items: { type: "string" }, description: "Connections to publish to, from publish_list_connections" },
        respin: { type: "boolean", description: "AI-adapt per platform first (one cheap call per platform; needs confirm)" },
        targetUrl: { type: "string", description: "Optional urlTo for the backlink row; defaults to the first money-site link in the post, else the site root" },
        confirm: { type: "boolean", description: "Must be true when respin is on — it spends the owner's AI credits." },
        aiProvider: { type: "string", description: "Override the respin AI provider for this call" },
        aiApiKey: { type: "string", description: "Override the respin AI key for this call" },
        model: { type: "string", description: "Override the respin model for this call" },
      },
      required: ["site", "connectionIds"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const connectionIds = (Array.isArray(args.connectionIds) ? args.connectionIds : [])
        .filter((v): v is string => typeof v === "string" && !!v);
      if (!connectionIds.length) throw new Error("connectionIds required (from publish_list_connections)");
      const respin = args.respin === true;
      if (respin) assertConfirmed(args, "publish_post with respin spends one AI call per platform on the respin task slot");
      const historyId = typeof args.historyId === "string" && args.historyId ? args.historyId : undefined;
      const title = typeof args.title === "string" && args.title ? args.title : undefined;
      const markdown = typeof args.markdown === "string" && args.markdown ? args.markdown : undefined;
      if (!historyId && !markdown) throw new Error("historyId or markdown required");
      // Same resolution order as the UI route: the "respin" task slot, with an explicit
      // agent-side override winning — resolveAiCreds(userId, args, task) implements both.
      const creds = respin
        ? await resolveAiCreds(userId, args, "respin")
        : { aiProvider: "", aiApiKey: "" };
      if (respin && !creds.aiApiKey) throw new Error("no_ai_creds: configure an AI provider for the respin task (Settings → SEO Tools)");
      const result = await runPublish(userId, site, {
        siteId: site.id,
        historyId, title, markdown,
        connectionIds,
        respin,
        targetUrl: typeof args.targetUrl === "string" && args.targetUrl.trim() ? args.targetUrl.trim() : undefined,
      }, creds);
      return result;
    },
  },
  {
    name: "publish_list_posts",
    cost: "local",
    readOnly: true,
    description:
      "Published posts of a site: title, connection, status (draft | publishing | published | failed with the platform error), remoteUrl, remoteId, whether the AI respin was used, timestamps. Free local read.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        page: { type: "number", description: "1-based page (default 1)" },
        pageSize: { type: "number", description: "rows per page, default 50, max 100" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      return await listPosts(userId, site.id, lim(args.page, 1, 10_000), lim(args.pageSize, 50, 100));
    },
  },
];
