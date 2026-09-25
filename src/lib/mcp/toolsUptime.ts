// MCP tools for the uptime monitor (T2): one read-only tool mirroring what the dashboard and
// the site Health tab show. Everything here is local database state — checks were already made
// and stored by the scheduler — so the cost is "local" and nothing reaches the network.

import { type McpTool } from "./shared";
import { prisma } from "@/lib/prisma";
import { uptimeBadges, uptimeSchemaMissing, uptimeSummary } from "@/lib/uptime/store";
import type { UptimeBadge } from "@/lib/uptime/types";

/** Resolve the `site` argument: a Site row id, a GSC property ("sc-domain:example.com" or a
 *  URL property), a bare domain, or the Site.url value. Returns the row id or null. */
async function resolveSiteId(userId: string, site: string): Promise<string | null> {
  const byId = await prisma.site.findFirst({ where: { id: site, userId }, select: { id: true } });
  if (byId) return byId.id;
  const rows = await prisma.site.findMany({
    where: { userId },
    select: { id: true, siteId: true, url: true },
    take: 500,
  });
  const needle = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const hit = rows.find(r =>
    r.siteId.toLowerCase() === site ||
    r.siteId.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") === needle ||
    (r.url ?? "").toLowerCase() === needle ||
    (r.url ?? "").toLowerCase().replace(/^www\./, "") === needle.replace(/^www\./, ""),
  );
  return hit?.id ?? null;
}

export const UPTIME_TOOLS: McpTool[] = [
  {
    name: "get_uptime",
    cost: "local",
    readOnly: true,
    description:
      "Uptime monitor: without `site`, the status of every monitored site of the workspace (status up | degraded | down | unknown | paused | checker_offline, current since, last latency ms, 24 h uptime %, last error — plus the site domain). With `site` (Site id, GSC property, or domain), the full summary of one monitor: settings, uptime % over 24 h / 7 / 30 / 90 days, 30-day latency series and the last 20 incidents with causes. checker_offline means the OpenGSC server itself could not reach the network on its last pass — the sites are not known to be down.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "one site: Site row id, GSC property (sc-domain:example.com or URL), or bare domain" },
      },
    },
    handler: async (userId, args) => {
      try {
        if (typeof args.site === "string" && args.site.trim()) {
          const siteId = await resolveSiteId(userId, args.site.trim());
          if (!siteId) return { error: "site_not_found" };
          const summary = await uptimeSummary(userId, siteId);
          return summary ?? { monitor: null };
        }
        const badges = await uptimeBadges(userId);
        const sites = await prisma.site.findMany({ where: { userId }, select: { id: true, siteId: true, url: true }, take: 500 });
        const domainOf = new Map(sites.map(s => [s.id, s.siteId.startsWith("sc-domain:") ? s.siteId.slice("sc-domain:".length) : (s.url ?? s.siteId)]));
        const rows: (UptimeBadge & { domain: string | null })[] = badges.map(b => ({ ...b, domain: domainOf.get(b.siteId) ?? null }));
        return { badges: rows };
      } catch (e) {
        if (uptimeSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
];
