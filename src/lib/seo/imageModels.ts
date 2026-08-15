// The one list of image models the app offers, and the only place that knows which provider —
// and therefore which API key — each one needs.
//
// It lives apart from the two transports (kieImages.ts, zaiImages.ts) because the picker in
// SeoTextDetail has to render both families in a single dropdown, and a UI component should not
// have to import from every provider module to do that.

export type ImageProvider = "kie" | "zai";

export interface ImageModelDef {
  id: string;
  label: string;
  provider: ImageProvider;
  /** localStorage / seoSettings key holding this provider's API key. */
  keyName: string;
  /** true when the provider returns a task id to poll instead of the finished image. */
  async: boolean;
}

export const IMAGE_MODELS: ImageModelDef[] = [
  { id: "gpt-image-2-text-to-image", label: "GPT Image-2 (text → image)", provider: "kie", keyName: "aiKey_kie", async: true },
  { id: "nano-banana-2", label: "Google Nano Banana 2 (text/image → image)", provider: "kie", keyName: "aiKey_kie", async: true },
  { id: "glm-image", label: "Z.AI GLM-Image (text → image)", provider: "zai", keyName: "aiKey_zai", async: false },
  { id: "cogview-4-250304", label: "Z.AI CogView-4 (text → image)", provider: "zai", keyName: "aiKey_zai", async: false },
];

export type ImageModelId = string;

export const IMAGE_MODEL_BY_ID: Record<string, ImageModelDef> =
  Object.fromEntries(IMAGE_MODELS.map(m => [m.id, m]));

export function imageModel(id: string): ImageModelDef | undefined {
  return IMAGE_MODEL_BY_ID[id];
}
