// Pulling usage out of whatever shape a provider chose to speak.
//
// Nine providers, five usage-block dialects, verified against the parsing `llm.ts` already does
// for each — not invented here, because a log field that disagrees with the value the app already
// trusted for billing is worse than no field at all. `zai` genuinely speaks either dialect: which
// one depends on a base-URL check made at call time (`zaiAnthropicShape`, `llm.ts`) that this
// function does not have access to, so it is read from the shape of `data` itself instead of
// trusted from the provider name.
//
// costUsd is the one field this module will not derive. OpenRouter is the only provider that
// states what a request cost; everyone else is left null rather than computed from tokens and a
// price table, because a stale table produces a wrong number that looks exactly like a right one.
// GoAnyAPI's `costCredits` (`src/lib/seo/goanyapi.ts`) is deliberately not read here either —
// credits are not dollars, and it is not one of the providers `llm.ts` calls through this path.

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
}

const NULL_USAGE: Usage = { promptTokens: null, completionTokens: null, costUsd: null };

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

// input_tokens / output_tokens — Anthropic's own wire format, and also what Kie's Responses API
// (llm.ts:580) happens to use for the same two fields under the same names.
function anthropicShape(data: any): Pick<Usage, "promptTokens" | "completionTokens"> {
  return { promptTokens: num(data?.usage?.input_tokens), completionTokens: num(data?.usage?.output_tokens) };
}

// prompt_tokens / completion_tokens — the OpenAI chat-completions dialect, shared verbatim by
// deepseek, qwen, cheaperinference, kimi and custom gateways (llm.ts:418, 528, 561, 610).
function openAiShape(data: any): Pick<Usage, "promptTokens" | "completionTokens"> {
  return { promptTokens: num(data?.usage?.prompt_tokens), completionTokens: num(data?.usage?.completion_tokens) };
}

export function usageFrom(provider: string, data: any): Usage {
  switch (provider) {
    case "anthropic":
    case "kie":
      return { ...anthropicShape(data), costUsd: null };

    case "gemini":
      return {
        promptTokens: num(data?.usageMetadata?.promptTokenCount),
        completionTokens: num(data?.usageMetadata?.candidatesTokenCount),
        costUsd: null,
      };

    case "openrouter":
      // The one provider that states what it charged. Nothing else in this switch ever sets
      // costUsd, and that asymmetry is deliberate — see the module comment.
      return { ...openAiShape(data), costUsd: num(data?.usage?.cost) };

    case "zai": {
      // Try the shape the anthropic branch would have produced first; only a response that
      // actually looks like that dialect has both fields non-null. Anything else falls through
      // to the openai dialect, which is what the other branch of llm.ts sends.
      const anthropic = anthropicShape(data);
      if (anthropic.promptTokens !== null || anthropic.completionTokens !== null) {
        return { ...anthropic, costUsd: null };
      }
      return { ...openAiShape(data), costUsd: null };
    }

    case "openai":
    case "deepseek":
    case "qwen":
    case "kimi":
    case "cheaperinference":
    case "custom":
      return { ...openAiShape(data), costUsd: null };

    default:
      // An unrecognised provider is a fact worth logging with everything else null, not a reason
      // to throw and lose the row.
      return NULL_USAGE;
  }
}
