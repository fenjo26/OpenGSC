// MCP tools for the meta-fit contour (wave-oct T1, CONTRACT.md §5).

import { type Json, type McpTool, resolveAiCreds } from "./shared";
import { fitMeta } from "@/lib/seo/metaFit";
import type { MetaFitItem, MetaFitResponse } from "@/lib/seo/metaLimits";

// One item, sanitized exactly the way the HTTP route sanitizes it — the two entry points must
// never disagree about what a valid item is.
function toItem(x: unknown, i: number): MetaFitItem {
  const it = (x ?? {}) as Record<string, unknown>;
  return {
    id: it.id != null ? String(it.id) : `item-${i}`,
    keyword: String(it.keyword ?? "").slice(0, 300),
    language: String(it.language ?? "en").slice(0, 8),
    title: it.title != null ? String(it.title) : undefined,
    description: it.description != null ? String(it.description) : undefined,
    titleOptions: Array.isArray(it.titleOptions) ? (it.titleOptions as unknown[]).map((o) => String(o ?? "")).slice(0, 10) : undefined,
    descriptionOptions: Array.isArray(it.descriptionOptions) ? (it.descriptionOptions as unknown[]).map((o) => String(o ?? "")).slice(0, 10) : undefined,
    brand: it.brand != null ? String(it.brand).slice(0, 100) : undefined,
  };
}

export const META_TOOLS: McpTool[] = [
  {
    name: "fit_meta",
    // Free (deterministic string work on this server) unless the caller asks for allow_llm —
    // then each item costs up to 2 repair calls on the owner's key, which is why the schema
    // level says "local" and the description carries the paid-mode rule.
    cost: "local",
    description:
      "FREE (local): fit page meta tags inside the audit band — Title 50–60 and Meta Description 150–160 characters, counted in Unicode code points by CODE, not by the model. Give it the current values plus any alternative options the generator produced; it deterministically picks an in-band option, trims a trailing clause (keeping the main keyword, never leaving a dangling separator or preposition), and reports method per field (kept | picked | trimmed | unfixable). Set allow_llm: true (PAID — spends the instance owner's own AI credits, needs confirm: true) to let it make up to 2 repair calls per item when nothing fits deterministically, and to force a word-boundary cut as the last resort (reported as forced_cut, review those). Lengths only ever change toward the band: a too-short value is never padded.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Up to 50 items: { keyword (required — kept at the start of the title), language (ISO-639-1), title?, description?, titleOptions?, descriptionOptions?, brand? (dropped first when over the limit) }",
          items: { type: "object" },
        },
        allow_llm: {
          type: "boolean",
          description: "PAID when true: up to 2 AI repair calls per item on the owner's key, for values no deterministic trim can fit. Requires confirm: true.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true when allow_llm is set. PAID: this call spends the instance owner's own AI credits — get their permission before setting it.",
        },
      },
      required: ["items"],
    },
    handler: async (userId: string, args: Json) => {
      const allowLlm = args.allow_llm === true;
      if (allowLlm && args.confirm !== true) {
        throw new Error(
          "fit_meta with allow_llm: true spends the instance owner's own AI credits (up to 2 repair calls per item), so it will not run unconfirmed. " +
          "Ask the user for permission first, then call again with confirm: true. " +
          "Without allow_llm the call is free and needs no confirmation — try that first: most over-length values are fixed by the deterministic trim alone.",
        );
      }

      const raw = Array.isArray(args.items) ? args.items : [];
      if (!raw.length) throw new Error("Pass `items`: an array of up to 50 { keyword, language, title?, description?, titleOptions?, descriptionOptions?, brand? }.");
      if (raw.length > 50) throw new Error(`Too many items (${raw.length}). Send at most 50 per call.`);
      const items = raw.map(toItem);
      const bad = items.filter((it) => !it.keyword.trim());
      if (bad.length) throw new Error(`Every item needs a non-empty keyword (the main query, kept at the start of the title). ${bad.length} item(s) have none.`);

      let llm: Parameters<typeof fitMeta>[1] = { allow: false };
      if (allowLlm) {
        const creds = await resolveAiCreds(userId, args, "text");
        if (!creds.aiApiKey) {
          throw new Error("No AI key is configured on this instance. The owner adds one in SEO Tools → Settings (it is mirrored server-side). Without a key only the free deterministic fitting is available: call again without allow_llm.");
        }
        llm = { allow: true, provider: creds.aiProvider, apiKey: creds.aiApiKey, model: creds.model, baseUrl: creds.aiBaseUrl };
      }

      const results: MetaFitResponse[] = [];
      for (const item of items) {
        try {
          results.push(await fitMeta(item, llm));
        } catch {
          results.push({ id: item.id, llmCalls: 0 }); // one bad item never costs the batch
        }
      }
      const flagged = results
        .flatMap((r) => [r.title, r.description].filter((f) => f && (f.method === "forced_cut" || f.method === "unfixable")))
        .length;
      return {
        results,
        ...(flagged ? {
          warning: `${flagged} field(s) could not be brought inside the band cleanly (forced_cut or unfixable) — read their ` +
            `method in the results and fix those by hand; a forced cut lands ≤ the maximum but may read awkwardly, an unfixable value is left exactly as it came.`,
        } : {}),
      };
    },
  },
];
