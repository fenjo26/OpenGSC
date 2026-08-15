import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLMDetailed } from "@/lib/llm";
import { scrapeMany } from "@/lib/seo/scrape";
import { extractJson } from "@/lib/seo/prompts";

// POST /api/seo/policy-draft — AI-drafts an editorial policy, grounded in brand pages,
// competitor pages and a sample text (all optional).
// body: { brandName?, brandUrl?, niche?, language?, sourceUrls?[], brandDescription?,
//         competitorUrls?[], sampleText?, firecrawlKey?, aiProvider, aiApiKey, model? }
async function scrapeText(urls: string[], firecrawlKey?: string): Promise<string> {
  const list = (urls || []).map(u => u.trim()).filter(Boolean).slice(0, 5);
  if (!list.length) return "";
  let pages: any[] = [];
  try { pages = await scrapeMany(list, firecrawlKey, 4); } catch { return ""; }
  return pages.filter(p => p?.ok)
    .map(p => `[${p.url}] ${p.title || ""} — ${`${p.metaDescription || ""} ${p.textSample || ""}`.trim().slice(0, 1500)}`)
    .join("\n\n");
}

export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const brandName = String(b.brandName ?? "").trim();
  const niche = String(b.niche ?? "").trim();
  if (!brandName && !niche) return NextResponse.json({ error: "no_brand" }, { status: 400 });

  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });

  const fc = b.firecrawlKey ? String(b.firecrawlKey) : undefined;
  const brandPages = await scrapeText(Array.isArray(b.sourceUrls) ? b.sourceUrls : [], fc);
  const competitorPages = await scrapeText(Array.isArray(b.competitorUrls) ? b.competitorUrls : [], fc);
  const manualDesc = String(b.brandDescription ?? "").trim();
  const sampleText = String(b.sampleText ?? "").trim();

  const ctx = [
    brandName ? `Бренд: ${brandName}` : "",
    b.brandUrl ? `Сайт: ${b.brandUrl}` : "",
    niche ? `Ниша/проект: ${niche}` : "",
    b.language ? `Язык контента: ${b.language}` : "",
    manualDesc ? `Описание бренда (от пользователя): ${manualDesc}` : "",
    brandPages ? `СКРЕЙП СТРАНИЦ БРЕНДА (используй для description/values/audience):\n${brandPages}` : "",
    competitorPages ? `СКРЕЙП КОНКУРЕНТОВ (используй для вывода тона/структуры/стиля):\n${competitorPages}` : "",
    sampleText ? `ОБРАЗЕЦ ТЕКСТА (выведи из него тон, голос, длину абзацев, форматирование):\n${sampleText.slice(0, 4000)}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `Ты — SEO-редактор. На основе данных ниже составь ПОДРОБНЫЙ черновик редакционной политики бренда. Заполни поля конкретикой, выведенной из материалов (описание и ценности — из страниц бренда; тон, голос, структуру, форматирование — из конкурентов и образца текста). Где данных нет — дай разумные значения по нише. Верни СТРОГИЙ JSON по схеме, без преамбулы и markdown-обёрток.

${ctx}

ВАЖНО: НЕ выдумывай лицензии/регалии — в complianceRequirements обязательно укажи правило ставить плейсхолдер под реальные данные.

Схема JSON (верни ровно эти ключи):
{
  "name": "короткое имя политики (можно = бренду)",
  "brand": { "name": "", "url": "", "description": "чем занимается бренд, 2-4 предложения", "values": "ценности через запятую", "competitors": ["конкурент1", "конкурент2"] },
  "audience": { "customerProfile": "кто читает — потребности и контекст, развёрнуто", "expertiseLevel": "beginner|intermediate|expert", "industryNiche": "ниша" },
  "voice": { "authorPersona": "от чьего лица пишем", "toneOfVoice": "conversational|neutral|business|official|expert|professional|friendly|analytical|practical", "formalityLevel": 50 },
  "structure": {
    "headingStyle": "questions|statements|how-to|mixed",
    "headingCapitalization": "sentence|title|upper",
    "paragraphLength": "short|medium|long",
    "elements": { "bold": true, "italics": false, "lists": true, "tables": true, "quotes": false, "examples": true, "images": false }
  },
  "quality": {
    "citationStyle": "inline|footnotes|none",
    "requireSourceLinks": true,
    "eeatRequirements": "как демонстрировать опыт/экспертизу/авторитетность",
    "factCheckingNotes": "требования к проверке фактов"
  },
  "restrictions": {
    "wordsToAvoid": "превосходные степени и пустые эпитеты через запятую",
    "topicsToAvoid": "запретные темы через запятую",
    "complianceRequirements": "правило: не указывать несуществующие лицензии — плейсхолдер под ручное заполнение; + отраслевой комплаенс если уместен"
  },
  "variables": {}
}`;

  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;
  // 3000 tokens is a tight budget, and on a provider whose model thinks by default the reasoning
  // alone can consume all of it — leaving a 200-OK response with no text. That surfaced here as a
  // 502 "parse_failed" and, in the UI, as "the model returned invalid JSON": both blame the parser
  // for something that never reached it. fetchLLMDetailed carries the provider's own reason, so the
  // dialog can say what actually happened.
  let res = await fetchLLMDetailed(prompt, provider, apiKey, 3000, model, baseUrl);
  let raw = res.text;
  let policy = extractJson(raw);
  if (!policy) {
    res = await fetchLLMDetailed(prompt + "\n\nВерни ТОЛЬКО валидный JSON.", provider, apiKey, 3000, model, baseUrl);
    raw = res.text;
    policy = extractJson(raw);
  }
  if (!policy) {
    return NextResponse.json(
      {
        error: raw == null ? (res.error ?? "generation_failed") : "parse_failed",
        detail: raw == null ? res.error : `Модель вернула текст, который не является JSON. Первые 300 символов: ${raw.trim().replace(/\s+/g, " ").slice(0, 300)}`,
        raw,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ policy });
}
