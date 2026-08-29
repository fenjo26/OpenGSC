// Kie.ai async image-generation jobs (the "Market" API family): POST creates a task and returns
// a taskId immediately; the actual render happens in the background and is retrieved by polling.
// Docs: https://docs.kie.ai/market/quickstart (createTask) + .../market/common/get-task-detail
// (recordInfo). No callBackUrl here — this app is typically self-hosted without a public callback
// URL, so we poll instead (same trade-off the docs call out).

import { loggedFetch } from "@/lib/providerLog/log";

const KIE_BASE = "https://api.kie.ai";

export const IMAGE_MODELS = [
  { id: "gpt-image-2-text-to-image", label: "GPT Image-2 (text → image)" },
  { id: "nano-banana-2", label: "Google Nano Banana 2 (text/image → image)" },
] as const;
export type ImageModelId = typeof IMAGE_MODELS[number]["id"];

export interface ImageGenInput {
  prompt: string;
  aspect_ratio?: string;         // e.g. "auto" | "1:1" | "16:9" | "9:16" ...
  resolution?: "1K" | "2K" | "4K";
  output_format?: "png" | "jpg"; // nano-banana-2 only
  image_input?: string[];        // nano-banana-2 only — up to 14 reference image URLs
}

export async function createKieImageTask(model: ImageModelId, input: ImageGenInput, apiKey: string): Promise<{ taskId?: string; error?: string }> {
  try {
    const { res, call } = await loggedFetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(20000),
    }, { provider: "kie", model });
    const data = await res.json().catch(() => null);
    const taskId = data?.data?.taskId;
    if (!res.ok || !taskId) {
      const error = data?.msg || `kie_createTask_${res.status}`;
      call.finish({ error, responseBody: data });
      return { error };
    }
    call.finish({ responseBody: data });
    return { taskId };
  } catch (e: any) {
    return { error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e) };
  }
}

export type KieTaskState = "waiting" | "queuing" | "generating" | "success" | "fail";

export async function getKieImageTask(taskId: string, apiKey: string): Promise<{ state: KieTaskState; resultUrls?: string[]; progress?: number; error?: string }> {
  try {
    // The poll is a request like any other, and a render is polled until it finishes: a task
    // that never completes shows up here as a run of rows rather than as nothing at all.
    const { res, call } = await loggedFetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    }, { provider: "kie" });
    const data = await res.json().catch(() => null);
    const d = data?.data;
    if (!res.ok || !d) {
      const error = data?.msg || `kie_recordInfo_${res.status}`;
      call.finish({ error, responseBody: data });
      return { state: "fail", error };
    }
    call.finish({ responseBody: data });
    const state: KieTaskState = d.state || "waiting";
    if (state === "fail") return { state, error: d.failMsg || "generation_failed" };
    let resultUrls: string[] | undefined;
    if (d.resultJson) { try { resultUrls = JSON.parse(d.resultJson)?.resultUrls; } catch { /* leave undefined */ } }
    return { state, resultUrls, progress: typeof d.progress === "number" ? d.progress : undefined };
  } catch (e: any) {
    return { state: "fail", error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e) };
  }
}
