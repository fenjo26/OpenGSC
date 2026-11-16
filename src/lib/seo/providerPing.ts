import { pingProvider } from "@/lib/llm";

// Fail-fast provider selection for generation jobs.
//
// The scenario: a job's provider pool goes half-dead (connections accepted, answers never
// arrive — the gray-market norm). Every LLM step then burns its own 280s timeout × retries,
// the wall-clock cap kills the job ~25 minutes later, and the user paid for SERP+scrape before
// finding out. A one-second ping before the chain starts either clears the provider, promotes
// a configured fallback into its place, or fails the job with the provider's own error —
// before anything expensive has run.
//
// A successful ping proves little about a long call that follows it; a FAILED one is
// definitive — nothing that can't answer "ok" will write an outline.

type Candidate = { aiProvider?: string; aiApiKey?: string; model?: string; aiBaseUrl?: string };

// The job payload pickLiveProvider reads from (and promotes a fallback INTO — mutation is the
// point): the provider-selection fields it touches, plus everything else a generation job
// carries (keyword, outline, creds…) which it leaves alone.
type ProviderPickPayload = {
  aiProvider?: unknown;
  aiApiKey?: unknown;
  model?: unknown;
  aiBaseUrl?: unknown;
  aiFallbacks?: unknown;
  [key: string]: unknown;
};

export async function pickLiveProvider(payload: ProviderPickPayload): Promise<{ ok: true; switchedTo?: string } | { ok: false; error: string }> {
  const primary = payload ?? {};
  const fallbacks: Candidate[] = Array.isArray(payload?.aiFallbacks) ? payload.aiFallbacks : [];
  // Priority order is the whole point: primary first, then the user's fallback chain. First
  // candidate that answers wins; the dead ones ahead of it cost 25s each, not 25 minutes.
  const candidates = [primary, ...fallbacks].slice(0, 4);
  let firstError = "";
  for (const c of candidates) {
    const p = String(c?.aiProvider ?? "").trim();
    const k = String(c?.aiApiKey ?? "").trim();
    // Ping needs a provider and credentials — except for a local Ollama daemon, which has no key
    // by design. Its chosen model is the credential: without one the call would 404 anyway, so a
    // keyless candidate with no model is still skipped.
    if (!p) continue;
    if (!k && !(p === "ollama" && String(c?.model ?? "").trim())) continue;
    const r = await pingProvider(p, k, c.model ? String(c.model) : undefined, c.aiBaseUrl ? String(c.aiBaseUrl) : undefined);
    if (r.ok) {
      if (c !== primary) {
        // Promote the fallback: the whole pipeline reads provider/key/model/baseUrl from these
        // payload fields, and the in-pipeline fallback loop stays as mid-run insurance.
        payload.aiProvider = c.aiProvider;
        payload.aiApiKey = c.aiApiKey;
        if (c.model) payload.model = c.model;
        payload.aiBaseUrl = c.aiBaseUrl;
        return { ok: true, switchedTo: p };
      }
      return { ok: true };
    }
    if (!firstError) firstError = `${p}: ${r.error}`;
  }
  return { ok: false, error: firstError || "no configured provider to check" };
}
