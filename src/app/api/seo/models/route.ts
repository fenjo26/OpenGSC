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
    // The catalogue is ~400 models and this list gets truncated, so WHICH 400 arrive matters.
    // Unfiltered and unsorted it came back in the API's own order and was cut at 300 — which
    // quietly dropped real models off the end of the picker, and kept image- and embedding-only
    // ids that `fetchLLM` cannot call at all. Asking for text output, newest first, means the
    // truncation now only ever loses the oldest models, and everything listed is callable.
    const url = "https://openrouter.ai/api/v1/models?output_modalities=text&sort=newest";
    let arr: any[] = [];
    const res = await fetch(url, { signal: timeout });
    if (res.ok) {
      arr = (await res.json()).data ?? [];
    } else {
      // The filter params are newer than the endpoint; an older/proxied deployment that rejects
      // them should still produce a usable list rather than an empty picker.
      const plain = await fetch("https://openrouter.ai/api/v1/models", { signal: timeout });
      if (!plain.ok) throw new Error(`openrouter ${res.status}`);
      arr = (await plain.json()).data ?? [];
    }
    return arr.map((m) => ({ id: m.id as string, label: orLabel(m) })).filter((m) => m.id).slice(0, 300);
  }

  if (provider === "cheaperinference") {
    // A price-routing gateway: same public id, cheapest eligible upstream, so the catalogue is
    // the only honest source for what an id costs today and what it can do. `type=text` keeps the
    // image-generation ids out — they are served by /v1/images/generations and are rejected by
    // the chat endpoint this app calls, so listing them would only produce 400s.
    const res = await fetch("https://api.cheaperinference.com/v1/models?type=text", {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: timeout,
    });
    if (!res.ok) throw new Error(`cheaperinference ${res.status}`);
    const data = await res.json();
    const arr: any[] = data.data ?? data.models ?? [];
    return arr.map((m) => ({ id: String(m.id), label: ciLabel(m) })).filter((m) => m.id);
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

// ─── Labels ─────────────────────────────────────────────────────────────────────
//
// The picker is where a user decides what every generation job will cost and whether the outline
// step is about to run on a model that thinks. Both facts are in the catalogue response and were
// being thrown away, leaving a bare id — so the answer to "is glm-5.2 a reasoning model" lived
// only in whatever the user happened to remember. This instance has already lost a night to that
// exact question (a reasoning model spent a 16k budget on hidden reasoning and returned nothing),
// which is why the marker is in the label rather than a tooltip.

const perMillion = (v: unknown): string | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  if (!isFinite(n) || n <= 0) return null;
  // OpenRouter prices per token, Cheaper Inference per million — callers pass the per-million value.
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
};

function orLabel(m: any): string {
  const name = m.name || m.id;
  const bits: string[] = [];
  const inPrice = perMillion(parseFloat(m?.pricing?.prompt) * 1e6);
  const outPrice = perMillion(parseFloat(m?.pricing?.completion) * 1e6);
  if (inPrice && outPrice) bits.push(`${inPrice}/${outPrice} per 1M`);
  else if (inPrice === null && outPrice === null && m?.pricing) bits.push("free");
  const ctx = Number(m?.context_length);
  if (isFinite(ctx) && ctx > 0) bits.push(`${Math.round(ctx / 1000)}k ctx`);
  if ((m?.supported_parameters ?? []).includes("reasoning")) bits.push("reasoning");
  return bits.length ? `${name} — ${bits.join(" · ")}` : name;
}

function ciLabel(m: any): string {
  const bits: string[] = [];
  const inPrice = perMillion(m?.pricing?.input_per_million);
  const outPrice = perMillion(m?.pricing?.output_per_million);
  if (inPrice && outPrice) bits.push(`${inPrice}/${outPrice} per 1M`);
  const caps = m?.capabilities ?? {};
  if (caps.reasoning) bits.push("reasoning");
  if (caps.vision) bits.push("vision");
  const vendor = m?.provider || m?.owned_by;
  const head = vendor ? `${m.id} (${vendor})` : String(m.id);
  return bits.length ? `${head} — ${bits.join(" · ")}` : head;
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
