// Plagiarism check, step 3 — decide that a SERP result IS a copy (pure). Two signals, exactly
// as the brief defines them:
//
//   1. snippet coverage — ≥ 70 % of the fragment's words appear in the snippet as consecutive
//      runs (4-word shingles). Snippets are the only text the SERP gives us without fetching
//      pages, and Google builds them around the match, so a copied sentence shows up as a
//      nearly unbroken run of the fragment's words.
//   2. URL repetition — the same URL answers for ≥ 2 different fragments. Snippets truncate;
//      a page containing the whole stolen section still answers for each fragment, and two
//      hits from one domain are not coincidence.
//
// The output is an estimate, not a verdict: the page's own words, syndication, and quotes all
// light up here. The UI says so; this module only reports what was found.

import { tokenizeWords } from "./text";

/** Words per shingle. Four is the classic n-gram size for near-duplicate detection. */
export const SHINGLE_SIZE = 4;

/** Minimum share of the fragment's words covered by matched shingles. */
export const MATCH_THRESHOLD = 0.7;

/** One organic result of a quoted-fragment query, as `runSerp` shapes them. */
export interface SerpHit {
  url: string;
  title: string;
  snippet: string;
}

export interface FragmentMatch {
  url: string;
  title: string;
  /** Share of fragment words covered by shingles found in this hit's snippet (0..1). */
  coverage: number;
  /** True when the hit's host is the site the text belongs to — reported, never counted as plagiarism. */
  ownSite: boolean;
  /** How this match was established: "snippet" (coverage ≥ 70 %) or "repeat" (URL hit for ≥ 2 fragments). */
  reason: "snippet" | "repeat";
}

function shingleSet(text: string): Set<string> {
  const words = tokenizeWords(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    out.add(words.slice(i, i + SHINGLE_SIZE).join("\u0000"));
  }
  return out;
}

/**
 * Share of the fragment's words covered by 4-word runs present in the snippet. Word-level
 * union: overlapping shingles do not double-count, and a snippet that quotes the middle of the
 * fragment still earns credit for exactly those words.
 */
export function shingleCoverage(fragment: string, snippet: string): number {
  const words = tokenizeWords(fragment);
  if (words.length < SHINGLE_SIZE) return 0;
  const haystack = shingleSet(snippet);
  const covered = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    if (haystack.has(words.slice(i, i + SHINGLE_SIZE).join("\u0000"))) {
      for (let k = i; k < i + SHINGLE_SIZE; k++) covered[k] = true;
    }
  }
  let hit = 0;
  for (const c of covered) if (c) hit++;
  return hit / words.length;
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** host === ownHost or a subdomain of it — the same "site" rule rank.ts uses. */
export function isOwnHost(host: string, ownHost: string): boolean {
  if (!host || !ownHost) return false;
  return host === ownHost || host.endsWith("." + ownHost);
}

export interface FragmentCheck {
  /** Index of the fragment in the run's fragment list. */
  index: number;
  fragment: string;
  hits: SerpHit[];
}

export interface SourceRow {
  url: string;
  title: string;
  /** How many fragments this URL answered for. */
  fragments: number;
  ownSite: boolean;
}

export interface MatchReport {
  /** Per fragment: the matches found, best coverage first. */
  fragments: { index: number; fragment: string; matches: FragmentMatch[] }[];
  /** Fragments with at least one non-own-site match. */
  matchedFragments: number;
  sampledFragments: number;
  /** 0..100, share of sampled fragments found elsewhere. */
  matchedPct: number;
  /** External sources first (most fragments), the site's own pages last. */
  sources: SourceRow[];
}

/**
 * Fold per-fragment SERP hits into the report. `ownHost` empty = the text is not tied to a
 * site, and nothing can be "own" — every match is external.
 */
export function aggregateMatches(checks: FragmentCheck[], ownHost = ""): MatchReport {
  // Pass 1 — snippet matches, per fragment, coverage-ordered.
  const byFragment = new Map<number, { fragment: string; matches: Map<string, FragmentMatch> }>();
  for (const c of checks) {
    const matches = new Map<string, FragmentMatch>();
    for (const hit of c.hits) {
      const coverage = shingleCoverage(c.fragment, hit.snippet || hit.title);
      if (coverage < MATCH_THRESHOLD) continue;
      matches.set(hit.url, {
        url: hit.url, title: hit.title, coverage,
        ownSite: isOwnHost(hostOfUrl(hit.url), ownHost),
        reason: "snippet",
      });
    }
    byFragment.set(c.index, { fragment: c.fragment, matches });
  }

  // Pass 2 — URL repetition across fragments. Counted from every hit, not only snippet
  // matches, because the whole point is that snippets truncated below the threshold.
  const urlFragments = new Map<string, Set<number>>();
  const urlTitle = new Map<string, string>();
  for (const c of checks) {
    for (const hit of c.hits) {
      if (!urlFragments.has(hit.url)) urlFragments.set(hit.url, new Set());
      urlFragments.get(hit.url)!.add(c.index);
      if (!urlTitle.has(hit.url) && hit.title) urlTitle.set(hit.url, hit.title);
    }
  }
  for (const [url, frags] of urlFragments) {
    if (frags.size < 2) continue;
    const own = isOwnHost(hostOfUrl(url), ownHost);
    for (const idx of frags) {
      const entry = byFragment.get(idx);
      if (!entry) continue;
      const existing = entry.matches.get(url);
      if (existing) continue; // a snippet match already carries a stronger reason
      entry.matches.set(url, {
        url, title: urlTitle.get(url) ?? "", coverage: 0,
        ownSite: own, reason: "repeat",
      });
    }
  }

  const fragments = [...byFragment.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, { fragment, matches }]) => ({
      index,
      fragment,
      matches: [...matches.values()].sort((a, b) => Number(b.ownSite) - Number(a.ownSite) || b.coverage - a.coverage),
    }));

  const matchedFragments = fragments.filter((f) => f.matches.some((m) => !m.ownSite)).length;
  const sourceRows = new Map<string, SourceRow>();
  for (const f of fragments) {
    for (const m of f.matches) {
      const row = sourceRows.get(m.url) ?? { url: m.url, title: m.title, fragments: 0, ownSite: m.ownSite };
      row.fragments++;
      sourceRows.set(m.url, row);
    }
  }
  const sources = [...sourceRows.values()].sort(
    (a, b) => Number(a.ownSite) - Number(b.ownSite) || b.fragments - a.fragments,
  );

  const sampled = fragments.length;
  return {
    fragments,
    matchedFragments,
    sampledFragments: sampled,
    matchedPct: sampled ? Math.round((matchedFragments / sampled) * 100) : 0,
    sources,
  };
}
