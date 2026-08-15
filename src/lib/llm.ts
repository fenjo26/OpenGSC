// Shared multi-provider LLM caller. Mirrors the providers supported elsewhere
// in the app (Anthropic, Z.AI, OpenAI, Gemini, OpenRouter, Kie.ai, Kimi/Moonshot).
//
// Default model ids are NOT written here — they live in lib/providerDefaults.ts, because they
// used to be written in four places that then aged apart. Anything the user chose arrives as
// `modelOverride` and wins outright.

import { defaultModelFor } from '@/lib/providerDefaults';

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

// ── Reading the assistant's text out of a provider response ──────────────────────────
//
// Each of these used to be a single optimistic `data.x?.[0]?.y ?? ''`, and that `?? ''` was
// hiding a whole family of ordinary responses: an Anthropic reply whose FIRST content block is
// a thinking block rather than text, a Gemini answer split across several parts or dropped by a
// safety filter, a reasoning model that spent its entire token budget before emitting any
// content, a refusal (content: null). All of them produced an empty string that was returned as
// a successful completion — and downstream, genOutline saw a value that was "not null but did
// not parse" and blamed the JSON, reporting `parse_failed` for a response that never contained
// any JSON to fail on. Read every block, and let the caller tell EMPTY apart from MALFORMED.

function anthropicText(data: any): string {
  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter(b => (b?.type === 'text' || b?.type === undefined) && typeof b?.text === 'string')
    .map(b => b.text)
    .join('');
  if (text) return text;
  // Last resorts for gateways that label their blocks with something other than "text", and for
  // the flat {text} shape some Anthropic-compatible proxies return instead of a content array.
  const anyText = blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).join('');
  if (anyText) return anyText;
  return typeof data?.text === 'string' ? data.text : '';
}

function geminiText(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
}

// OpenAI-compatible `message.content` is normally a string, but gateways in this provider list
// also return the array-of-parts shape, and a refusal arrives as content:null + `refusal`.
function openAiText(data: any): string {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

// A 200-OK response that carries no text is a real, diagnosable failure — not a parse problem.
// Name the likely cause, because "parse_failed" sent users looking for a JSON bug that was never
// there, and the reasons below are all things the user can actually act on.
function emptyCompletionDetail(provider: string, finish: string | undefined, model: string | undefined, data: any): string {
  const refusal = data?.choices?.[0]?.message?.refusal;
  const blocked = data?.promptFeedback?.blockReason;
  const why =
    finish === 'length' || finish === 'max_tokens'
      ? 'the token limit was reached before any text was produced — a reasoning model can spend the whole budget on hidden reasoning, so lower the reasoning effort or pick a non-reasoning model for the outline step'
      : finish === 'content_filter' || finish === 'SAFETY' || blocked
        ? `the provider's safety filter blocked it (${blocked ?? finish})`
        : refusal
          ? `the model refused: ${String(refusal).slice(0, 160)}`
          : 'the response contained no text block';
  return `${provider}${model ? ` (${model})` : ''}: empty completion — ${why}${finish ? ` [finish_reason: ${finish}]` : ''}`;
}

// Reasoning models (OpenAI gpt-5.x / o-series, kie's Codex endpoint) pin sampling internally and
// reject an explicit `temperature` with a 400. Callers need to know that BEFORE dialling a value —
// the humanize bench greys the slider out rather than firing a request that is guaranteed to fail.
export function supportsTemperature(provider: string, model?: string): boolean {
  if (provider === 'kie') return false;
  const m = (model || '').toLowerCase();
  if (provider === 'openai' && /^(gpt-5|o[1-9])/.test(m)) return false;
  if (provider === 'openrouter' && /(openai\/)?(gpt-5|o[1-9])/.test(m)) return false;
  // Cheaper Inference publishes bare ids with no vendor prefix (`gpt-5.4`, not `openai/gpt-5.4`),
  // so the openrouter pattern above never matches them. Without this line the slider happily sent
  // `temperature` to a GPT-5.x route and got a 400 back that named a parameter the user never
  // typed — the same class of failure the openrouter check exists to prevent.
  if (provider === 'cheaperinference' && /^(gpt-5|o[1-9])/.test(m)) return false;
  return true;
}

/**
 * Z.AI's GLM models think by default, and that default is incompatible with how this app calls them.
 *
 * Per Z.AI's own docs, GLM-5.2 / 5.1 / 5 / 4.7 have thinking ACTIVE out of the box, and GLM-5.2
 * additionally defaults `reasoning_effort` to "max". The reasoning tokens come out of the same
 * `max_tokens` budget as the answer, so a 16k budget — generous for an outline — was being spent
 * entirely on hidden reasoning, and the request returned a 200 with no text at all. Every generation
 * job on this instance failed that way, first disguised as `parse_failed` and then, once the empty
 * completion was reported honestly, as `finish_reason: max_tokens`.
 *
 * So thinking is OFF by default for zai and callers opt back in, rather than the reverse. The shape
 * is Anthropic's own (`{"type": "disabled"}`), which is what the /api/anthropic endpoint speaks.
 * Scoped to zai deliberately: real Anthropic has thinking off by default, so sending the field there
 * would be noise, and other gateways may reject an unknown key outright.
 */
function zaiThinking(provider: string, enableThinking: boolean): { thinking?: { type: string } } {
  if (provider !== 'zai' || enableThinking) return {};
  return { thinking: { type: 'disabled' } };
}

/**
 * Which Z.AI product this instance is calling — and it is two different products.
 *
 * `https://api.z.ai/api/anthropic` is the GLM **Coding Plan** endpoint. Z.AI's own docs say that
 * plan is "strictly limited to use within officially supported tools and products" — Claude Code,
 * Cline, Cursor and the like. A self-hosted SEO app is not on that list, and its traffic there
 * lands on the plan's 5-hour quota, which is why bulk generation came back as
 * `zai 429: Rate limit reached for requests` while the standard API account showed no usage at all.
 *
 * The general-purpose endpoint is `https://api.z.ai/api/paas/v4`, it speaks OpenAI
 * chat-completions, and it bills the ordinary API balance. That is the correct default for this
 * app, so it is what a bare zai key now uses.
 *
 * Setting an explicit base URL still wins, including going back to the Coding Plan endpoint on
 * purpose: any URL ending in `/api/anthropic` is routed through the Anthropic-shaped branch,
 * anything else through the OpenAI-shaped one. Both accept the `thinking` field.
 */
const ZAI_DEFAULT_ROOT = 'https://api.z.ai/api/paas/v4';

function zaiRoot(baseUrl?: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '');
  return b || ZAI_DEFAULT_ROOT;
}

function zaiAnthropicShape(baseUrl?: string): boolean {
  return /\/api\/anthropic$/.test(zaiRoot(baseUrl));
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
  /** Opt back into Z.AI's thinking mode; off by default because it eats the whole max_tokens budget. */
  enableThinking = false,
): Promise<string | null> {
  return (await fetchLLMDetailed(prompt, provider, apiKey, maxTokens, modelOverride, baseUrl, temperature, enableThinking)).text;
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
  /** Opt back into Z.AI's thinking mode; off by default because it eats the whole max_tokens budget. */
  enableThinking = false,
): Promise<{ text: string | null; error?: string; finishReason?: string }> {
  const delays = [0, 5_000, 20_000]; // 3 attempts total
  let lastError: string | undefined;
  // Set from the previous attempt when the response told us how long to wait — a `Retry-After`
  // header, or a gateway 5xx that has already exhausted its own routes. It overrides the generic
  // ladder, which is otherwise far too eager for both cases.
  let askedWait: number | undefined;
  let cap = delays.length;
  for (let i = 0; i < Math.min(cap, delays.length); i++) {
    const wait = i === 0 ? 0 : Math.max(delays[i], askedWait ?? 0);
    if (wait) await new Promise(r => setTimeout(r, wait + Math.floor(Math.random() * 4_000)));
    const r = await fetchLLMOnce(prompt, provider, apiKey, maxTokens, modelOverride, baseUrl, temperature, enableThinking);
    if (r.text != null) return { text: r.text, finishReason: r.finishReason };
    lastError = r.errorDetail;
    askedWait = r.retryAfterMs;
    if (!r.retryable) return { text: null, error: lastError };
    cap = Math.min(cap, attemptCapFor(lastError) ?? delays.length);
    if (i < Math.min(cap, delays.length) - 1) console.error(`[LLM] ${provider} transient failure — retrying (${i + 1}/${Math.min(cap, delays.length) - 1}): ${lastError ?? ""}`);
  }
  return { text: null, error: lastError };
}

const retryableStatus = (s: number) => s === 429 || s === 408 || s >= 500;

// How long to wait before the next attempt, when the response itself says something useful.
//
// Two cases the generic 0/5s/20s ladder gets wrong. A 429 usually carries `Retry-After`, and
// providers ask for it to be respected — retrying earlier just burns an attempt and can extend
// the penalty. And a gateway 5xx arrives only AFTER that gateway has already failed over between
// its own upstream routes and spent its own retry, so repeating five seconds later lands on the
// same broken upstream; waiting longer is what actually gives the route time to come back.
function retryAfterFrom(res: Response, status: number): number | undefined {
  const h = res.headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs) && secs > 0) return Math.min(120_000, secs * 1000);
    const when = Date.parse(h);
    if (Number.isFinite(when)) return Math.min(120_000, Math.max(0, when - Date.now()));
  }
  if (status >= 500) return 15_000;
  return undefined;
}

// Some gateway failures are a property of the ROUTE the gateway chose, not of the request — and
// repeating a request that takes minutes to generate, only to be discarded again, is the most
// expensive way to learn nothing.
//
// The case this exists for: Cheaper Inference ranks upstream routes by price and settles billing
// from the `usage` block the upstream returns. When the chosen route omits `usage`, the gateway
// cannot charge for a generation it has already paid for and answers
// `502 … did not include usage for billing` — AFTER the model finished writing. Three attempts of
// that is a quarter of an hour spent producing three complete answers and throwing all of them
// away. The gateway has already failed over between its own routes before returning the 502, so
// one extra attempt is a fair bet and a second is not; what actually resolves it is choosing a
// different model id, which is what the message now says.
function attemptCapFor(detail: string | undefined): number | undefined {
  if (detail && /\b50\d\b/.test(detail) && /usage\s+for\s+billing|did not include usage/i.test(detail)) return 2;
  return undefined;
}

// Best-effort extraction of a short, human-readable reason from a failed provider response —
// tries the common `{error:{message|type}}` JSON shape used by most providers, else falls back
// to the raw body (truncated). Prefixed with provider+status so it's unambiguous in job.error.
function extractErrorDetail(provider: string, status: number, bodyText: string): string {
  let msg: string = bodyText;
  try {
    const j = JSON.parse(bodyText);
    msg = j?.error?.message || j?.error?.type || j?.message || bodyText;
  } catch { /* not JSON — keep raw body */ }
  const base = `${provider} ${status}: ${String(msg || "").slice(0, 300)}`;
  // The one gateway failure whose fix is a settings change rather than a retry. Left raw, the
  // message describes the GATEWAY's accounting problem and reads like a transient blip, which
  // sends people into retry loops that each cost a full-length generation.
  //
  // Observed on this instance: the SAME provider and model id serve short rewrite calls all day
  // and fail every long outline call, so the trigger is not the model on its own — it correlates
  // with the size of the request. Both known levers are named rather than guessing between them.
  if (status >= 500 && /usage\s+for\s+billing|did not include usage/i.test(base)) {
    return `${base} — the serving route returned no usage block, so the gateway discarded a generation it had already produced. Retrying reproduces it. Two levers: pick a different model for this task in SEO Tools → Settings, or lower this step's token budget (the same model/provider serves short calls on this instance and fails long ones).`;
  }
  return base;
}

async function fetchLLMOnce(
  prompt: string,
  provider: string,
  apiKey: string,
  maxTokens = 1024,
  modelOverride?: string,
  baseUrl?: string,
  temperature?: number,
  /** Opt back into Z.AI's thinking mode; off by default because it eats the whole max_tokens budget. */
  enableThinking = false,
): Promise<{ text: string | null; retryable: boolean; errorDetail?: string; finishReason?: string; retryAfterMs?: number }> {
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
    // Kept alongside `text` so the empty-completion path below can explain ITSELF rather than
    // handing the caller a bare '' and letting it guess what went wrong — and, since it is also
    // RETURNED on success, so a caller can tell a finished answer from one the provider cut off
    // at the token ceiling. A truncated answer used to be indistinguishable from a complete one:
    // the outline step salvaged half a JSON document, shipped it as a finished outline, and the
    // article was written from a structure that stopped mid-way through its own section list.
    let finishReason: string | undefined;
    let lastData: any = null;
    if (provider === 'anthropic' || (provider === 'zai' && zaiAnthropicShape(baseUrl))) {
      // For zai this branch is now the OPT-IN path, reached only when the user points the base URL
      // at the Coding Plan's Anthropic endpoint. See zaiRoot() for why that is no longer the default.
      const root = provider === 'zai' ? zaiRoot(baseUrl) : 'https://api.anthropic.com';
      const model = modelOverride ?? defaultModelFor(provider);
      const res = await fetch(`${root}/v1/messages`, {
        method: 'POST', signal: sig,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }],
          ...temp(temperature, model),
          ...zaiThinking(provider, enableThinking),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM]', provider, res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail(provider, res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.stop_reason;
      text = anthropicText(data);
    } else if (provider === 'openai' || provider === 'deepseek' || provider === 'qwen' || provider === 'zai') {
      // GPT-5.x models reject the legacy `max_tokens` param — `max_completion_tokens` is the
      // replacement and is also accepted by every still-supported older model.
      let url = 'https://api.openai.com/v1/chat/completions';
      if (provider === 'deepseek') url = 'https://api.deepseek.com/chat/completions';
      if (provider === 'qwen') url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
      if (provider === 'zai') url = `${zaiRoot(baseUrl)}/chat/completions`;

      const model = modelOverride ?? defaultModelFor(provider);
      const tokenParam = (provider === 'deepseek' || provider === 'qwen' || provider === 'zai') ? 'max_tokens' : 'max_completion_tokens';

      const res = await fetch(url, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, [tokenParam]: maxTokens, messages: [{ role: 'user', content: prompt }],
          ...temp(temperature, model),
          ...zaiThinking(provider, enableThinking),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error(`[LLM] ${provider}`, res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail(provider, res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.choices?.[0]?.finish_reason;
      text = openAiText(data);
    } else if (provider === 'gemini') {
      const gModel = modelOverride ?? defaultModelFor('gemini');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey}`, {
        method: 'POST', signal: sig,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // Gemini nests sampling under generationConfig rather than at the top level — and that
          // is also the only place an output ceiling can be set. `maxTokens` used to be dropped
          // on the floor here, so every caller silently got the model's own default instead of
          // the budget it asked for. For the outline step that default is well under what a
          // 25-section JSON structure needs, and the response came back cut in half.
          generationConfig: {
            maxOutputTokens: maxTokens,
            ...(temperature !== undefined ? { temperature: clampTemp('gemini', temperature) } : {}),
          },
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] gemini', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('gemini', res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.candidates?.[0]?.finishReason;
      text = geminiText(data);
    } else if (provider === 'openrouter') {
      const orModel = modelOverride ?? defaultModelFor('openrouter');
      // Half of OpenRouter's catalogue reasons by default and bills those tokens against the same
      // `max_tokens` ceiling as the answer, which is fatal for a step whose whole output is one
      // long JSON document. `reasoning: { enabled: false }` is OpenRouter's own documented switch,
      // but it is a gateway-level field and an individual upstream route can still reject it — so
      // a 400 that names it is retried once without, rather than failing the user's generation.
      const orBody = (withReasoning: boolean) => JSON.stringify({
        model: orModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }],
        ...temp(temperature, orModel),
        ...(withReasoning ? {} : { reasoning: { enabled: false } }),
      });
      const orCall = (withReasoning: boolean) => fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: orBody(withReasoning),
      });
      let res = await orCall(enableThinking);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        if (res.status === 400 && !enableThinking && /reasoning/i.test(bodyText)) {
          console.error('[LLM] openrouter: route rejected reasoning:{enabled:false} — retrying without it');
          res = await orCall(true);
        } else {
          console.error('[LLM] openrouter', res.status, bodyText);
          return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('openrouter', res.status, bodyText) };
        }
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] openrouter', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('openrouter', res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.choices?.[0]?.finish_reason;
      text = openAiText(data);
    } else if (provider === 'cheaperinference') {
      // Cheaper Inference — an OpenAI-compatible gateway that ranks provider routes by price and
      // fails over down that ranking, so one id can be served by several upstreams.
      //
      // Two consequences worth knowing about here. First, `max_tokens` rather than
      // `max_completion_tokens`: the gateway forwards both, but the models behind a single id are
      // not all OpenAI's, and `max_tokens` is the parameter every route in the catalogue accepts.
      // Second, no `reasoning` field is sent. Roughly half the catalogue is reasoning-capable and
      // several members (glm-5.2, kimi-k3) think by default — the failure mode this app already
      // has a scar from — but effort levels are per-model there (Kimi K3 takes low/high/max and
      // rejects `medium`), and an unsupported parameter can be rejected outright by the serving
      // provider. Guessing one for an id whose upstream can change between calls trades a known
      // problem for an unpredictable 400. The model picker labels reasoning models instead, so
      // the outline step can be kept off them deliberately.
      const ciModel = modelOverride ?? defaultModelFor('cheaperinference');
      const ciRoot = (baseUrl || 'https://api.cheaperinference.com/v1').replace(/\/+$/, '');
      const res = await fetch(`${ciRoot}/chat/completions`, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ciModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, ciModel) }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] cheaperinference', res.status, bodyText);
        // 402 is this gateway's own signal and deserves to survive the trip: it means the wallet
        // is empty, not that the request was wrong, and retrying it burns three attempts on a
        // condition only the account owner can clear.
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('cheaperinference', res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.choices?.[0]?.finish_reason;
      text = openAiText(data);
    } else if (provider === 'kimi') {
      // Kimi (Moonshot AI) — OpenAI-compatible chat completions. Default: Kimi K3
      // (flagship, 1M context, vision). baseUrl override supported for the .cn endpoint.
      const kimiModel = modelOverride ?? defaultModelFor('kimi');
      const root = (baseUrl || 'https://api.moonshot.ai/v1').replace(/\/+$/, '');
      const res = await fetch(`${root}/chat/completions`, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: kimiModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, kimiModel) }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] kimi', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('kimi', res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.choices?.[0]?.finish_reason;
      text = openAiText(data);
    } else if (provider === 'kie') {
      // Kie.ai "Codex" (GPT-5.5) — Responses API, distinct from the "custom" chat-completions path.
      const root = (baseUrl || 'https://api.kie.ai').replace(/\/+$/, '');
      const res = await fetch(`${root}/codex/v1/responses`, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelOverride ?? defaultModelFor('kie'),
          stream: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          // Reasoning tokens are drawn from the same output budget as the answer, so a step that
          // has to return a long JSON document cannot afford "medium" — it thinks, runs out, and
          // emits a half-written structure. Callers that need JSON pass enableThinking=false
          // (the default) and get the cheapest effort; prose callers opt back in.
          reasoning: { effort: enableThinking ? 'medium' : 'low' },
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] kie', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('kie', res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      // Responses API reports an exhausted budget as an `incomplete` status rather than a
      // finish_reason, so normalise it to the same vocabulary the other branches use.
      finishReason = data?.status === 'incomplete'
        ? (data?.incomplete_details?.reason ?? 'incomplete')
        : data?.status;
      text = parseKieOutput(data);
    } else if (provider === 'custom') {
      // Any OpenAI-compatible endpoint. baseUrl is the API root; we call /chat/completions.
      const root = (baseUrl || '').replace(/\/+$/, '');
      if (!root) { console.error('[LLM] custom: no baseUrl'); return { text: null, retryable: false, errorDetail: 'custom: no baseUrl configured' }; }
      const url = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`;
      // No invented default here. A custom endpoint is an arbitrary OpenAI-compatible server,
      // and the previous fallback sent it `gpt-4o-mini` — an OpenAI model id to a gateway that
      // may never have heard of OpenAI. The 404 that came back looked like the user's server
      // was broken. Saying "no model configured" points at the actual missing setting.
      const customModel = modelOverride ?? defaultModelFor('custom');
      if (!customModel) {
        console.error('[LLM] custom: no model configured');
        return { text: null, retryable: false, errorDetail: 'custom: no model configured — set one in Settings' };
      }
      const res = await fetch(url, {
        method: 'POST', signal: sig,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: customModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...temp(temperature, customModel) }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('[LLM] custom', res.status, bodyText);
        return { text: null, retryable: retryableStatus(res.status), retryAfterMs: retryAfterFrom(res, res.status), errorDetail: extractErrorDetail('custom', res.status, bodyText) };
      }
      const data = await res.json();
      lastData = data;
      finishReason = data?.choices?.[0]?.finish_reason;
      text = openAiText(data);
    } else {
      // No branch matched. This used to fall through to `return { text: '' }` — a *successful*
      // empty completion for a provider that was never called at all, which the outline pipeline
      // then reported as `parse_failed`. Say what actually happened instead.
      console.error('[LLM] unknown provider:', provider);
      return { text: null, retryable: false, errorDetail: `unknown AI provider "${provider}" — pick one in SEO Tools → Settings` };
    }
    // An empty body from a 200-OK call is a failure, and it must not be handed back as text.
    // Returning '' here is what made a provider-side problem (token budget spent on hidden
    // reasoning, safety filter, refusal, thinking-only reply) surface three layers away as a
    // JSON parse error. Not retryable: the same request would burn the user's credits to
    // produce the same empty answer.
    if (!text.trim()) {
      const detail = emptyCompletionDetail(provider, finishReason, modelOverride, lastData);
      console.error('[LLM]', detail);
      return { text: null, retryable: false, errorDetail: detail };
    }
    return { text, retryable: false, finishReason };
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
      const model = modelOverride ?? defaultModelFor(provider, 'vision');
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
      const gModel = modelOverride ?? defaultModelFor('gemini', 'vision');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey}`, {
        method: 'POST', signal: sig,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: b64 } }] }] }),
      });
      if (!res.ok) { console.error('[LLM vision] gemini', res.status); return null; }
      const data = await res.json();
      text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (provider === 'openai' || provider === 'openrouter' || provider === 'custom' || provider === 'kimi' || provider === 'deepseek' || provider === 'qwen' || provider === 'cheaperinference') {
      const dataUrl = `data:${mimeType};base64,${b64}`;
      const content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ];
      let url = 'https://api.openai.com/v1/chat/completions';
      let model = modelOverride ?? defaultModelFor('openai', 'vision');
      let tokenParam = 'max_completion_tokens'; // GPT-5.x rejects legacy max_tokens
      if (provider === 'deepseek') { url = 'https://api.deepseek.com/chat/completions'; model = modelOverride ?? defaultModelFor('deepseek', 'vision'); tokenParam = 'max_tokens'; }
      if (provider === 'qwen') { url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'; model = modelOverride ?? defaultModelFor('qwen', 'vision'); tokenParam = 'max_tokens'; }
      if (provider === 'openrouter') { url = 'https://openrouter.ai/api/v1/chat/completions'; model = modelOverride ?? defaultModelFor('openrouter', 'vision'); tokenParam = 'max_tokens'; }
      if (provider === 'cheaperinference') { url = `${(baseUrl || 'https://api.cheaperinference.com/v1').replace(/\/+$/, '')}/chat/completions`; model = modelOverride ?? defaultModelFor('cheaperinference', 'vision'); tokenParam = 'max_tokens'; }
      if (provider === 'kimi') { url = `${(baseUrl || 'https://api.moonshot.ai/v1').replace(/\/+$/, '')}/chat/completions`; model = modelOverride ?? defaultModelFor('kimi', 'vision'); tokenParam = 'max_tokens'; }
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
          model: modelOverride ?? defaultModelFor('kie', 'vision'),
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
