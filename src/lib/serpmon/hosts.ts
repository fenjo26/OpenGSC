// SERP Monitor — host helpers: normalisation, dot-bounded matching, platform predicate, textarea parsing.
// Pure module: imported by both server and client code — no server-only imports here (see CONTRACT.md §3.1).
import { DEFAULT_PLATFORM_HOSTS } from "./types";

/** Max stored host length (MySQL VARCHAR(191) limit of the project, see CONTRACT.md §1). */
const MAX_HOST_LENGTH = 191;

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function stripOneLeadingWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Lower-case host without "www." and trailing dot; null for non-http(s) or unparsable. ≤ 191 chars else null. */
export function hostOfUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only web URLs carry a SERP host; everything else (ftp:, javascript:, mailto:, …) is not one.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // hostname is lower-case already; IDN comes out as punycode, IPv6 keeps its brackets — keep as URL gives it.
  const host = stripOneLeadingWww(stripTrailingDot(parsed.hostname.toLowerCase()));
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  return host;
}

/** true when host equals an entry or ends with "." + entry. */
export function hostMatches(host: string, entries: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of entries) {
    const e = entry.toLowerCase();
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** DEFAULT_PLATFORM_HOSTS ∪ project list, as one predicate. */
export function ignorePredicate(projectIgnore: readonly string[]): (host: string) => boolean {
  const all = [...DEFAULT_PLATFORM_HOSTS, ...projectIgnore];
  return (host: string) => hostMatches(host, all);
}

function bareHost(piece: string): string | null {
  const host = piece.trim().toLowerCase();
  // A bare host never carries a path/query/inner whitespace; that is paste garbage, drop it.
  if (!host || /[\s/?#]/.test(host)) return null;
  const clean = stripOneLeadingWww(stripTrailingDot(host));
  if (!clean || clean.length > MAX_HOST_LENGTH) return null;
  return clean;
}

/** Split the textarea value: newline/comma separated, trimmed, lower-cased, www. stripped, deduped. */
export function parseHostList(raw: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\n,]/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const host = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? hostOfUrl(trimmed) : bareHost(trimmed);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result;
}
