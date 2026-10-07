// MCP tools for publishing (wave P1+P2, hardened in R+) — the /publishing page as an agent
// surface.
//
// The heavy lifting is the SAME store the API routes run (lib/publish/store.ts) so the flows
// cannot drift. Costs: listing connections and posts is a local read; publish_post creates
// real posts on the user's blog ("net" — it leaves the server) and, with respin on, spends
// one cheap AI call per platform on the owner's respin slot, so the tool is marked "paid",
// names the spend in its description, and requires confirm: true before running the respin.
// Without respin it still creates live content — readOnly: false, like the rest of the
// mutating registry entries.
//
// R+ server rules that apply to the agent exactly like to the UI (enforced in the store,
// not here): respin only for external_platform connections; a uniqueness gate that runs at
// SEND time against every published post of the instance (block names the twin post, there
// is deliberately no force/bypass parameter); a spread window that defers posts as
// "scheduled" with a random offset, sent later by the scheduler through the same gated path.

import { type McpTool, resolveSite, siteArg, lim, assertConfirmed, resolveAiCreds } from "./shared";
import { listConnections, listPosts, runPublish, parseWindowMs, type PublishItem } from "@/lib/publish/store";

export const PUBLISH_TOOLS: McpTool[] = [
  {
    name: "publish_list_connections",
    cost: "local",
    readOnly: true,
    description:
      "The site's publishing connections (P1: WordPress) with platform, connectionType (own_satellite | money_site | external_platform — respin is allowed ONLY for external_platform), label, site URL, verification status (unverified | ok | error with the real lastError), lastVerifiedAt and a MASKED credential preview (first 3 chars). Full credentials are never returned. Free local read.",
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
      "Publish a post to the site's blog connections (P1: WordPress). Source is a SeoHistory record (historyId — text/landing types carry the body; find ids with get_generations) or literal title + markdown; for own-satellite networks pass items[] and give EACH connectionId its own source (own historyId or title+markdown) so every satellite carries its own post. Publishes to every connection, sequentially; each connection is independent — one failure does not abort the rest. Respin (respin: true, needs confirm) adapts the text with one cheap AI call per platform and is allowed ONLY for external_platform connections — for anything else the post is refused with respin_not_allowed_for_own_satellite. At SEND time every post passes a uniqueness gate: its text is compared (analyze_text's trigram-Jaccard engine) against every published post of the WHOLE instance (latest 300); maxSimilarity ≥ 0.3 → the post is created with status \"blocked\" and an error naming the twin post (no bypass exists — publish a genuinely different text); 0.15–0.3 → it publishes with the score surfaced. uniquenessScore (1 − maxSimilarity) is stored on every sent post. windowHours or windowDays (never both) defers the batch instead: posts are created as \"scheduled\" with a random offset inside the window (the scheduler sends them later through the same gated path — for a deferred respin the AI call happens at send time). The response carries per-post status/scores, an anchorSummary (money-site anchor distribution across this batch, repeated exact anchors flagged) and honest footprint warnings (shared title skeletons, repeated anchors, clustered schedule times). Failed or blocked posts can be re-sent via the /publishing Retry — the gate re-runs. Every successful publish feeds the existing backlink loop: a SiteBacklink row with source \"self\" pointing the new post's URL at the money-site link it contains.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        historyId: { type: "string", description: "SeoHistory id to publish (type text or landing) — flat form, one source for every connection" },
        title: { type: "string", description: "Literal title when no historyId is given (or as a fallback body source)" },
        markdown: { type: "string", description: "Literal markdown body when no historyId is given" },
        connectionIds: { type: "array", items: { type: "string" }, description: "Connections to publish to (flat form), from publish_list_connections" },
        items: {
          type: "array",
          description: "Per-connection sources (own-satellite form): [{connectionId, historyId | title + markdown}] — each connection publishes its own post. Takes precedence over the flat form.",
          items: {
            type: "object",
            properties: {
              connectionId: { type: "string" },
              historyId: { type: "string" },
              title: { type: "string" },
              markdown: { type: "string" },
            },
            required: ["connectionId"],
          },
        },
        respin: { type: "boolean", description: "AI-adapt per external_platform connection first (one cheap call each; needs confirm; refused for own_satellite/money_site connections)" },
        windowHours: { type: "number", description: "Defer the batch with a random offset within N hours (posts created as \"scheduled\"; sent later, gated at send time). Mutually exclusive with windowDays" },
        windowDays: { type: "number", description: "Same as windowHours, in days" },
        targetUrl: { type: "string", description: "Optional urlTo for the backlink row; defaults to the first money-site link in the post, else the site root" },
        confirm: { type: "boolean", description: "Must be true when respin is on — it spends the owner's AI credits." },
        aiProvider: { type: "string", description: "Override the respin AI provider for this call" },
        aiApiKey: { type: "string", description: "Override the respin AI key for this call" },
        model: { type: "string", description: "Override the respin model for this call" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      const site = await resolveSite(userId, args.site);
      const connectionIds = (Array.isArray(args.connectionIds) ? args.connectionIds : [])
        .filter((v): v is string => typeof v === "string" && !!v);
      const items: PublishItem[] | undefined = Array.isArray(args.items)
        ? (args.items as Record<string, unknown>[]).map(i => ({
          connectionId: String(i?.connectionId ?? ""),
          historyId: typeof i?.historyId === "string" && i.historyId ? i.historyId : undefined,
          title: typeof i?.title === "string" && i.title ? i.title : undefined,
          markdown: typeof i?.markdown === "string" && i.markdown ? i.markdown : undefined,
        })).filter(i => i.connectionId)
        : undefined;
      if (!connectionIds.length && !items?.length) throw new Error("connectionIds or items required (from publish_list_connections)");
      const respin = args.respin === true;
      let windowMs: number | null = null;
      windowMs = parseWindowMs({
        windowHours: typeof args.windowHours === "number" ? args.windowHours : undefined,
        windowDays: typeof args.windowDays === "number" ? args.windowDays : undefined,
      });
      // Confirm is demanded whenever respin is on, immediate OR deferred: a deferred respin
      // is still a committed future spend (the scheduler makes the call at send time), and
      // "later" is not a reason the owner's confirmation should stop being required.
      if (respin) assertConfirmed(args, "publish_post with respin spends one AI call per platform on the respin task slot (immediately, or at send time when a spread window defers it)");
      const historyId = typeof args.historyId === "string" && args.historyId ? args.historyId : undefined;
      const title = typeof args.title === "string" && args.title ? args.title : undefined;
      const markdown = typeof args.markdown === "string" && args.markdown ? args.markdown : undefined;
      if (!items?.length && !historyId && !markdown) throw new Error("historyId or markdown required (or items[] with per-connection sources)");
      // Same resolution order as the UI route: the "respin" task slot, with an explicit
      // agent-side override winning — resolveAiCreds(userId, args, task) implements both.
      // Deferred (scheduled) posts do not need creds here: the scheduler re-resolves at send.
      const creds = respin && windowMs == null
        ? await resolveAiCreds(userId, args, "respin")
        : { aiProvider: "", aiApiKey: "" };
      if (respin && windowMs == null && !creds.aiApiKey) throw new Error("no_ai_creds: configure an AI provider for the respin task (Settings → SEO Tools)");
      return await runPublish(userId, site, {
        siteId: site.id,
        historyId, title, markdown,
        connectionIds,
        items,
        respin,
        targetUrl: typeof args.targetUrl === "string" && args.targetUrl.trim() ? args.targetUrl.trim() : undefined,
        windowHours: typeof args.windowHours === "number" ? args.windowHours : undefined,
        windowDays: typeof args.windowDays === "number" ? args.windowDays : undefined,
      }, creds);
    },
  },
  {
    name: "publish_list_posts",
    cost: "local",
    readOnly: true,
    description:
      "Published posts of a site: title, connection, status (draft | scheduled | publishing | published | failed | blocked with the gate's twin-naming error), remoteUrl, remoteId, whether a respin was used (for scheduled posts: planned, runs at send time), scheduledAt (due time of a deferred post), uniquenessScore (1 − max similarity vs the instance's published set at send time; null = not yet sent through the gate), timestamps. Free local read.",
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
