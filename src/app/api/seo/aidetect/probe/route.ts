import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchLLMDetailed, supportsTemperature } from "@/lib/llm";

// POST /api/seo/aidetect/probe — generate ONE writing sample with an explicit model + temperature.
//
// This is the bench primitive. The single strongest finding in the research this feature is built
// on is that the *model* dominates every prompt-side trick — the same prompt through two models
// scored 93% and 75%. That comparison was run on an early-2026 line-up which no longer resembles
// what this app talks to, so the useful move is not to trust the published ranking but to re-run it
// against the models the operator actually has keys for. Hence: same prompt, swap one variable.
//
// Deliberately NOT the full generation pipeline. Chunking, fact-checking and the volume guard would
// each perturb the token distribution and confound the comparison; the bench needs one clean call.
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const prompt = String(b.prompt ?? "").trim();
  const provider = String(b.aiProvider ?? "");
  const apiKey = String(b.aiApiKey ?? "");
  const model = b.model ? String(b.model) : undefined;
  if (!prompt) return NextResponse.json({ error: "no_prompt" }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "no_ai_key" }, { status: 400 });

  const wants = b.temperature === undefined || b.temperature === null ? undefined : Number(b.temperature);
  const canTemp = supportsTemperature(provider, model);
  // Report back when a requested temperature was dropped, so a bench row can't silently claim to
  // have tested t=0.7 on a reasoning model that pins sampling internally.
  const temperature = wants !== undefined && canTemp ? wants : undefined;

  const started = Date.now();
  const r = await fetchLLMDetailed(
    prompt, provider, apiKey,
    Math.max(256, Math.min(8000, Number(b.maxTokens) || 1400)),
    model, b.aiBaseUrl ? String(b.aiBaseUrl) : undefined,
    temperature,
  );

  if (r.text == null) {
    return NextResponse.json({ error: r.error || "generation_failed" }, { status: 502 });
  }

  return NextResponse.json({
    text: r.text,
    provider,
    model: model || "(provider default)",
    temperature: temperature ?? null,
    temperatureIgnored: wants !== undefined && !canTemp,
    ms: Date.now() - started,
  });
}
