import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { createKieImageTask, ImageModelId as KieModelId } from "@/lib/seo/kieImages";
import { generateZaiImage, type ZaiImageModelId } from "@/lib/seo/zaiImages";
import { imageModel } from "@/lib/seo/imageModels";

// POST /api/seo/image-gen — start an image render.
// body: { model, input: { prompt, aspect_ratio?, resolution?, output_format?, image_input? }, apiKey, baseUrl? }
//
// The two providers answer differently on purpose, because they behave differently:
//   kie.ai → { taskId }  — async, the caller polls /api/seo/image-gen/status
//   Z.AI   → { urls }    — synchronous, the image is already rendered
// The client branches on which field came back rather than being told the provider twice.
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const apiKey = String(b.apiKey ?? "");
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });
  const model = String(b.model ?? "");
  const def = imageModel(model);
  if (!def) return NextResponse.json({ error: "bad_model" }, { status: 400 });
  const input = b.input ?? {};
  if (!String(input.prompt ?? "").trim()) return NextResponse.json({ error: "no_prompt" }, { status: 400 });

  if (def.provider === "zai") {
    const r = await generateZaiImage(
      model as ZaiImageModelId,
      { prompt: String(input.prompt), aspect_ratio: input.aspect_ratio, resolution: input.resolution },
      apiKey,
      b.baseUrl ? String(b.baseUrl) : undefined,
    );
    if (r.error || !r.urls?.length) return NextResponse.json({ error: r.error || "create_failed" }, { status: 502 });
    return NextResponse.json({ urls: r.urls });
  }

  const r = await createKieImageTask(model as KieModelId, input, apiKey);
  if (r.error || !r.taskId) return NextResponse.json({ error: r.error || "create_failed" }, { status: 502 });
  return NextResponse.json({ taskId: r.taskId });
}
