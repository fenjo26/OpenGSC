import {
  createOutreachCampaign,
  createOutreachProspect,
  listOutreach,
  updateOutreachProspect,
} from "@/lib/outreach/service";
import { OUTREACH_STAGES } from "@/lib/outreach/types";
import { lim, type McpTool } from "./shared";

const campaignArg = {
  type: "string",
  description: "Optional Outreach campaign id. Use list_outreach_prospects to discover ids.",
};

/**
 * Outreach is intentionally its own local workflow surface. These tools do not call the Site
 * Audit, GEO Audit or AI Visibility modules, and never send mail or spend provider credits.
 */
export const OUTREACH_TOOLS: McpTool[] = [
  {
    name: "list_outreach_prospects",
    cost: "local",
    readOnly: true,
    description:
      "List the owner's Outreach Workspace campaigns, prospects, evidence snapshots, stages, follow-up dates and won-link state. LOCAL/READ-ONLY: no network request and no message is sent.",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: [...OUTREACH_STAGES], description: "Optional pipeline-stage filter" },
        campaignId: campaignArg,
        limit: { type: "number", description: "Maximum prospects returned (default 100, max 500)" },
      },
    },
    handler: async (userId, args) => {
      const result = await listOutreach(userId, {
        stage: typeof args.stage === "string" ? args.stage : undefined,
        campaignId: typeof args.campaignId === "string" ? args.campaignId : undefined,
      });
      return { ...result, prospects: result.prospects.slice(0, lim(args.limit, 100, 500)) };
    },
  },
  {
    name: "save_outreach_prospect",
    cost: "local",
    readOnly: false,
    idempotent: true,
    description:
      "Save one publisher domain or Link Monitor source URL as an Outreach prospect. Existing evidence is snapshotted and saving the same domain again returns the existing row. LOCAL WRITE ONLY: never fetches the web, spends credits or sends a message.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Publisher domain, for example publisher.com" },
        sourceUrl: { type: "string", description: "Optional existing Link Monitor evidence URL (http/https)" },
        campaignId: campaignArg,
        targetAsset: { type: "string", description: "Page or asset you may pitch" },
        pitchAngle: { type: "string", description: "Internal value proposition; not sent automatically" },
        notes: { type: "string", description: "Private operator notes" },
      },
      anyOf: [{ required: ["domain"] }, { required: ["sourceUrl"] }],
    },
    handler: async (userId, args) => createOutreachProspect(userId, args),
  },
  {
    name: "update_outreach_prospect",
    cost: "local",
    readOnly: false,
    idempotent: true,
    description:
      "Update an existing Outreach prospect's stage, contact research, follow-up, campaign, pitch notes or won backlink. Stage changes are recorded in local history. LOCAL WRITE ONLY: does not contact the publisher or run an audit.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Prospect id from list_outreach_prospects" },
        stage: { type: "string", enum: [...OUTREACH_STAGES] },
        campaignId: { ...campaignArg, description: "Campaign id, or null to remove the prospect from a campaign" },
        contactName: { type: "string" },
        contactEmail: { type: "string" },
        contactUrl: { type: "string" },
        contactSource: { type: "string" },
        targetAsset: { type: "string" },
        pitchAngle: { type: "string" },
        notes: { type: "string" },
        nextFollowUpAt: { type: ["string", "null"], description: "ISO date/time, or null to clear" },
        lastContactAt: { type: ["string", "null"], description: "ISO date/time, or null to clear" },
        backlinkId: { type: ["string", "null"], description: "Optional Backlink row owned by this user" },
        wonBacklinkUrl: { type: "string", description: "Optional verified/manual won backlink URL" },
        stageNote: { type: "string", description: "Optional note stored with a stage transition" },
      },
      required: ["id"],
    },
    handler: async (userId, args) => {
      const id = String(args.id ?? "").trim();
      if (!id) throw new Error("Missing required argument: id");
      return { prospect: await updateOutreachProspect(userId, id, args) };
    },
  },
  {
    name: "create_outreach_campaign",
    cost: "local",
    readOnly: false,
    idempotent: false,
    description:
      "Create a local Outreach campaign for grouping prospects and measuring won links. This only stores workspace data; it never launches or sends a campaign.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique campaign name" },
        targetAsset: { type: "string", description: "Page or asset this campaign promotes" },
        notes: { type: "string", description: "Private operator notes" },
      },
      required: ["name"],
    },
    handler: async (userId, args) => ({ campaign: await createOutreachCampaign(userId, args) }),
  },
];
