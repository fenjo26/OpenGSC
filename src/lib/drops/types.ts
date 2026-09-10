// Shared shapes for the drop catalogue. Deliberately free of Prisma and of `node:` imports so
// every consumer — the A-Parser track, the built-in RDAP/WHOIS track, the scorer and their
// tests — can import from one place and still run under `tsx --test` with no database.

/** Where a candidate came from. Mirrors `DropRun.source`. */
export type DropSource =
  | "csv"
  | "ahrefs_refdomains"
  | "ahrefs_broken"
  | "crawler"
  | "zone_diff";

/**
 * The funnel, in order. A candidate only ever moves forward; `rejected` is terminal for this
 * run but not for the domain (a later run may re-ingest it).
 *
 * The order is the whole point of the module: every stage exists to make the next one cheaper.
 * `dns_checked` before `available` is what keeps a 50 000-row list from becoming 50 000 hits
 * on public RDAP nodes.
 */
export type DropStage =
  | "ingested"
  | "dns_checked"
  /**
   * The zone has no registry this app can ask (`.gr`: no RDAP, no working public WHOIS). A
   * terminal stage for the built-in checker, not a verdict about the domain — the row is
   * waiting for a registrar API, and it sits here rather than in `dns_checked` so it stops
   * counting as "ждут реестра" and stops being re-marked every week forever.
   */
  | "no_registry"
  | "resolved_taken"
  | "checking"
  | "available"
  | "taken"
  | "confirmed"
  | "rejected"
  | "acquired";

/** How the answer was obtained. Kept on the result because it changes how much we trust it. */
export type AvailabilitySource = "rdap" | "whois" | "dns" | "aparser";

export type AvailabilityResult =
  | {
      ok: true;
      status: "registered";
      http: number;
      via: AvailabilitySource;
      expiresAt?: Date;
      createdAt?: Date;
      /** Raw registry statuses, e.g. ["clientTransferProhibited", "pendingDelete"]. */
      registryStatus?: string[];
      nameServers?: string[];
      registrar?: string;
    }
  | {
      ok: true;
      status: "available";
      http: number;
      via: AvailabilitySource;
      /**
       * True only when two independent signals agree the name is free — typically an RDAP 404
       * plus a WHOIS "no match", or A-Parser's `$registered === false` plus an empty `$ns`.
       *
       * An RDAP 404 on its own means nothing: `rdap.org` answers 404 both for a genuinely
       * unregistered name and for a TLD it cannot route, and some registry endpoints answer 404
       * on their own internal errors. An uncorroborated `available` must never raise an alert
       * and must never be shown as free — it is a reason to ask again, not an answer.
       */
      corroborated: boolean;
    }
  | { ok: false; status: "rate_limited"; http: number; retryAfterSec?: number }
  | { ok: false; status: "error"; http: number; error: string };

/** Input to the scorer. Every field optional: a candidate can be scored before enrichment. */
export interface ScoreInput {
  dr?: number | null;
  refdomains?: number | null;
  refdomainsDofollow?: number | null;
  waybackSnapshots?: number | null;
  /** Days between the last Wayback capture and now — how long the site has been dead. */
  waybackGapDays?: number | null;
  historyVerdict?: HistoryVerdict | null;
}

export type HistoryVerdict = "clean" | "topic_shift" | "spam_period" | "unknown";
