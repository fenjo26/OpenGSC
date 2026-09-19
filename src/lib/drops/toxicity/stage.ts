import { safeFetch } from "@/lib/security/safeFetch";
import { cdxGate } from "@/lib/drops/wayback";
import { proxyConnector } from "@/lib/drops/proxyTransport";
import {
  countPendingTox, loadProxyPool, pendingToxCandidates, recordToxSnapshots,
  recordToxThrottled, setToxVerdict, type CandidateFilter,
} from "@/lib/drops/store";
import { collectEvidence, ToxThrottledError, type ToxFetch } from "@/lib/drops/toxicity/collect";
import { classifyDomain } from "@/lib/drops/toxicity/classify";
import type { Snapshot, SnapshotVerdict, ToxReport } from "@/lib/drops/toxicity/types";

/**
 * One bounded slice of the free toxicity stage — the single implementation the /drops route
 * and the drops_toxicity MCP tool both call, so the agent and the button can never drift
 * apart in what they check or write. Sources run in the spec's order: anchors and the name
 * scan are free (anchorsOnly classifies the whole catalogue with zero requests), the
 * Wayback walk is the only network, and every archive request may ride a proxy lease for
 * its own zone.
 *
 * Shadow mode is structural here: verdicts land in historyVerdict/Note/At and nothing else
 * moves. Score and veto only react through the arm flag (recomputeScore), which is off by
 * default — a false positive that silently drops a good domain from the buyable cut is the
 * one failure this stage must not be able to cause unnoticed.
 */
export const TOX_MAX_BATCH = 25;
export const TOX_ANCHORS_BATCH = 200;
const ARCHIVE_ZONE = "web.archive.org";
const ARCHIVE_MIN_INTERVAL_MS = 1500;
const DEADLINE_MS = 40_000;

export interface ToxSliceOpts {
  runId?: string;
  batch?: number;
  domains?: string[];
  filter?: CandidateFilter;
  anchorsOnly?: boolean;
  /** Snapshots per domain, 1..5 — only the Wayback walk reads it. */
  snapshots?: number;
  /** The route lives under a proxy deadline; the MCP tool reuses the same default. */
  deadlineMs?: number;
}

export interface ToxSliceResult {
  checked: number;
  toxic: number;
  suspicious: number;
  clean: number;
  empty: number;
  skipped: { domain: string; reason: string }[];
  remaining: number;
  done: boolean;
}

export async function runToxSlice(userId: string, opts: ToxSliceOpts = {}): Promise<ToxSliceResult> {
  const anchorsOnly = opts.anchorsOnly === true;
  const batch = Math.min(Math.max(opts.batch ?? (anchorsOnly ? TOX_ANCHORS_BATCH : 8), 1), anchorsOnly ? TOX_ANCHORS_BATCH : TOX_MAX_BATCH);
  const rows = await pendingToxCandidates(userId, {
    runId: opts.runId,
    limit: batch,
    domains: opts.domains,
    filter: opts.filter,
  });
  if (!rows.length) {
    return {
      checked: 0, toxic: 0, suspicious: 0, clean: 0, empty: 0, skipped: [],
      remaining: await countPendingTox(userId, opts.runId, opts.filter), done: true,
    };
  }

  const pool = anchorsOnly ? null : await loadProxyPool(userId);
  const deadline = Date.now() + (opts.deadlineMs ?? DEADLINE_MS);

  const makeFetch = (): ToxFetch => async (url, options) => {
    if (!pool) return safeFetch(url, options);
    const lease = await pool.lease(ARCHIVE_ZONE, ARCHIVE_MIN_INTERVAL_MS);
    const via = lease.endpoint;
    try {
      return await safeFetch(url, { ...options, ...(via ? { proxy: proxyConnector(via) } : {}) });
    } finally {
      lease.release(true);
    }
  };

  const counts = { toxic: 0, suspicious: 0, clean: 0, empty: 0 };
  const skipped: { domain: string; reason: string }[] = [];
  const written: { row: { id: string; domain: string }; report: ToxReport; snapshots: Snapshot[]; perSnapshot: SnapshotVerdict[] }[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < rows.length && Date.now() < deadline) {
      const row = rows[cursor++];
      try {
        const anchors = parseAnchors(row.topAnchors);
        const evidence = anchorsOnly
          ? { domain: row.domain, snapshots: [] as Snapshot[], anchors }
          : await cdxGate(() => collectEvidence(row.domain, {
              anchors,
              snapshots: opts.snapshots,
              fetch: makeFetch(),
            }));
        const report = classifyDomain(evidence, {});
        await setToxVerdict(userId, row.domain, report.verdict, toxNote(report));
        counts[report.verdict] += 1;
        written.push({ row: { id: row.id, domain: row.domain }, report, snapshots: evidence.snapshots, perSnapshot: report.perSnapshot });
      } catch (error) {
        // A refusal is never a verdict: the row keeps historyVerdict NULL, sits out the
        // next 6 hours (tox_throttled), and the answer says so by name.
        if (error instanceof ToxThrottledError) {
          await recordToxThrottled(row.id);
          skipped.push({ domain: row.domain, reason: "wayback_throttled" });
        } else {
          skipped.push({ domain: row.domain, reason: "collect_failed" });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(anchorsOnly ? 8 : 2, rows.length) }, worker));

  // The card's evidence — written after the verdicts, so a slice that died mid-way leaves
  // rows either fully classified or fully untouched, never a verdict with no reasons.
  for (const w of written) {
    await recordToxSnapshots(w.row.id, w.snapshots, w.perSnapshot);
  }

  const remaining = await countPendingTox(userId, opts.runId, opts.filter);
  return {
    checked: rows.length - skipped.length,
    ...counts,
    skipped,
    remaining,
    done: remaining === 0,
  };
}

/** topAnchors is stored as JSON `{anchor, count}[]` — the classifier wants plain strings. */
export function parseAnchors(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const out = (parsed as { anchor?: unknown }[])
      .map(a => (typeof a?.anchor === "string" ? a.anchor : null))
      .filter((a): a is string => Boolean(a));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The compact, human-readable note format: `score 95 · gambling_zh(利来,九游) · anchor_gambling_id(togel)`.
 *  The `score N` prefix is also the source marker — the AI pass writes prose. */
export function toxNote(report: ToxReport): string {
  const parts = [`score ${Math.round(report.score)}`];
  for (const s of report.signals) {
    parts.push(s.detail ? `${s.code}(${s.detail.slice(0, 60)})` : s.code);
  }
  return parts.join(" · ").slice(0, 1000);
}
