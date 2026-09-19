import type { SafeFetchOptions, SafeFetchResponse } from "@/lib/security/safeFetch";
import type { DomainEvidence, Snapshot } from "./types";
import { buildCdxUrl, extractHtmlLang, extractMetaRefresh, extractTextSample, extractTitle, parseCdxJson, rawSnapshotUrl, usableRows } from "./cdx";

/**
 * The stage's fetcher: one polite client for CDX and snapshot bodies. The archive
 * rate-limits per IP, so CDX goes through the process-wide cdxGate (wayback.ts) at the
 * call site, and every request may ride a DropProxy lease for the "web.archive.org" zone.
 */
export type ToxFetch = (url: string, options: SafeFetchOptions) => Promise<SafeFetchResponse>;

/** The archive refused us (429/403/503) — not a verdict, the row must come back later. */
export class ToxThrottledError extends Error {
  constructor(public readonly where: "cdx" | "snapshot", public readonly status: number) {
    super(`wayback_throttled_${where}_${status}`);
    this.name = "ToxThrottledError";
  }
}

const SNAPSHOT_RANGE = "bytes=0-16383"; // the title sits in the first kilobytes; doorways run to tens of MB

/**
 * One domain's evidence from the Wayback machine plus the anchors already stored on the row.
 *
 * CDX throttling aborts the whole domain (a verdict built on half the evidence is worse than
 * none); a single dead snapshot only drops that snapshot — the rest still classify.
 */
export async function collectEvidence(
  domain: string,
  opts: { snapshots?: number; anchors?: string[]; fetch: ToxFetch },
): Promise<DomainEvidence> {
  const want = Math.min(Math.max(opts.snapshots ?? 3, 1), 5);

  const cdxRes = await opts.fetch(buildCdxUrl(domain, { last: want }), {
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  });
  if (cdxRes.status === 429 || cdxRes.status === 403 || cdxRes.status === 503) {
    throw new ToxThrottledError("cdx", cdxRes.status);
  }
  const rows = cdxRes.status === 200 ? usableRows(parseCdxJson(await cdxRes.json())) : [];

  const snapshots: Snapshot[] = [];
  for (const row of rows.slice(0, want)) {
    const url = rawSnapshotUrl(row.timestamp, row.original);
    let html = "";
    try {
      // `id_` is what makes this the site's own bytes rather than the archive's chrome;
      // Range keeps the fetch to the head of the document (206 — or 200, then sliced).
      const res = await opts.fetch(url, {
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
        headers: { range: SNAPSHOT_RANGE },
      });
      if (res.status === 429 || res.status === 403 || res.status === 503) {
        throw new ToxThrottledError("snapshot", res.status);
      }
      if (res.status < 400) html = (await res.text()).slice(0, 20_000);
    } catch (error) {
      if (error instanceof ToxThrottledError) throw error;
      // A snapshot that failed to load is recorded without content — an honest gap, not a
      // fabricated "the page was empty".
      snapshots.push({ timestamp: row.timestamp, status: Number(row.statuscode) || undefined });
      continue;
    }
    snapshots.push({
      timestamp: row.timestamp,
      status: Number(row.statuscode) || undefined,
      title: extractTitle(html) || undefined,
      text: extractTextSample(html, 600) || undefined,
      htmlLang: extractHtmlLang(html),
      redirectTo: extractMetaRefresh(html, url),
    });
  }
  // Oldest → newest: the language-flip detector reads the order.
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { domain, snapshots, anchors: opts.anchors };
}
