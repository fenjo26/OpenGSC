// Z.AI image generation (GLM-Image / CogView-4).
//
// Unlike kie.ai's Market API, this one is SYNCHRONOUS: the POST returns the finished image URL in
// its own response, so there is no task to poll. That difference is the reason the shared route
// answers with `urls` here and `taskId` there, and the reason the client finishes immediately
// instead of entering its polling loop.
//
// Docs: https://docs.z.ai/api-reference/image/generate-image
// The returned URLs expire after 30 days — download anything worth keeping.

const ZAI_DEFAULT_ROOT = "https://api.z.ai/api/paas/v4";

export const ZAI_IMAGE_MODELS = [
  { id: "glm-image", label: "Z.AI GLM-Image (text → image)" },
  { id: "cogview-4-250304", label: "Z.AI CogView-4 (text → image)" },
] as const;

export type ZaiImageModelId = typeof ZAI_IMAGE_MODELS[number]["id"];

/**
 * The app's aspect-ratio selector speaks ratios; this endpoint wants explicit pixel dimensions,
 * and the two model families have different recommended grids (GLM-Image is built around 1280px,
 * CogView-4 around 1024px). Sending a size off the recommended grid is accepted but degrades the
 * result, so map rather than compute.
 */
const SIZES: Record<string, Record<string, string>> = {
  "glm-image": {
    auto: "1280x1280",
    "1:1": "1280x1280",
    "3:2": "1568x1056",
    "2:3": "1056x1568",
    "4:3": "1472x1088",
    "3:4": "1088x1472",
    "16:9": "1728x960",
    "9:16": "960x1728",
  },
  "cogview-4-250304": {
    auto: "1024x1024",
    "1:1": "1024x1024",
    "3:2": "1152x864",
    "2:3": "864x1152",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1344x768",
    "9:16": "768x1344",
    "2:1": "1440x720",
    "1:2": "720x1440",
  },
};

export function zaiImageSize(model: string, aspect?: string): string {
  const table = SIZES[model] ?? SIZES["glm-image"];
  return table[aspect || "auto"] ?? table.auto;
}

/** Only the fields this module reads — the endpoint returns more (`created`, usage metadata). */
interface ZaiImageResponse {
  data?: { url?: string }[];
  content_filter?: { role?: string; level?: number }[];
  error?: { message?: string };
  message?: string;
}

export interface ZaiImageInput {
  prompt: string;
  aspect_ratio?: string;
  /** The shared UI control. Z.AI has no resolution tiers, so anything above 1K asks for `hd`. */
  resolution?: "1K" | "2K" | "4K";
}

export async function generateZaiImage(
  model: ZaiImageModelId,
  input: ZaiImageInput,
  apiKey: string,
  baseUrl?: string,
): Promise<{ urls?: string[]; error?: string }> {
  const root = (baseUrl || "").trim().replace(/\/+$/, "") || ZAI_DEFAULT_ROOT;
  try {
    const res = await fetch(`${root}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        size: zaiImageSize(model, input.aspect_ratio),
        ...(input.resolution && input.resolution !== "1K" ? { quality: "hd" } : {}),
      }),
      // Rendering takes longer than a chat completion, and the caller is a user staring at a
      // spinner rather than a background job — 120s is the point where retrying beats waiting.
      signal: AbortSignal.timeout(120_000),
    });
    const data: ZaiImageResponse | null = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `zai_image_${res.status}`;
      return { error: String(msg).slice(0, 300) };
    }
    const urls = (data?.data ?? [])
      .map(d => d?.url)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    if (!urls.length) {
      // A content-filter rejection comes back 200 with an empty data array — say so, rather than
      // letting the caller report a generic failure for a request that was answered and refused.
      const filtered = (data?.content_filter ?? []).some(c => Number(c?.level) > 0);
      return { error: filtered ? "content_filter: the prompt was rejected by Z.AI's safety filter" : "no_image_returned" };
    }
    return { urls };
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { error: "timeout" };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
