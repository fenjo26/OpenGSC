// What model to send when the user has chosen none — one table, for every provider.
//
// These ids were previously written inline at each call site, and each copy aged separately.
// `lib/llm.ts` had moved on to `gpt-5.6-luna` / `gemini-3-flash` / `kimi-k3` while two GSC
// routes, which had grown their own private forks of the same client, were still asking for
// `gpt-4o-mini`, `gemini-1.5-flash` and `claude-3.5-haiku`. Nothing failed — the ids still
// resolved and the calls still succeeded, so the drift was invisible until someone read all
// four implementations side by side.
//
// A default is not a user preference. Anything the user picks arrives as `modelOverride` and
// wins outright (see resolveTaskCreds in lib/seo/keys.ts); this table only answers "nothing was
// chosen, and we still have to put a string in the request".

export type ModelKind = "chat" | "vision";

interface ProviderDefault {
  chat: string;
  vision: string;
}

// Deliberately the cheap/fast tier of each provider. Callers that need better say so explicitly
// — a default that quietly bills flagship rates is worse than one that is a little weak.
const DEFAULTS: Record<string, ProviderDefault> = {
  anthropic:  { chat: "claude-haiku-4-5-20251001", vision: "claude-haiku-4-5-20251001" },
  zai:        { chat: "glm-5.2",                   vision: "glm-4.5v" },
  openai:     { chat: "gpt-5.6-luna",              vision: "gpt-5.6-luna" },
  gemini:     { chat: "gemini-3-flash",            vision: "gemini-3-flash" },
  openrouter: { chat: "anthropic/claude-haiku-4.5", vision: "anthropic/claude-haiku-4.5" },
  // Cheaper Inference is a price-routing gateway, so its ids are bare (no vendor prefix) and
  // the same id can be served by different upstreams call to call. Luna is its cheapest
  // vision-capable text model, which is what a default is for.
  cheaperinference: { chat: "gpt-5.6-luna", vision: "gpt-5.6-luna" },
  kimi:       { chat: "kimi-k3",                   vision: "kimi-k3" },
  kie:        { chat: "gpt-5-5",                   vision: "gpt-5-5" },
  deepseek:   { chat: "deepseek-v4-flash",         vision: "deepseek-v4-flash" },
  qwen:       { chat: "qwen-max",                  vision: "qwen-vl-plus" },
  // Ollama fronts two very different catalogues: the daemon on this machine (whatever the
  // operator pulled) and Ollama Cloud (a fixed hosted set behind an API key). Cloud is the app's
  // default target, so its default ids are knowable and set here; a LOCAL endpoint keeps the old
  // "no invented id" rule, because a cloud id sent to a daemon that never pulled it is a 404 that
  // reads as "Ollama is broken". `ollamaChatModel` applies that split; `defaultModelFor` stays a
  // plain table read so the UI can label the card's default.
  //
  // `vision` is the multimodal default — verified live against ollama.com on a real PNG
  // (gemma4:31b, kimi-k3 and mistral-large-4 all answered correctly; the flagship ids
  // accept images too, at flagship prices). "custom" keeps its empty default: an arbitrary
  // OpenAI-compatible endpoint's catalogue is unknowable, and inventing `gpt-4o-mini` there
  // produced a 404 from the user's own gateway with no hint that the app had invented the id.
  ollama:     { chat: "deepseek-v4.1-flash:1017-cloud", vision: "gemma4:31b" },
};

// The provider every AI surface runs on when the user has expressed no preference. Changing it
// here changes the browser fallbacks (lib/seo/keys.ts) and the server-side ones (lib/mcp/shared,
// the generation routes) together — before this constant existed those were 28 separate literals
// that all said "anthropic", so a deployment could not actually choose its default.
//
// Upstream keeps "anthropic": the default is what a fresh install with nothing configured sees,
// and a "no key for Anthropic" banner points at a working setup faster than an Ollama default
// points at installing a local daemon. Ollama is a fully supported first-class provider (card,
// keyless local daemons, Cloud via key, fallbacks) — it is just not the assumed default.
// A fork that runs on Ollama flips this one line.
export const DEFAULT_AI_PROVIDER = "anthropic";

// Ollama's hosted API. OpenAI-compatible, key required. This is the endpoint every cloud call
// goes to when the user has not stored one.
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

// The loopback daemon. Keyless by design (a default local install has no auth), which stays a
// supported configuration — it is just no longer the ASSUMED one: a stored key means Cloud.
export const OLLAMA_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * Back-compat alias. Older call sites read this as "the Ollama endpoint when none is stored",
 * which was always the daemon; resolution now depends on whether a key is present, so those
 * call sites use `ollamaEndpoint()` instead. This stays pointed at the daemon because a caller
 * that reaches for a bare constant is the keyless case.
 */
export const OLLAMA_DEFAULT_BASE_URL = OLLAMA_LOCAL_BASE_URL;

/**
 * Default model id for a provider, or "" when there is no defensible guess.
 *
 * "custom" returns "" on purpose. It is an arbitrary OpenAI-compatible endpoint, and the old
 * code defaulted it to `gpt-4o-mini` — an OpenAI model id sent to a server that may well have
 * never heard of OpenAI. That produced a 404 from the user's own gateway with no hint that the
 * app had invented the id. An empty default makes the caller fail with "no model configured",
 * which is the actual problem.
 */
export function defaultModelFor(provider: string, kind: ModelKind = "chat"): string {
  return DEFAULTS[provider]?.[kind] ?? "";
}

export const SUPPORTED_PROVIDERS = Object.keys(DEFAULTS);

// ─── Ollama endpoint + model resolution ─────────────────────────────────────────────────────
//
// One rule, three surfaces (chat, vision, catalogue discovery) so they can never disagree about
// where a request goes: an explicitly stored endpoint wins; otherwise a key means Cloud, and no
// key means the local daemon. Before this, an empty `aiBaseUrl_ollama` always meant
// 127.0.0.1:11434 — so a user who pasted an Ollama Cloud key into the native provider got every
// call pointed at their own machine, and a server-side job that inherited only the key did too.

const trimUrl = (u: string): string => u.trim().replace(/\/+$/, "");

export function ollamaEndpoint(apiKey?: string, baseUrl?: string): string {
  const explicit = trimUrl(baseUrl || "");
  if (explicit) return explicit;
  return (apiKey || "").trim() ? OLLAMA_CLOUD_BASE_URL : OLLAMA_LOCAL_BASE_URL;
}

/** True when the host is ollama.com (Cloud) — not a remote self-hosted daemon on a private IP. */
export function isOllamaCloud(url: string): boolean {
  try {
    const host = new URL(trimUrl(url)).hostname.toLowerCase();
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    // A bare "ollama.com" or a trailing path still reads as cloud intent; the caller's error
    // will say what went wrong more usefully than a false "local" classification.
    return /(^|\/\/)([a-z0-9-]+\.)*ollama\.com([/:]|$)/i.test(url || "");
  }
}

/** Loopback/private host — the daemon on this box, or one the operator runs. Keyless is fine. */
export function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(trimUrl(url)).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "0.0.0.0"
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".internal") || host.endsWith(".local");
  } catch {
    return false;
  }
}

/**
 * The model to send for an Ollama call: the user's choice, else the cloud default when the
 * resolved endpoint IS Cloud, else "" (a local daemon's catalogue is whatever was pulled).
 */
export function ollamaChatModel(model: string | undefined, apiKey?: string, baseUrl?: string): string {
  const chosen = (model || "").trim();
  if (chosen) return chosen;
  return isOllamaCloud(ollamaEndpoint(apiKey, baseUrl)) ? defaultModelFor("ollama", "chat") : "";
}

/** Same split for vision: cloud has a known multimodal default, a daemon does not. */
export function ollamaVisionModel(model: string | undefined, apiKey?: string, baseUrl?: string): string {
  const chosen = (model || "").trim();
  if (chosen) return chosen;
  return isOllamaCloud(ollamaEndpoint(apiKey, baseUrl)) ? defaultModelFor("ollama", "vision") : "";
}

/**
 * Can this credential set attempt an AI call at all? The server-side mirror of the browser's
 * aiCredsReady (lib/seo/keys.ts), so the badge that says "ready" and the route that used to
 * reject can never disagree: a key makes any provider ready, and Ollama is additionally ready
 * without one whenever the resolved endpoint is NOT Cloud — the daemon is unauthenticated, but
 * ollama.com answers a keyless call with 401 on every request.
 *
 * Every generation route's "no_ai_key" gate asks this instead of testing the key alone; the
 * Ollama-native provider shipped with those gates untouched, so a keyless local daemon passed
 * the browser readiness and then bounced off "no_ai_key" on the server.
 */
export function aiConfigReady(provider: string, apiKey?: string, baseUrl?: string): boolean {
  if ((apiKey ?? "").trim()) return true;
  if (provider === "ollama") return !isOllamaCloud(ollamaEndpoint("", baseUrl));
  return false;
}
