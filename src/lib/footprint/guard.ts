// The generator's footprint guard (N1) — the protective half of the footprint report.
//
// After META FIT, the outline's title/description options are skeletonized with the keyword as
// the entity and checked against the portfolio's OCCUPIED skeletons: the published pages of
// every site plus the generation history of OTHER keywords (a keyword regenerating itself may
// keep its own construction), minus everything on the operator's ignore list.
//
//   • free variants move to the front, occupied ones to the back — `pick()` takes the first;
//   • when EVERY variant of a field is occupied, ONE paid repair call asks the model to
//     rephrase without those constructions; everything it returns is checked BY CODE (free
//     skeleton + inside the meta band) before anything ships;
//   • nothing worked → the options stay as they are and a concern is attached to the outline
//     (`footprint: title reuses a portfolio template`) so the operator sees it.
//
// The block switches itself off when there is nothing to compare against: no portfolio data →
// no occupied skeletons → no reorder, no call, no concern (brief: "блок выключается, если в
// портфеле нет данных").

import { fetchLLM } from "@/lib/llm";
import { extractJson } from "@/lib/seo/prompts";
import { fitMetaLocal } from "@/lib/seo/metaFit";
import { META_LIMITS } from "@/lib/seo/metaLimits";
import { skeletonOf } from "./skeleton";
import { occupiedSkeletons, portfolioOwnerId } from "./store";

export interface GuardContext {
  keyword: string;
  language: string;
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const FIELD_LABEL = { title: "Title", description: "Meta Description" } as const;
type GuardField = keyof typeof FIELD_LABEL;

/**
 * Mutates `outline.meta.title_options` / `description_options` in place (free first) and
 * returns the concerns for the outline's `_footprint` field. Empty array = nothing to report.
 */
export async function guardOutlineFootprint(
  outline: Record<string, unknown>,
  ctx: GuardContext,
): Promise<string[]> {
  const meta = (outline.meta as Record<string, unknown> | undefined) ?? (outline.meta = {});
  const ownerId = await portfolioOwnerId();
  if (!ownerId) return [];
  const occupied = await occupiedSkeletons(ownerId, ctx.keyword);
  if (!occupied.size) return [];

  const concerns: string[] = [];
  for (const field of ["title", "description"] as const) {
    const key = `${field}_options`;
    const opts = (Array.isArray(meta[key]) ? meta[key] : []).map((x: unknown) => String(x ?? "").trim()).filter(Boolean);
    if (opts.length < 2) continue; // one variant is nothing to choose between — reorder is meaningless

    const skeletons = opts.map(o => skeletonOf(o, [ctx.keyword]));
    const free = opts.filter((_, i) => !occupied.has(skeletons[i]));
    const taken = opts.filter((_, i) => occupied.has(skeletons[i]));
    if (!taken.length) continue;

    if (free.length) {
      meta[key] = [...free, ...taken];
      continue;
    }

    // Every variant reuses a portfolio construction — one repair call, checked by code.
    const repaired = await repairVariants(field, opts, occupied, ctx);
    if (repaired.length) {
      meta[key] = [...repaired, ...opts];
      continue;
    }
    concerns.push(`footprint: ${field} reuses a portfolio template`);
  }
  return concerns;
}

/** ≤ 3 code-verified variants from one paid call; empty array = the call failed or nothing passed. */
async function repairVariants(
  field: GuardField,
  opts: string[],
  occupied: Set<string>,
  ctx: GuardContext,
): Promise<string[]> {
  const { targetMin, targetMax } = META_LIMITS[field];
  // The CONSTRUCTIONS (skeletons), never the other sites' raw titles — the model needs to know
  // what shape to avoid, not what the neighbours wrote.
  const constructions = [...new Set(opts.map(o => skeletonOf(o, [ctx.keyword])))].slice(0, 6);
  const prompt =
    `Ты — SEO-редактор. Варианты ${FIELD_LABEL[field]} ниже построены по тем же конструкциям, которые уже стоят на других страницах портфеля — это отпечаток сетки, их нельзя переиспользовать. Перепиши ДРУГИМИ формулировками, сохранив смысл и язык.\n\n` +
    `Главный ключ: ${ctx.keyword}\nЯзык: ${ctx.language}\n` +
    `Запрещённые конструкции ({x} — подставленное название, год или число):\n${constructions.map(c => `- ${c}`).join("\n")}\n\n` +
    `Текущие варианты:\n${opts.slice(0, 3).map(o => `- ${o}`).join("\n")}\n\n` +
    `Длина каждого варианта строго ${targetMin}–${targetMax} символов (Unicode-кодпоинты), главный ключ ближе к началу.\n\n` +
    `Верни СТРОГИЙ JSON без обёрток и пояснений: { "variants": ["…", "…", "…"] } — ровно 3 РАЗНЫХ варианта.`;

  let raw: string | null = null;
  try {
    raw = await fetchLLM(prompt, ctx.provider, ctx.apiKey, 1200, ctx.model, ctx.baseUrl, 0);
  } catch {
    return [];
  }
  const parsed = extractJson<{ variants?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.variants)) return [];

  const out: string[] = [];
  for (const v of parsed.variants) {
    if (typeof v !== "string") continue;
    const value = v.trim();
    if (!value) continue;
    // Code decides, not the model: free skeleton + inside the band (fitMetaLocal also
    // normalizes markdown residue, so the length check runs on the publishable string).
    if (occupied.has(skeletonOf(value, [ctx.keyword]))) continue;
    if (!fitMetaLocal(field, value, [], ctx.keyword).inBand) continue;
    out.push(value);
    if (out.length >= 3) break;
  }
  return out;
}
