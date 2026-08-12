import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLMVision } from "@/lib/llm";
import { buildVisionStructurePrompt, extractJson } from "@/lib/seo/prompts";

// POST /api/seo/structure-vision — Landing-flow "разобрать по скриншоту" (slower, more accurate
// for pages whose visual structure doesn't match their HTML H-tags).
// body: { imageBase64, mimeType?, aiProvider, aiApiKey, model?, aiBaseUrl? }
// -> { title, nodes: [{level,text,words}] }
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const b = await req.json();
  const imageBase64 = String(b.imageBase64 ?? "");
  if (!imageBase64) return NextResponse.json({ error: "no_image" }, { status: 400 });
  const mimeType = String(b.mimeType ?? "image/png");
  const provider = String(b.aiProvider ?? "anthropic");
  const apiKey = String(b.aiApiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });
  const model = b.model ? String(b.model) : undefined;
  const baseUrl = b.aiBaseUrl ? String(b.aiBaseUrl) : undefined;

  const raw = await fetchLLMVision(buildVisionStructurePrompt(), imageBase64, mimeType, provider, apiKey, 3000, model, baseUrl);
  const parsed = extractJson<{ title?: string; nodes?: { level: string; text: string; words: number }[] }>(raw);
  if (!parsed || !Array.isArray(parsed.nodes) || !parsed.nodes.length) {
    return NextResponse.json({ error: "parse_failed" }, { status: 502 });
  }

  return NextResponse.json({ title: parsed.title || "", nodes: parsed.nodes });
}
