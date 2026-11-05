// Last check before a generation job is marked "completed".
//
// A pipeline can return ok:true with nothing usable in it — post-processing
// (scrub, redaction, a repair pass) that ends with an empty string, or a parsed
// outline with zero sections. Filed as completed, such a job is invisible: the
// batch counts it done, History shows an empty record, nobody regenerates it.
// Turning it into an error hands it to the retry policy instead.
//
// The thresholds are deliberately low — they catch "nothing came out", not
// "shorter than I wanted". Length targets are the judge's business.

const MIN_TEXT_CHARS = 400;

function articleBody(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")           // the Title/Description/Slug block
    .replace(/^\s*(title|meta description|url slug)\s*:.*$/gim, " ")
    .replace(/[#>*_`|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** null when the result is usable, otherwise an error string for the job row. */
export function emptyResultReason(type: string, data: unknown): string | null {
  if (type === "text") {
    const raw = typeof data === "string" ? data : (data as { text?: unknown } | null)?.text;
    const body = articleBody(typeof raw === "string" ? raw : "");
    if (body.length < MIN_TEXT_CHARS) {
      return `empty_result: the pipeline finished but the article body is ${body.length} chars (min ${MIN_TEXT_CHARS}) — treated as a failure so it is retried, not filed as done`;
    }
    return null;
  }
  if (type === "outline" || type === "outline_auto") {
    const sections = (data as { sections?: unknown } | null)?.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      return "empty_result: the outline has no sections — treated as a failure so it is retried, not filed as done";
    }
  }
  return null;
}
