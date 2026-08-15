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
};

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
