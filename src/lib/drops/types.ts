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

/**
 * How the answer was obtained. Kept on the result because it changes how much we trust it.
 *
 * `manual` is a verdict brought back from outside — a registrar panel, or the registry's own web
 * form driven by the user's own tool. It exists for zones the built-in checker cannot ask at all
 * (`.gr`), and it is never corroborated: one source is one source, whoever typed it.
 */
export type AvailabilitySource = "rdap" | "whois" | "dns" | "aparser" | "manual" | "registrar";

/**
 * A registrar's answer, kept wider than a boolean.
 *
 * "Not for sale" and "already registered" are different facts and must stay different: a
 * registrar refusing to sell a name is not evidence that anybody owns it.
 */
export type RegistrarVerdict = "available" | "premium" | "unavailable" | "refused" | "unknown";

/**
 * Something that can be asked to confirm a free name, without this module knowing which
 * registrar it is. Implemented by `dynadot.ts`; wired in by the route that has the credentials.
 */
export interface RegistrarConfirmer {
  /** For the event log, e.g. "Dynadot". */
  name: string;
  confirm(domain: string): Promise<{ verdict: RegistrarVerdict; reason?: string; price?: string }>;
}

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
      /**
       * What a registrar said when asked to confirm — a different question from the registry's.
       *
       * The registry answers "is there a record"; the registrar answers "can I sell you this".
       * `premium` and `unavailable` both mean the name is free in the registry and still not
       * obtainable on the terms the funnel assumes, which is worth knowing BEFORE the buying
       * decision rather than at checkout. Absent means nobody asked.
       */
      registrarVerdict?: RegistrarVerdict;
      /** The registrar's own words, for the event log. Never carries a credential. */
      registrarNote?: string;
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
