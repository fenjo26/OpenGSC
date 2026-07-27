// Shared multi-provider LLM caller. Mirrors the providers supported elsewhere
// in the app (Anthropic, Z.AI, OpenAI, Gemini, OpenRouter, Kie.ai, Kimi/Moonshot).

// Kie.ai's "Codex" endpoint (GPT-5.5) speaks the OpenAI *Responses* API shape, not classic
// chat-completions: `input` is an array of {role, content:[...]} messages (content items are
// {type:"input_text"|"input_image"|"input_file", ...}), and the reply comes back as an `output`
// array of items — a "reasoning" item (usually empty/summary-only) and a "message" item whose
// content holds the actual text. Shared by fetchLLM + fetchLLMVision below.
function parseKieOutput(data: any): string {
  const out: any[] = Array.isArray(data?.output) ? data.output : [];
  for (const item of out) {
    if (item?.type === 'message') {
      const content: any[] = Array.isArray(item.content) ? item.content : [];
      const part = content.find((c: any) => c?.type === 'output_text' || typeof c?.text === 'string');
      if (part?.text) return part.text;
    }
  }
  return typeof data?.output_text === 'string' ? data.output_text : '';
}

// Reasoning models (OpenAI gpt-5.x / o-series, kie's Codex endpoint) pin sampling internally and
// reject an explicit `temperature` with a 400. Callers need to know that BEFORE dialling a value —
// the humanize bench greys the slider out rather than firing a request that is guaranteed to fail.
export function supportsTemperature(provider: string, model?: string): boolean {
  if (provider === 'kie') return false;
  const m = (model || '').toLowerCase();
  if (provider === 'openai' && /^(gpt-5|o[1-9])/.test(m)) return false;
  if (provider === 'openrouter' && /(openai\/)?(gpt-5|o[1-9])/.test(m)) return false;
  return true;
}

// Anthropic caps temperature at 1.0; the OpenAI-compatible family accepts up to 2.0. Clamping here
// keeps a single UI slider honest across providers instead of surfacing provider-specific 400s.
function clampTemp(provider: string, t: number): number {
  const max = (provider === 'anthropic' || provider === 'zai' || provider === 'gemini') ? 1 : 2;
  return Math.max(0, Math.min(max, t));
}

// Public entry: retries transient failures (429 rate limits, 408/5xx, network drops, timeouts)
// with exponential backoff + jitter. The multi-pass pipeline fires parallel calls, so hitting
// a provider's TPM/RPM limit is routine — one 429 must not sink a whole generation job.
//
// `temperature` is optional and OMITTED from the request when undefined, which preserves the exact
// wire format every existing caller relies on — important, this runs in production for live users.
export async function fetchLLM(
  prompt: string,
  provider: string,
  apiKey: string,
  maxTokens = 1024,
  modelOverride?: string,
  baseUrl?: string,
  temperature?: number,
): Promise<string | null> {
  return (await fetchLLMDetailed(prompt, provider, apiKey, maxTokens, modelOverride, baseUrl, temperature)).text;
}

// Same retry loop as fetchLLM, but also surfaces the provider's error detail (status + message)
// from the LAST attempt when every attempt failed — so a caller that finally gives up (e.g.
// genText's "generation_failed" path) can report something actionable, like "z.ai 400: System
// detected potentially unsafe or sensitive content" instead of a bare generic string that sends
// users spelunking through `pm2 logs` to find out their whole niche got flagged by the provider's
// own content-moderation filter.
export async function fetchLLMDetailed(
  prompt: string,
  provider: string,
  apiKey: string,
  maxTokens = 1024,
  modelOverride?: string,
  baseUrl?: string,
  temperature?: number,
): Promise<{ text: string | null; error?: string }> {
  const delays = [0, 5_000, 20_000]; // 3 attempts total
  let lastError: string | undefined;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i] + Math.floor(Math.random() * 4_000)));
    const r = await fetchLLMOnce(prompt, provider, apiKey, maxTokens, modelOverride, baseUrl, temperature);
    if (r.text != null) return { text: r.text };
    lastError = r.errorDetail;
    if (!r.retryable) return { text: null, error: lastError };
    if (i < delays.length - 1) console.error(`[LLM] ${provider} transient failure — retrying (${i + 1}/${delays.length - 1})`);
  }
  return { text: null, error: lastError };
}

const retryableStatus = (s: number) => s === 429 || s === 408 || s >= 500;

// Best-effort extraction of a short, human-readable reason from a failed provider response —
// tries the common `{error:{message|type}}` JSON shape used by most providers, else falls back
// to the raw body (truncated). Prefixed with provider+status so it's unambiguous in job.error.
function extractErrorDetail(provider: string, status: number, bodyText: string): string {
  let msg: string = bodyText;
  try {
    const j = JSON.parse(bodyText);
    msg = j?.error?.message || j?.error?.type || j?.message || bodyText;
  } catch { /* not JSON — keep raw body */ }
  return `${provider} ${status}: ${String(msg || "").slice(0, 300)}`;
}

async function fetchLLMOnce(
  prompt: string,
  provider: string,
  apiKey: string,
  maxTokens = 1024,
  modelOverride?: string,
  baseUrl?: string,
  temperature?: number,
): Promise<{ text: string | null; retryable: boolean; errorDetail?: string }> {
  // Hard timeout so a stuck/over-long generation fails in minutes instead of hanging forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 280_000);
  const sig = ctrl.signal;
  // Spread into a request body only when the caller asked for a temperature AND the target model
  // accepts one — an empty spread leaves the payload byte-identical to the pre-temperature version.
  const temp = (t: number | undefined, model?: string): { temperature?: number } =>
    t === undefined || !supportsTemperature(provider, model) ? {} : { temperature: clampTemp(provider, t) };
  try {
    let text = '';
    if (provider === 'anthropic' || provider === 'zai') {
      const baseUrl = provider === 'zai' ? 'https://api.z.ai/api/anthropic' : 'https://api.anthropic.com';
      const model = modelOverride ?? (provider === 'zai' ? 'glm-5.2' : 'claude-haiku-4-5-20251001');
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST', signal: sig,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, model) }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM]', provider, res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail(provider, res.status, bodyText) };
      }
      const data = await res.json();
      text = data.content?.[0]?.text ?? '';
    } else if (provider === 'openai' || provider === 'deepseek' || provider === 'qwen') {
      // GPT-5.x models reject the legacy `max_tokens` param — `max_completion_tokens` is the
      // replacement and is also accepted by every still-supported older model.
      let url = 'https://api.openai.com/v1/chat/completions';
      if (provider === 'deepseek') url = 'https://api.deepseek.com/chat/completions';
      if (provider === 'qwen') url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

      const defaultModel = provider === 'deepseek' ? 'deepseek-v4-flash' : provider === 'qwen' ? 'qwen-max' : 'gpt-5.6-luna';
      const model = modelOverride ?? defaultModel;
      const tokenParam = (provider === 'deepseek' || provider === 'qwen') ? 'max_tokens' : 'max_completion_tokens';

      const res = await fetch(url, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, [tokenParam]: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, model) }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error(`[LLM] ${provider}`, res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail(provider, res.status, bodyText) };
      }
      const data = await res.json();
      text = data.choices?.[0]?.message?.content ?? '';
    } else if (provider === 'gemini') {
      const gModel = modelOverride ?? 'gemini-3-flash';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey}`, {
        method: 'POST', signal: sig,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // Gemini nests sampling under generationConfig rather than at the top level.
          ...(temperature !== undefined ? { generationConfig: { temperature: clampTemp('gemini', temperature) } } : {}),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] gemini', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail('gemini', res.status, bodyText) };
      }
      const data = await res.json();
      text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelOverride ?? 'anthropic/claude-haiku-4.5', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, modelOverride ?? 'anthropic/claude-haiku-4.5') }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] openrouter', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail('openrouter', res.status, bodyText) };
      }
      const data = await res.json();
      text = data.choices?.[0]?.message?.content ?? '';
    } else if (provider === 'kimi') {
      // Kimi (Moonshot AI) — OpenAI-compatible chat completions. Default: Kimi K3
      // (flagship, 1M context, vision). baseUrl override supported for the .cn endpoint.
      const root = (baseUrl || 'https://api.moonshot.ai/v1').replace(/\/+$/, '');
      const res = await fetch(`${root}/chat/completions`, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelOverride ?? 'kimi-k3', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, modelOverride ?? 'kimi-k3') }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] kimi', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail('kimi', res.status, bodyText) };
      }
      const data = await res.json();
      text = data.choices?.[0]?.message?.content ?? '';
    } else if (provider === 'kie') {
      // Kie.ai "Codex" (GPT-5.5) — Responses API, distinct from the "custom" chat-completions path.
      const root = (baseUrl || 'https://api.kie.ai').replace(/\/+$/, '');
      const res = await fetch(`${root}/codex/v1/responses`, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelOverride ?? 'gpt-5-5',
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          reasoning: { effort: 'medium' },
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] kie', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail('kie', res.status, bodyText) };
      }
      const data = await res.json();
      text = parseKieOutput(data);
    } else if (provider === 'custom') {
      // Any OpenAI-compatible endpoint. baseUrl is the API root; we call /chat/completions.
      const root = (baseUrl || '').replace(/\/+$/, '');
      if (!root) { console.error('[LLM] custom: no baseUrl'); return { text: null, retryable: false, errorDetail: 'custom: no baseUrl configured' }; }
      const url = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelOverride ?? 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, modelOverride ?? '') }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] custom', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), errorDetail: extractErrorDetail('custom', res.status, bodyText) };
      }
      const data = await res.json();
      text = data.choices?.[0]?.message?.content ?? '';
    }
    return { text, retryable: false };
  } catch (e) {
    // AbortError = our 280s timeout; TypeError "fetch failed" = transient network — both retryable.
    const isTimeout = (e as any)?.name === 'AbortError';
    console.error('[LLM] fetchLLM error:', isTimeout ? 'timeout' : e);
    return { text: null, retryable: true, errorDetail: isTimeout ? `${provider}: request timed out (280s)` : `${provider}: ${String((e as any)?.message ?? e)}`.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// Vision variant — same provider set, but the message carries an image alongside the prompt.
// Used by Landing-flow's "разобрать по скриншоту" (screenshot → page structure) feature.
export async function fetchLLMVision(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  provider: string,
  apiKey: string,
  maxTokens = 2048,
  modelOverride?: string,
  baseUrl?: string,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 280_000);
  const sig = ctrl.signal;
  const b64 = imageBase64.includes(',') ? imageBase64.split(',').pop()! : imageBase64;
  try {
    let text = '';
    if (provider === 'anthropic' || provider === 'zai') {
      const base = provider === 'zai' ? 'https://api.z.ai/api/anthropic' : 'https://api.anthropic.com';
      const model = modelOverride ?? (provider === 'zai' ? 'glm-4.5v' : 'claude-haiku-4-5-20251001');
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST', signal: sig,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } },
            { type: 'text', text: prompt },
          ] }],
        }),
      });
      if (!res.ok) { console.error('[LLM vision]', provider, res.status, await res.text()); return null; }
      const data = await res.json();
      text = data.content?.[0]?.text ?? '';
    } else if (provider === 'gemini') {
      const gModel = modelOverride ?? 'gemini-3-flash';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey}`, {
        method: 'POST', signal: sig,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: b64 } }] }] }),
      });
      if (!res.ok) { console.error('[LLM vision] gemini', res.status); return null; }
      const data = await res.json();
      text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (provider === 'openai' || provider === 'openrouter' || provider === 'custom' || provider === 'kimi' || provider === 'deepseek' || provider === 'qwen') {
      const dataUrl = `data:${mimeType};base64,${b64}`;
      const content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ];
      let url = 'https://api.openai.com/v1/chat/completions';
      let model = modelOverride ?? 'gpt-5.6-luna';
      let tokenParam = 'max_completion_tokens'; // GPT-5.x rejects legacy max_tokens
      if (provider === 'deepseek') { url = 'https://api.deepseek.com/chat/completions'; model = modelOverride ?? 'deepseek-v4-flash'; tokenParam = 'max_tokens'; }
      if (provider === 'qwen') { url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'; model = modelOverride ?? 'qwen-vl-plus'; tokenParam = 'max_tokens'; }
      if (provider === 'openrouter') { url = 'https://openrouter.ai/api/v1/chat/completions'; model = modelOverride ?? 'anthropic/claude-haiku-4.5'; tokenParam = 'max_tokens'; }
      if (provider === 'kimi') { url = `${(baseUrl || 'https://api.moonshot.ai/v1').replace(/\/+$/, '')}/chat/completions`; model = modelOverride ?? 'kimi-k3'; tokenParam = 'max_tokens'; }
      if (provider === 'custom') {
        const root = (baseUrl || '').replace(/\/+$/, '');
        if (!root) { console.error('[LLM vision] custom: no baseUrl'); return null; }
        url = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`;
        tokenParam = 'max_tokens';
      }
      const res = await fetch(url, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, [tokenParam]: maxTokens, messages: [{ role: 'user', content }] }),
      });
      if (!res.ok) { console.error('[LLM vision]', provider, res.status, await res.text().catch(() => '')); return null; }
      const data = await res.json();
      text = data.choices?.[0]?.message?.content ?? '';
    } else if (provider === 'kie') {
      // NOTE: the Codex Responses API's `input_image.image_url` is documented as a "publicly
      // accessible URL" — unclear if kie.ai's backend also accepts base64 data URIs the way
      // OpenAI's own Responses API does. Untested against a real key; falls back cleanly (non-200)
      // if the backend rejects it, same as any other provider error path here.
      const root = (baseUrl || 'https://api.kie.ai').replace(/\/+$/, '');
      const dataUrl = `data:${mimeType};base64,${b64}`;
      const res = await fetch(`${root}/codex/v1/responses`, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelOverride ?? 'gpt-5-5',
          stream: false,
          input: [{ role: 'user', content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: dataUrl },
          ] }],
          reasoning: { effort: 'medium' },
        }),
      });
      if (!res.ok) { console.error('[LLM vision] kie', res.status, await res.text().catch(() => '')); return null; }
      const data = await res.json();
      text = parseKieOutput(data);
    } else {
      console.error('[LLM vision] unsupported provider', provider);
      return null;
    }
    return text;
  } catch (e) {
    console.error('[LLM vision] fetchLLMVision error:', (e as any)?.name === 'AbortError' ? 'timeout' : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
