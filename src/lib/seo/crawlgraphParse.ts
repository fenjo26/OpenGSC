// Crawlgraph Backlinks API — the pure half: the error envelope, status mapping and every field
// mapping. No network, no Prisma, so `npx tsx --test` covers it without a database. The
// transport lives in `metrics.ts` next to the other providers (issue #40).
//
// Four things here are load-bearing:
//
// 1. **The quota is calls, and it is charged before the work.** One POST /backlinks, one
//    GET /changes or one gap job = 1 call against a per-user monthly bucket (15 free /
//    1 000 paid). A `comparison_available: false` answer is a successful 200 that still consumed
//    a call; validation/auth failures and 409 release_unavailable do not. Failed gap jobs are
//    not refunded in v1 — so the transport never auto-resubmits one.
//
// 2. **`cg_authority` is not Domain Rating.** It is a 0–100 log-rank percentile derived from
//    Common Crawl harmonic centrality, and it is null for domains absent from the ranks file.
//    It is stored under provider `crawlgraph` in RefDomainRow.dr and shown in its own column —
//    never in an Ahrefs DR slot, and never merged with another provider's scale.
//
// 3. **Truncation is `returned < total_linking_domains`.** The API has no paging; `limit` caps
//    a single call (10 000 max). A truncated pull must arrive with `complete: false` so the
//    store never marks absent referring domains lost off the back of it.
//
// 4. **Absence from a newer snapshot is not a lost link.** The changes endpoint compares two
//    quarterly Common Crawl observations; the API itself carries a `snapshot_caveat` saying so.
//    The UI shows that caveat verbatim — the "removed" list is "not observed in the newer
//    snapshot", nothing more.

/** One parsed Crawlgraph JSON object: the OpenAPI spec is the only schema, so every field is
 *  read through num()/str(), never directly. */
type CgJson = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (v == null ? "" : String(v));

/** A target as the API wants it: bare host, no scheme, no www, no path. */
export function cgTarget(domain: string): string {
  return String(domain ?? "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

/** Crawlgraph error code (the `error` field of the envelope) → the three-digit status the
 *  metrics layer branches on. Unknown codes fall back to the HTTP status that carried them.
 *  `upgrade_required` is what a free key actually gets on a gap submit (verified live,
 *  2026-11-09) — the docs' `quota_exceeded` is the monthly-cap variant. */
export function cgCodeToStatus(code: string, httpStatus: number): number {
  switch (code) {
    case "auth_missing":
    case "auth_invalid": return 401;
    case "quota_exceeded": return 429;
    case "upgrade_required": return 402; // the endpoint is behind the paid tier, not out of quota
    case "validation_error": return 400;
    case "release_unavailable": return 409;
    case "not_found": return 404;
    case "internal_error": return 500;
    default: return httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502;
  }
}

export type CgEnvelope =
  | { ok: true; result: CgJson }
  | { ok: false; status: number; error: string };

/**
 * The single-level check: Crawlgraph answers every non-2xx with the same envelope
 * `{error, message, request_id}`; 2xx bodies are the endpoint's own schema. Errors are phrased
 * `crawlgraph <3-digit>: <message>` so `gatewayStatusFromError` can read them, and the
 * request_id rides along in the text — it is what support asks for.
 */
export function parseCgEnvelope(httpStatus: number, data: CgJson | null | undefined): CgEnvelope {
  if (httpStatus < 200 || httpStatus >= 300) {
    const code = str(data?.error).trim();
    const message = str(data?.message).trim().slice(0, 200) || `HTTP ${httpStatus}`;
    const status = code ? cgCodeToStatus(code, httpStatus) : httpStatus;
    const req = str(data?.request_id).trim();
    return { ok: false, status, error: `crawlgraph ${status}: ${message}${req ? ` (req ${req})` : ""}` };
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, status: 502, error: "crawlgraph 502: response is not a JSON object" };
  }
  return { ok: true, result: data };
}

// ─── POST /api/v1/backlinks ────────────────────────────────────────────────────

export interface CgRefDomain {
  refDomain: string;
  /** cg_authority 0–100 percentile — stored in RefDomainRow.dr under provider `crawlgraph`.
   *  Null when the donor is absent from the ranks file; that is an answer, not an error. */
  authority: number | null;
  linksToTarget: number | null;
  /** The API has no dofollow signal at all; the column keeps its default rather than a guess. */
  dofollow: boolean;
  firstSeen: string;
}

export function mapCgRefDomain(item: CgJson | null | undefined): CgRefDomain | null {
  const refDomain = str(item?.linking_domain).trim().toLowerCase().replace(/^www\./, "");
  if (!refDomain.includes(".")) return null;
  return {
    refDomain,
    authority: num(item?.cg_authority),
    linksToTarget: num(item?.num_hosts),
    dofollow: true,
    firstSeen: "",
  };
}

export interface CgSummary {
  domain: string;
  releaseId: string;
  releaseLabel: string;
  /** Distinct linking domains before the `limit` slice — the figure the snapshot stores. */
  totalLinkingDomains: number | null;
  returned: number | null;
  /** `returned < total_linking_domains`: the pull is a prefix, not the whole profile. */
  truncated: boolean;
  /** The target domain's own authority/rank, when it appears in the ranks file. */
  authority: number | null;
  rank: number | null;
}

export interface CgBacklinks {
  summary: CgSummary;
  refDomains: CgRefDomain[];
}

export function mapCgBacklinks(data: CgJson | null | undefined): CgBacklinks {
  const total = num(data?.total_linking_domains);
  const returned = num(data?.returned);
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    summary: {
      domain: str(data?.domain),
      releaseId: str(data?.release_id),
      releaseLabel: str(data?.release_label),
      totalLinkingDomains: total,
      returned,
      truncated: total != null && returned != null && returned < total,
      authority: num(data?.cg_authority),
      rank: num(data?.cg_rank),
    },
    refDomains: results.map((i: CgJson) => mapCgRefDomain(i)).filter(Boolean) as CgRefDomain[],
  };
}

// ─── GET /api/v1/releases (free, not counted) ──────────────────────────────────

export interface CgRelease {
  id: string;
  label: string;
  available: boolean;
}

export function mapCgReleases(data: CgJson | null | undefined): CgRelease[] {
  const rows = Array.isArray(data?.releases) ? data.releases : [];
  return rows.map((r: CgJson) => ({
    id: str(r?.id),
    label: str(r?.label),
    available: r?.available === true,
  })).filter((r: CgRelease) => !!r.id);
}

// ─── GET /api/v1/changes (1 call) ──────────────────────────────────────────────

export interface CgChangeRow {
  refDomain: string;
  linksToTarget: number | null;
  authority: number | null;
}

export interface CgAuthorityMove {
  refDomain: string;
  fromAuthority: number | null;
  toAuthority: number | null;
  delta: number | null;
}

export interface CgChanges {
  domain: string;
  comparisonAvailable: boolean;
  fromRelease: { id: string; label: string } | null;
  toRelease: { id: string; label: string } | null;
  counts: {
    fromSnapshot: number | null;
    toSnapshot: number | null;
    added: number | null;
    removed: number | null;
    authorityMoved: number | null;
  };
  added: CgChangeRow[];
  removed: CgChangeRow[];
  authorityMoved: CgAuthorityMove[];
  truncated: boolean;
  message: string;
  /** The API's own caveat — shown verbatim; absence ≠ a removed live link. */
  snapshotCaveat: string;
}

const release = (v: unknown): { id: string; label: string } | null => {
  if (v == null || typeof v !== "object") return null;
  const id = str((v as CgJson).id);
  return id ? { id, label: str((v as CgJson).label) } : null;
};

const changeRow = (v: unknown): CgChangeRow | null => {
  const refDomain = str((v as CgJson)?.linking_domain).trim().toLowerCase().replace(/^www\./, "");
  if (!refDomain.includes(".")) return null;
  return { refDomain, linksToTarget: num((v as CgJson)?.num_hosts), authority: num((v as CgJson)?.cg_authority) };
};

export function mapCgChanges(data: CgJson | null | undefined): CgChanges {
  const c = (data?.counts ?? {}) as CgJson;
  const rows = (v: unknown) => (Array.isArray(v) ? v : []).map(changeRow).filter(Boolean) as CgChangeRow[];
  const moves = (Array.isArray(data?.authority_moved) ? data.authority_moved : [])
    .map((m: CgJson) => {
      const refDomain = str(m?.linking_domain).trim().toLowerCase().replace(/^www\./, "");
      if (!refDomain.includes(".")) return null;
      return { refDomain, fromAuthority: num(m?.from_authority), toAuthority: num(m?.to_authority), delta: num(m?.delta) };
    })
    .filter(Boolean) as CgAuthorityMove[];
  return {
    domain: str(data?.domain),
    comparisonAvailable: data?.comparison_available !== false,
    fromRelease: release(data?.from_release),
    toRelease: release(data?.to_release),
    counts: {
      fromSnapshot: num(c.from_snapshot),
      toSnapshot: num(c.to_snapshot),
      added: num(c.added),
      removed: num(c.removed),
      authorityMoved: num(c.authority_moved),
    },
    added: rows(data?.added),
    removed: rows(data?.removed),
    authorityMoved: moves,
    truncated: data?.truncated === true,
    message: str(data?.message),
    snapshotCaveat: str(data?.snapshot_caveat),
  };
}

// ─── POST/GET /api/v1/gap-analysis (1 job per submit; polling is free) ─────────

export interface CgGapSubmit {
  jobId: string;
  status: string;
  pollUrl: string;
}

export function mapCgGapSubmit(data: CgJson | null | undefined): CgGapSubmit | null {
  const jobId = str(data?.job_id).trim();
  if (!jobId) return null;
  return { jobId, status: str(data?.status) || "queued", pollUrl: str(data?.poll_url) };
}

export interface CgGapRow {
  refDomain: string;
  /** Which of the submitted competitors this domain links to (never the target). */
  foundOn: string[];
}

export interface CgGapResult {
  myDomain: string;
  competitors: string[];
  gaps: CgGapRow[];
  totalGaps: number | null;
  truncated: boolean;
  releaseId: string;
  provenanceStatus: string;
  builtAt: string;
}

export type CgGapStatus = "queued" | "running" | "completed" | "failed";

export interface CgGapJob {
  jobId: string;
  status: CgGapStatus;
  progressPct: number | null;
  startedAt: string;
  completedAt: string;
  error: { code: string; message: string } | null;
  result: CgGapResult | null;
}

export function mapCgGapJob(data: CgJson | null | undefined): CgGapJob | null {
  const jobId = str(data?.job_id).trim();
  if (!jobId) return null;
  const status = str(data?.status) as CgGapStatus;
  const err = data?.error != null && typeof data.error === "object"
    ? { code: str((data.error as CgJson).code), message: str((data.error as CgJson).message) }
    : null;
  const r = data?.result != null && typeof data.result === "object" ? (data.result as CgJson) : null;
  const result: CgGapResult | null = r
    ? {
        myDomain: str(r.my_domain),
        competitors: (Array.isArray(r.competitor_domains) ? r.competitor_domains : []).map((c: unknown) => str(c)),
        gaps: (Array.isArray(r.gaps) ? r.gaps : [])
          .map((g: CgJson) => {
            const refDomain = str(g?.linking_domain).trim().toLowerCase().replace(/^www\./, "");
            if (!refDomain.includes(".")) return null;
            return { refDomain, foundOn: (Array.isArray(g?.found_on) ? g.found_on : []).map((f: unknown) => str(f)) };
          })
          .filter(Boolean) as CgGapRow[],
        totalGaps: num(r.total_gaps),
        truncated: r?.truncated === true,
        releaseId: str(r.release_id),
        provenanceStatus: str(r.provenance_status),
        builtAt: str(r.built_at),
      }
    : null;
  return {
    jobId,
    status: status === "completed" || status === "failed" || status === "running" ? status : "queued",
    progressPct: num(data?.progress_pct),
    startedAt: str(data?.started_at),
    completedAt: str(data?.completed_at),
    error: err,
    result,
  };
}
