// Networked runners for N4: the NAP check over the site's own pages and the citation listing
// check. The pure extraction/comparison lives in nap.ts; this module owns the safeFetch calls,
// which is the only thing it adds. SSRF guard: every URL here comes from the user (a site of the
// workspace, or a listing URL they typed), so it all goes through safeFetch — no raw fetch.

import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import { compareNapPage, contactPageLinks, extractNap, homepageUrl } from "./nap";
import { saveCitationCheck, type CitationRow } from "./store";
import type { CitationStatus, LocalProfileData, NapCheckReport, NapPageReport } from "./types";

const FETCH_OPTS = { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 } as const;

interface FetchedPage {
  html: string | null;
  error?: string;
}

async function fetchPage(url: string): Promise<FetchedPage> {
  if (!url) return { html: null, error: "no_url" };
  try {
    const res = await safeFetch(url, FETCH_OPTS);
    if (res.status === 403 || res.status === 429) return { html: null, error: `http_${res.status}` };
    if (!res.ok) return { html: null, error: `http_${res.status}` };
    return { html: await res.text() };
  } catch (e) {
    if (e instanceof SafeFetchError) return { html: null, error: e.code };
    return { html: null, error: "network_error" };
  }
}

/**
 * The NAP check (brief §2): homepage (+ its footer, which is part of the page) and up to 10
 * contact-ish pages discovered from the homepage's links. The report is returned, not stored —
 * it is a live view of the site, per the brief.
 */
export async function runNapCheck(
  profile: LocalProfileData,
  siteUrl: string,
): Promise<NapCheckReport> {
  const base = homepageUrl(siteUrl);
  const pages: NapPageReport[] = [];

  const home = await fetchPage(base);
  if (home.html == null) {
    pages.push({ url: base, error: home.error ?? "unreachable", diffs: [] });
  } else {
    const found = extractNap(home.html, profile.country, profile);
    pages.push({ url: base, found, diffs: compareNapPage(profile, base, found) });

    // Contact pages, up to 10 — fetched in small parallel batches to stay polite.
    const targets = contactPageLinks(home.html, base);
    for (let i = 0; i < targets.length; i += 3) {
      const batch = targets.slice(i, i + 3);
      const results = await Promise.all(batch.map(async url => ({ url, page: await fetchPage(url) })));
      for (const { url, page } of results) {
        if (page.html == null) {
          pages.push({ url, error: page.error ?? "unreachable", diffs: [] });
          continue;
        }
        const f = extractNap(page.html, profile.country, profile);
        pages.push({ url, found: f, diffs: compareNapPage(profile, url, f) });
      }
    }
  }

  const counts = { match: 0, differs: 0, missing: 0, unreachable: 0 };
  for (const page of pages) {
    if (page.error) { counts.unreachable++; continue; }
    for (const d of page.diffs) counts[d.status]++;
  }
  return { siteId: profile.siteId, checkedAt: new Date().toISOString(), pages, counts };
}

/** Map a fetch outcome to the citation status the DB stores (brief §3). */
export function citationStatusFor(error: string | undefined, napStatuses: { match: number; differs: number; missing: number }): CitationStatus {
  if (error) return "unreachable"; // 403/captcha/network — "the directory blocks bots", not an NAP problem
  if (napStatuses.match === 0 && napStatuses.missing > 0 && napStatuses.differs === 0) return "missing";
  if (napStatuses.differs > 0) return "mismatch";
  return "consistent";
}

/**
 * Check one citation listing: fetch, extract NAP, compare with the profile, persist status.
 * Directories that answer 403/429 (bot walls — Yelp and friends do) land on `unreachable` with
 * an explanatory note, NOT as an NAP error.
 */
export async function checkCitation(citation: Pick<CitationRow, "id" | "url">, profile: LocalProfileData): Promise<{ status: CitationStatus }> {
  const page = await fetchPage(citation.url);
  if (page.html == null) {
    const status = "unreachable" as CitationStatus;
    await saveCitationCheck(citation.id, {
      status,
      found: null,
      diffs: [],
      note: page.error,
    });
    return { status };
  }

  const found = extractNap(page.html, profile.country, profile);
  const diffs = compareNapPage(profile, citation.url, found);
  const statuses = { match: 0, differs: 0, missing: 0 };
  for (const d of diffs) statuses[d.status]++;
  const status = citationStatusFor(undefined, statuses);
  await saveCitationCheck(citation.id, {
    status,
    found: { name: found.name || undefined, phone: found.phones[0], address: found.address || undefined },
    diffs,
  });
  return { status };
}

/** Re-check every unchecked/stale citation of a site (the "check now" button + weekly scheduler). */
export async function recheckCitations(
  citations: { id: string; url: string }[],
  profile: LocalProfileData,
): Promise<{ checked: number; consistent: number; mismatch: number; missing: number; unreachable: number }> {
  const out = { checked: 0, consistent: 0, mismatch: 0, missing: 0, unreachable: 0 };
  for (const c of citations) {
    const { status } = await checkCitation(c, profile);
    out.checked++;
    if (status === "consistent") out.consistent++;
    else if (status === "mismatch") out.mismatch++;
    else if (status === "missing") out.missing++;
    else out.unreachable++;
  }
  return out;
}
