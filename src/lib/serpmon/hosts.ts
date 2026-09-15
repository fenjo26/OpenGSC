// SERP Monitor — host helpers. Stub: T2 owns the implementation (see docs/tasks/serp-monitor/).

/** Lower-case host without "www." and trailing dot; null for non-http(s) or unparsable. ≤ 191 chars else null. */
export function hostOfUrl(url: string): string | null {
  throw new Error("serpmon: hostOfUrl not implemented (T2)");
}

/** true when host equals an entry or ends with "." + entry. */
export function hostMatches(host: string, entries: readonly string[]): boolean {
  throw new Error("serpmon: hostMatches not implemented (T2)");
}

/** DEFAULT_PLATFORM_HOSTS ∪ project list, as one predicate. */
export function ignorePredicate(projectIgnore: readonly string[]): (host: string) => boolean {
  throw new Error("serpmon: ignorePredicate not implemented (T2)");
}

/** Split the textarea value: newline/comma separated, trimmed, lower-cased, www. stripped, deduped. */
export function parseHostList(raw: string): string[] {
  throw new Error("serpmon: parseHostList not implemented (T2)");
}
