// Publication gate — the check that runs BEFORE anything else judges the text.
//
// The value audit (fact drift, heading counts) verifies a rewrite OF the source; it says
// nothing about whether the model returned an article at all. Two failures shipped as
// "completed" pages on this instance before this gate existed:
//   • an 85-word response that was the model's number-planning notes
//     ("- `45€`: \"Διαμέρισμα 2 υπνοδωματίων: 45€\"" ... "-> let's have `55`"),
//   • a 94-word page that copied the site's booking-form confirmation text and stopped
//     mid-sentence.
// Both scored uniqueness 100% and passed the audit, because a non-article trivially
// satisfies every check that assumes it is looking at an article. This gate is
// deterministic, free, and runs first so garbage never reaches the paid judge call.

import { wordCount } from "@/lib/seo/textMetrics";

export interface GateResult {
  ok: boolean;
  /** Machine-readable code (`gate_too_short`, …) — rewriteBatch prefix-matches it to retry. */
  reason?: string;
  /** Human-readable sentence for job error fields and logs. */
  detail?: string;
}

export function contentGate(source: string, out: string): GateResult {
  // Scratch first, not length: a planning-notes response is ALSO short, and "the model
  // returned its notes" tells the operator something "too short" does not.
  if (
    /->\s*let'?s\b/i.test(out) ||
    /double[- ]check(ing)?\s+word\s+count/i.test(out) ||
    /^[-*]\s+`[^`\n]+`\s*:\s*["“]/m.test(out)
  ) {
    return {
      ok: false,
      reason: "gate_scratch_leaked",
      detail: "the response contains the model's planning notes, not an article",
    };
  }
  const srcWords = wordCount(source);
  const outWords = wordCount(out);
  if (outWords < 150 || outWords < srcWords * 0.35) {
    return {
      ok: false,
      reason: "gate_too_short",
      detail: `the draft is ${outWords} words against a ${srcWords}-word source — not a rewrite`,
    };
  }
  // An odd number of ``` fences means a block was opened and never closed — assembly
  // damage (a stripped wrapper on one side, a truncated chunk on the other).
  if (((out.match(/```/g) || []).length) % 2 === 1) {
    return {
      ok: false,
      reason: "gate_broken_fence",
      detail: "an unterminated code fence — the draft is damaged or truncated",
    };
  }
  return { ok: true };
}
