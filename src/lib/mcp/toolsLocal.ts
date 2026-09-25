// MCP tools for Local SEO (N4, brief §8): the stored business profile, and the NAP check that
// walks the site's own pages. Everything else on /local (schema generator, citations, GBP) is
// either a pure UI operation or needs the operator's eyes — the two tools here are the ones an
// agent can act on: read the card, and re-run the consistency check whose result feeds nothing
// else (the report is live, never stored).

import { type McpTool, resolveSite } from "./shared";
import { getProfile, localSchemaMissing } from "@/lib/local/store";
import { runNapCheck } from "@/lib/local/runner";
import { buildLocalBusinessSchema, validateLocalBusinessSchema } from "@/lib/local/schema";

export const LOCAL_TOOLS: McpTool[] = [
  {
    name: "get_local_profile",
    cost: "local",
    readOnly: true,
    description:
      "Local SEO business card of one site: name, schema.org business type, NAP (address, phone in E.164, e-mail), coordinates, opening hours, price range, sameAs profiles, service areas, and the selected Google Business Profile account/location. Includes the generated LocalBusiness JSON-LD and Google-requirements validation (required fields, recommended-field warnings). Returns { profile: null } when the site has no card yet — nothing is guessed from the domain.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site row id, GSC property (sc-domain:example.com or URL), or bare domain" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      try {
        const site = await resolveSite(userId, args.site);
        const profile = await getProfile(userId, site.id);
        if (!profile) return { profile: null };
        const schema = buildLocalBusinessSchema(profile, { url: site.url });
        return {
          profile,
          schema,
          validation: validateLocalBusinessSchema(schema, profile.businessType),
        };
      } catch (e) {
        if (localSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
  {
    name: "check_nap",
    cost: "net",
    description:
      "NAP consistency check of one site against its business card: fetches the homepage and up to 10 contact-ish pages (free, one request each), extracts name/phones/address (JSON-LD first, then microdata, then text) and reports every field as match | differs | missing with the expected and found values. Requires a profile (create it in Local → Business profile first). The report is returned live and never stored.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "Site row id, GSC property, or bare domain" },
      },
      required: ["site"],
    },
    handler: async (userId, args) => {
      try {
        const site = await resolveSite(userId, args.site);
        const profile = await getProfile(userId, site.id);
        if (!profile) {
          return { error: "profile_required", hint: "Create the business card in Local → Business profile, then re-run check_nap." };
        }
        const report = await runNapCheck(profile, site.url);
        return { report };
      } catch (e) {
        if (localSchemaMissing(e)) return { notMigrated: true };
        throw e;
      }
    },
  },
];
