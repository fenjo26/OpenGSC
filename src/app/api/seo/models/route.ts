import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";

// POST /api/seo/models  { provider, apiKey }
// Fetches the live model list from the provider's API (server-side to avoid CORS).
// Returns { models: [{ id, label }] }.
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("act");
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const b = await req.json();
  const provider = String(b.provider ?? "");
  const apiKey = String(b.apiKey ?? "");
  if (!provider || !apiKey) return NextResponse.json({ error: "missing", models: [] }, { status: 400 });

  try {
    const models = await listModels(provider, apiKey);
    return NextResponse.json({ models });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e), models: [] }, { status: 502 });
  }
}

type M = { id: string; label: string };

async function listModels(provider: string, apiKey: string): Promise<M[]> {
  const timeout = AbortSignal.timeout(12000);

  if (provider === "anthropic" || provider === "zai") {
    const base = provider === "zai" ? "https://api.z.ai/api/anthropic" : "https://api.anthropic.com";
    const res = await fetch(`${base}/v1/models?limit=100`, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: timeout,
    });
    if (!res.ok) {
      // Z.ai may not expose the anthropic models endpoint — fall back to a known set.
      if (provider === "zai") return ZAI_FALLBACK;
      throw new Error(`anthropic ${res.status}`);
    }
    const data = await res.json();
    const arr: any[] = data.data ?? data.models ?? [];
    return arr.map((m) => ({ id: m.id, label: m.display_name || m.id })).filter((m) => m.id);
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout,
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const data = await res.json();
    const arr: any[] = data.data ?? [];
    return arr
      .map((m) => m.id as string)
      .filter((id) => /^(gpt-|o[1-9]|chatgpt)/i.test(id) && !/(instruct|audio|realtime|transcribe|tts|search|image)/i.test(id))
      .sort()
      .map((id) => ({ id, label: id }));
  }

  if (provider === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: timeout });
    if (!res.ok) throw new Error(`openrouter ${res.status}`);
    const data = await res.json();
    const arr: any[] = data.data ?? [];
    return arr.map((m) => ({ id: m.id as string, label: m.name || m.id })).filter((m) => m.id).slice(0, 300);
  }

  if (provider === "gemini") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`, { signal: timeout });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const data = await res.json();
    const arr: any[] = data.models ?? [];
    return arr
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ""), label: m.displayName || m.name }))
      .filter((m) => m.id);
  }

  if (provider === "kimi") {
    // Moonshot AI — OpenAI-compatible /v1/models. Falls back to the known current lineup.
    try {
      const res = await fetch("https://api.moonshot.ai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout,
      });
      if (!res.ok) throw new Error(`kimi ${res.status}`);
      const data = await res.json();
      const arr: any[] = data.data ?? [];
      const models = arr.map((m) => ({ id: m.id as string, label: m.id as string })).filter((m) => m.id);
      return models.length ? models : KIMI_FALLBACK;
    } catch {
      return KIMI_FALLBACK;
    }
  }

  if (provider === "kie") {
    // Kie.ai's Codex Responses endpoint currently exposes a single fixed model — no public
    // /models listing to query, so just surface the one known id (matches fetchLLM's default).
    return [{ id: "gpt-5-5", label: "GPT-5.5 (Codex)" }];
  }

  if (provider === "deepseek") {
    try {
      const res = await fetch("https://api.deepseek.com/models", {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout,
      });
      if (!res.ok) throw new Error(`deepseek ${res.status}`);
      const data = await res.json();
      const arr: any[] = data.data ?? [];
      const models = arr.map((m) => ({ id: m.id as string, label: m.id as string })).filter((m) => m.id);
      return models.length ? models : DEEPSEEK_FALLBACK;
    } catch {
      return DEEPSEEK_FALLBACK;
    }
  }

  if (provider === "qwen") {
    return QWEN_FALLBACK;
  }

  return [];
}

const KIMI_FALLBACK: M[] = [
  { id: "kimi-k3", label: "Kimi K3 (flagship, 1M context, vision)" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code High-Speed" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
];

// Only used when Z.ai's models endpoint is unreachable — keep the current flagship first.
const ZAI_FALLBACK: M[] = [
  { id: "glm-5.2", label: "GLM-5.2 (flagship)" },
  { id: "glm-4.6", label: "GLM-4.6" },
  { id: "glm-4.5", label: "GLM-4.5" },
  { id: "glm-4.5-air", label: "GLM-4.5-Air" },
];

const DEEPSEEK_FALLBACK: M[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
];

const QWEN_FALLBACK: M[] = [
  { id: "qwen-max", label: "Qwen-Max (flagship)" },
  { id: "qwen-plus", label: "Qwen-Plus" },
  { id: "qwen-turbo", label: "Qwen-Turbo" },
  { id: "qwen2.5-coder-72b-instruct", label: "Qwen 2.5 Coder 72B" },
  { id: "qwen2.5-72b-instruct", label: "Qwen 2.5 72B" },
];
