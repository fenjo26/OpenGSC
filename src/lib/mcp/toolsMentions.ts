// MCP tools for brand mentions (T6, CONTRACT §5). Read-only views over the local feed: the
// fetching itself is the daily watcher's job, not an agent's — Google News and Wikipedia are
// free but rate-limited, and an agent looping "run now" would read like a bot to both.

import { resolveSite, siteArg, lim, type Json, type McpTool } from "./shared";
import { listMentions } from "@/lib/mentions/store";
import type { MentionQuery } from "@/lib/mentions/types";

const SOURCE_ENUM = ["news", "wikipedia", "wikidata", "all"];
const STATE_ENUM = ["new", "reviewed", "dismissed", "all"];
const LINK_ENUM = ["unchecked", "linked", "unlinked", "unreachable", "all"];

function pickEnum(value: unknown, allowed: string[]): string | undefined {
  const v = String(value ?? "").trim();
  return allowed.includes(v) ? v : undefined;
}

export const MENTIONS_TOOLS: McpTool[] = [
  {
    name: "get_brand_mentions",
    cost: "local",
    readOnly: true,
    description:
      "Brand mentions feed for one site: where the brand was mentioned in Google News, Wikipedia and Wikidata. " +
      "LOCAL/READ-ONLY — returns rows already stored; it does not fetch. Mentions are collected by the daily watcher " +
      "(or the Mentions panel's check-now). linkStatus 'unlinked' marks an unlinked mention — the cheapest link-building target.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteArg,
        source: { type: "string", enum: SOURCE_ENUM, description: "Filter by source (default all)" },
        state: { type: "string", enum: STATE_ENUM, description: "new = not yet reviewed (default all)" },
        linkStatus: { type: "string", enum: LINK_ENUM, description: "Filter by link status (default all)" },
        q: { type: "string", description: "Substring filter over title, snippet and publisher" },
        limit: { type: "number", description: "Max rows (default 50, max 200)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: ["site"],
    },
    handler: async (userId, args: Json) => {
      const site = await resolveSite(userId, args.site);
      const query: MentionQuery = {
        ...(pickEnum(args.source, SOURCE_ENUM) ? { source: pickEnum(args.source, SOURCE_ENUM) as MentionQuery["source"] } : {}),
        ...(pickEnum(args.state, STATE_ENUM) ? { state: pickEnum(args.state, STATE_ENUM) as MentionQuery["state"] } : {}),
        ...(pickEnum(args.linkStatus, LINK_ENUM)
          ? { linkStatus: pickEnum(args.linkStatus, LINK_ENUM) as MentionQuery["linkStatus"] }
          : {}),
        ...(typeof args.q === "string" && args.q.trim() ? { q: args.q.trim() } : {}),
        limit: lim(args.limit, 50, 200),
        ...(Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      };
      const result = await listMentions(userId, site.id, query);
      if ("notMigrated" in result) {
        return { notMigrated: true, hint: "Run `npx prisma db push` to create the BrandMention table." };
      }
      return result;
    },
  },
];
