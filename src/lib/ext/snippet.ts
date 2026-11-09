// wave-ext E5 — does a Google snippet's text appear on the page it describes? Pure string work,
// tested in snippet.test.ts. E0 lays the signatures (CONTRACT/E5 §1); bodies land with E5.

/** Split a snippet into comparable fragments: leading date stripped, cut on ellipses, normalised
 *  (lower case, NFKC, punctuation → space), fragments under 4 words dropped. */
export function snippetFragments(snippet: string): string[] {
  void snippet;
  throw new Error("not_implemented");
}

/** null when either side is empty; true when at least half of the fragments (rounded up) are
 *  substrings of the normalised page text. */
export function snippetFound(snippet: string, pageText: string): boolean | null {
  void snippet; void pageText;
  throw new Error("not_implemented");
}
