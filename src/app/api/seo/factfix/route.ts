import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLM } from "@/lib/llm";
import { stripForeignScripts } from "@/lib/seo/generate";

// POST /api/seo/factfix — rewrite an article to remove/soften/flag unverified claims
// found by fact-check. body: { article, claims[], keyword?, aiProvider, aiApiKey, model? }
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const article = String(b.article ?? "");
  // Accept either plain strings or {claim,status,note} objects (note carries the correct value).
  const rawClaims: any[] = Array.isArray(b.claims) ? b.claims.slice(0, 40) : [];
  const claims = rawClaims.map((c) => typeof c === "string" ? { claim: c, status: "", note: "" } : { claim: String(c.claim ?? ""), status: String(c.status ?? ""), note: String(c.note ?? "") }).filter((c) => c.claim.trim());
  if (!article.trim()) return NextResponse.json({ error: "no_article" }, { status: 400 });
  if (!claims.length) return NextResponse.json({ text: article }); // nothing to fix

  // Split off a leading meta block (everything before the first markdown heading, if it looks like
  // Title/Meta Description/URL Slug). Fact-fix must never touch or drop it, so we keep it aside and
  // re-attach it verbatim afterwards.
  let metaHead = "";
  let body = article;
  const firstHeading = article.search(/^#{1,6}\s/m);
  if (firstHeading > 0) {
    const pre = article.slice(0, firstHeading);
    if (/title\s*:|seo meta|url slug/i.test(pre)) { metaHead = pre.replace(/\s+$/, ""); body = article.slice(firstHeading); }
  }

  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });

  const prompt = `Ты — фактчек-редактор. Ниже СТАТЬЯ (Markdown) и список ПРОБЛЕМНЫХ утверждений с пометками фактчека (note часто содержит ВЕРНОЕ значение из источника). Сделай текст ГОТОВЫМ К ПУБЛИКАЦИИ — пользователь НЕ должен ничего доправлять руками.

ВАЖНО ПРО ОСТОРОЖНОСТЬ: наши источники НЕПОЛНЫЕ (например, JS-страницы официальных магазинов часто не читаются). Поэтому «не подтверждено» ≠ «неправда». НЕ удаляй правдоподобные и общеизвестные факты только потому, что их нет в наших сниппетах.

Для КАЖДОГО проблемного утверждения:
1. Если в note есть верное значение из источника — ЗАМЕНИ неверное на верное прямо в тексте (цену/валюту/модель/спеку на источниковую).
2. Если утверждение ПРОТИВОРЕЧИТ источникам — исправь по источнику.
3. Если оно ЯВНО невозможно/выдумано (несуществующая модель, нереальная акция, абсурдная цифра) — убери или обобщи.
4. Если оно просто НЕ НАЙДЕНО в наших источниках, НО правдоподобно/общеизвестно (реальные модельные номера, известные ритейлеры региона, типичные характеристики) — ОСТАВЬ КАК ЕСТЬ, НЕ удаляй и НЕ выхолащивай. Можно лишь чуть смягчить тон («ориентировочно», «как правило»), но конкретику сохрани.
5. СИНХРОНИЗАЦИЯ ЧИСЕЛ: если одно значение встречается и в прозе, и в таблице/списке — приведи их к ОДНОМУ значению (не оставляй рассинхрон между текстом и таблицей).
Правило: трогай только противоречащее источникам или явно выдуманное. Сомнительное-но-правдоподобное — сохраняй.
ЗАПРЕЩЕНО: оставлять маркеры [ПРОВЕРИТЬ], плейсхолдеры, или просьбы к читателю «проверить самому». Текст должен читаться как финальный.
- Таблицы/сравнения на выдуманных данных: исправь по источнику или убери непроверенные строки/столбцы.
ТОЧЕЧНОСТЬ (ВАЖНО): меняй ТОЛЬКО предложения/строки, где есть проблемное утверждение. ВСЁ остальное — заголовки, абзацы, списки, таблицы, порядок секций — копируй ДОСЛОВНО, не перефразируй и не сокращай. НЕ удаляй секции и НЕ ужимай текст: объём итога должен остаться примерно прежним (в пределах ±5%). НЕ добавляй новых фактов. Сохрани ВСЕ заголовки (#/##/###) и их уровни, форматирование Markdown и язык оригинала.
Верни ТОЛЬКО готовый Markdown статьи, без преамбулы.

ПРОБЛЕМНЫЕ УТВЕРЖДЕНИЯ (claim — note):
${claims.map((c, i) => `${i + 1}. ${c.claim}${c.note ? ` — note: ${c.note}` : ""}`).join("\n")}

СТАТЬЯ:
${body}`;

  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;
  let text = await fetchLLM(prompt, provider, apiKey, 16000, model, baseUrl);
  if (!text) return NextResponse.json({ error: "fix_failed" }, { status: 502 });
  // Strip a possible ```markdown fence / leading preamble line the model may add.
  text = text.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  text = stripForeignScripts(text, String(b.language ?? "en"));
  // Re-attach the untouched meta block (Title/Description/Slug) that we held aside.
  if (metaHead) text = `${metaHead}\n\n${text}`;
  return NextResponse.json({ text });
}
