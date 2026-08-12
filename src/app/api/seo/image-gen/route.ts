import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { createKieImageTask, ImageModelId, IMAGE_MODELS } from "@/lib/seo/kieImages";

const VALID_MODELS = new Set(IMAGE_MODELS.map(m => m.id as string));

// POST /api/seo/image-gen — start a kie.ai image-generation task.
// body: { model, input: { prompt, aspect_ratio?, resolution?, output_format?, image_input? }, apiKey }
// -> { taskId } (poll with POST /api/seo/image-gen/status)
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const apiKey = String(b.apiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });
  const model = String(b.model ?? "");
  if (!VALID_MODELS.has(model)) return NextResponse.json({ error: "bad_model" }, { status: 400 });
  const input = b.input ?? {};
  if (!String(input.prompt ?? "").trim()) return NextResponse.json({ error: "no_prompt" }, { status: 400 });

  const r = await createKieImageTask(model as ImageModelId, input, apiKey);
  if (r.error || !r.taskId) return NextResponse.json({ error: r.error || "create_failed" }, { status: 502 });
  return NextResponse.json({ taskId: r.taskId });
}
