
import { rawQuery } from "@/lib/db/raw";// Casino RAG — knowledge-base retrieval for outline/text generation.
// Matches slot/casino/provider names against the keyword and renders their attributes
// as a compact facts block. Uses $queryRawUnsafe so it works with the existing generated
// Prisma client (no regenerate needed after adding the Rag* tables).
export interface RagFacts {
  slots: any[];
  casinos: any[];
  providers: string[];
  rendered: string;   // human-readable facts block for prompts
  bankEntry?: { source: string; domain: string; official: boolean; facts: string };
}

const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Whole-word containment: "book of sun" matches "book of sun slot review",
// but "sun" must not match "sunset". Names shorter than 4 chars require word boundaries too.
function containsName(keyword: string, name: string): boolean {
  if (!name || name.length < 3) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(keyword); }
  catch { return keyword.includes(name); }
}

function renderSlot(s: any): string {
  const bits: string[] = [];
  if (s.provider) bits.push(`провайдер ${s.provider}`);
  if (s.released) bits.push(`выход ${s.released}`);
  if (s.rtp) bits.push(`RTP ${s.rtp}%`);
  if (s.volatility) bits.push(`волатильность ${String(s.volatility).toLowerCase()}`);
  if (s.maxWin) bits.push(`макс. выигрыш ${s.maxWin}`);
  if (s.minBet || s.maxBet) bits.push(`ставки ${[s.minBet, s.maxBet].filter(Boolean).join("–")}`);
  if (s.layout) bits.push(`поле ${s.layout}`);
  if (s.lines) bits.push(`линий ${s.lines}`);
  if (s.features) bits.push(`фичи: ${String(s.features).slice(0, 220)}`);
  if (s.themes) bits.push(`темы: ${String(s.themes).slice(0, 120)}`);
  if (s.demoUrl) bits.push(`есть демо-версия`);
  if (s.platform) bits.push(`платформы: ${s.platform}`);
  return `• ${s.name} — ${bits.join("; ")}`;
}

function renderCasino(c: any): string {
  const bits: string[] = [];
  if (c.website) bits.push(`сайт ${c.website}`);
  if (c.founded) bits.push(`основано ${c.founded}`);
  if (c.country) bits.push(`страна ${c.country}`);
  if (c.locality || c.region) bits.push(`локация ${[c.locality, c.region].filter(Boolean).join(", ")}`);
  if (c.size) bits.push(`размер компании ${c.size} сотрудников`);
  return `• ${c.name} — ${bits.join("; ")}`;
}

// Retrieve knowledge-base facts relevant to the keyword. Best-effort: any DB error → null.
export async function findRagFacts(keyword: string): Promise<RagFacts | null> {
  const kw = norm(keyword);
  if (!kw) return null;
  try {
    // Candidate rows whose name occurs inside the keyword (SQLite instr scan is fast enough
    // at ~40k rows), then precise word-boundary filtering in JS. Longest names first =
    // most specific match wins (e.g. "Book of Sun Multichance" over "Book of Sun").
    const slots: any[] = await rawQuery(
      `SELECT name, nameNorm, provider, released, slotType, rtp, volatility, maxWin, minBet, maxBet,
              layout, lines, features, themes, demoUrl, platform
       FROM "RagSlot" WHERE length(nameNorm) >= 3 AND instr(?, nameNorm) > 0
       ORDER BY length(nameNorm) DESC LIMIT 40`, kw);
    const casinos: any[] = await rawQuery(
      `SELECT name, nameNorm, website, country, founded, locality, region, size
       FROM "RagCasino" WHERE length(nameNorm) >= 3 AND instr(?, nameNorm) > 0
       ORDER BY length(nameNorm) DESC LIMIT 20`, kw);
    const providerRows: any[] = await rawQuery(
      `SELECT provider, COUNT(*) as cnt FROM "RagSlot"
       WHERE provider != '' AND instr(?, lower(provider)) > 0
       GROUP BY provider ORDER BY cnt DESC LIMIT 5`, kw);

    let slotHits = slots.filter(s => containsName(kw, s.nameNorm));
    let casinoHits = casinos.filter(c => containsName(kw, c.nameNorm));
    const providers = providerRows.filter(p => containsName(kw, norm(p.provider)));

    // De-noise: drop generic-named entities ("Slots", "Casino", "Vegas") and hits fully
    // shadowed by a longer, more specific match ("Sun" when "Book of Sun" matched).
    const GENERIC = new Set(["casino", "casinos", "slot", "slots", "vegas", "las vegas", "bonus", "game", "games",
      "win", "gold", "lucky", "money", "cash", "jackpot", "spin", "spins", "bet", "betting", "online", "review"]);
    const allNames = [...slotHits.map(s => s.nameNorm), ...casinoHits.map(c => c.nameNorm)];
    const shadowed = (n: string) => allNames.some(o => o !== n && o.length > n.length && o.includes(n));
    slotHits = slotHits.filter(s => !GENERIC.has(s.nameNorm) && !shadowed(s.nameNorm)).slice(0, 10);
    casinoHits = casinoHits.filter(c => !GENERIC.has(c.nameNorm) && !shadowed(c.nameNorm)).slice(0, 5);

    // Provider pages ("3 oaks slots"): add the provider's notable titles as context.
    let providerBlock = "";
    for (const p of providers) {
      const top: any[] = await rawQuery(
        `SELECT name, released, rtp FROM "RagSlot" WHERE provider = ? ORDER BY name LIMIT 12`, p.provider);
      providerBlock += `\nПровайдер ${p.provider}: ${Number(p.cnt)} слотов в базе. Известные тайтлы: ${top.map(x => x.name).join(", ")}.`;
    }

    if (!slotHits.length && !casinoHits.length && !providers.length) return null;

    const parts: string[] = [];
    if (slotHits.length) parts.push(`СЛОТЫ (проверенные атрибуты из базы знаний):\n${slotHits.map(renderSlot).join("\n")}`);
    if (casinoHits.length) parts.push(`КАЗИНО/КОМПАНИИ (данные из базы знаний):\n${casinoHits.map(renderCasino).join("\n")}`);
    if (providerBlock) parts.push(providerBlock.trim());
    const rendered = parts.join("\n\n");

    return {
      slots: slotHits, casinos: casinoHits, providers: providers.map(p => p.provider),
      rendered,
      bankEntry: { source: "kb://casino-rag", domain: "knowledge-base", official: true, facts: rendered.slice(0, 1600) },
    };
  } catch {
    return null; // table missing / db error — RAG silently off
  }
}
