import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLM } from "@/lib/llm";
import { rawQuery } from "@/lib/db/raw";

// POST /api/linkwatch/insights { aiProvider, aiApiKey, model?, aiBaseUrl?, language? }
// AI summary over the stored mentions — themes, mention contexts, anchor patterns,
// content/PR opportunities (the analysis step of detailed.com/ai-backlinks-api).

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });

  let mentions: any[] = [];
  try {
    mentions = await rawQuery(
      `SELECT brand, urlFrom, domainFrom, title, anchor, drFrom, firstSeen, dofollow
       FROM "LinkMention" WHERE userId = ? ORDER BY drFrom DESC LIMIT 400`, userId);
  } catch { return NextResponse.json({ error: "not_migrated" }, { status: 500 }); }
  if (!mentions.length) return NextResponse.json({ error: "no_mentions" }, { status: 400 });

  const lang = String(b.language ?? "ru");
  const rows = mentions.map(m =>
    `${m.brand} ← ${m.domainFrom} (DR ${Math.round(m.drFrom)}${m.dofollow ? "" : ", nofollow"}) «${String(m.title).slice(0, 90)}» anchor: «${String(m.anchor).slice(0, 60)}» ${m.firstSeen}`).join("\n");
  const prompt = `Ты — аналитик линкбилдинга и digital PR. Ниже свежие бэклинки, полученные отслеживаемыми брендами (данные Ahrefs). Дай СЖАТЫЙ практичный разбор на языке "${lang}" в Markdown:

1. ОБЩИЕ ТЕМЫ: какие типы страниц/контента чаще всего получают ссылки (исследования, обзоры, сравнения, новости) — с примерами.
2. КОНТЕКСТ УПОМИНАНИЙ: в каком качестве журналисты/авторы ссылаются на бренды (данные, продукт, эксперт, кейс).
3. ЯКОРЯ: заметные или подозрительные паттерны анкоров.
4. ВОЗМОЖНОСТИ: 5-8 конкретных идей контента/аутрича, которые напрашиваются из данных (какие темы недоосвещены, какие площадки ссылаются на нескольких конкурентов сразу — им можно предложить и наш материал).
5. ПЛОЩАДКИ-МУЛЬТИЛИНКЕРЫ: домены, ссылающиеся на 2+ брендов — приоритет для аутрича.

Пиши конкретно, по делу, без воды. НЕ выдумывай данных, которых нет в списке.

ДАННЫЕ (${mentions.length} ссылок):
${rows.slice(0, 60000)}`;

  const text = await fetchLLM(prompt, String(b.aiProvider ?? "anthropic"), apiKey, 4000,
    b.model ? String(b.model) : undefined, b.aiBaseUrl ? String(b.aiBaseUrl) : undefined);
  if (!text) return NextResponse.json({ error: "generation_failed" }, { status: 502 });
  return NextResponse.json({ insights: text });
}
