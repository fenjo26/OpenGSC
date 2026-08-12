import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLM } from "@/lib/llm";
import { buildImagePromptsPrompt, extractJson } from "@/lib/seo/prompts";

// POST /api/seo/images { outline?, article?, keyword, aiProvider, aiApiKey, model? }
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });

  const prompt = buildImagePromptsPrompt({ outlineJson: b.outline, article: b.article, keyword: String(b.keyword ?? "") });
  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;
  let raw = await fetchLLM(prompt, provider, apiKey, 3000, model, baseUrl);
  let data = extractJson(raw);
  if (!data) { raw = await fetchLLM(prompt + "\n\nВерни ТОЛЬКО валидный JSON.", provider, apiKey, 3000, model, baseUrl); data = extractJson(raw); }
  if (!data) return NextResponse.json({ error: "parse_failed" }, { status: 502 });
  return NextResponse.json({ images: data });
}
