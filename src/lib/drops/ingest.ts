// Turning whatever the user pasted into a clean, deduplicated domain list.
//
// This is the first stage of the funnel and the only one that can quietly poison every stage
// after it. The source post's author found 11 rows in his CSV that were IP addresses, not
// domains — they went through his whole pipeline and came out as "free", because no registry
// has a record for 192.0.2.1. Every rejection below is a row that would otherwise have become a
// confident wrong answer downstream.

import { apexOf } from "./registries";

export type SkipReason =
  | "empty"
  | "ip_address"
  | "no_dot"
  | "bad_characters"
  | "bad_label"
  | "too_long"
  | "not_registrable"
  | "duplicate";

export interface IngestResult {
  /** Normalised, deduplicated, in first-seen order. */
  domains: string[];
  skipped: { value: string; reason: SkipReason }[];
}

/**
 * 191, not the 253 the DNS spec allows — and since `apexOf` the stored value (suffix plus one
 * label) can never get near it anyway. The cap is the sanitation gate on a raw row: a list has
 * no business carrying a 200-character name, and rejecting it costs nothing real. (History:
 * `domain` is half of `DropCandidate`'s composite unique key, which MySQL maps to VARCHAR(191);
 * apex reduction removed the write-time hazard, the gate stays.)
 */
const MAX_DOMAIN_LENGTH = 191;
const MAX_LABEL_LENGTH = 63;

/** IPv4 in dotted form, and anything with a colon (IPv6, or host:port we already stripped). */
function looksLikeIp(host: string): boolean {
  if (host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * One row to a bare host, or `null` with a reason.
 *
 * Accepts what real lists contain: full URLs, `www.` prefixes and other hosts (each row is
 * reduced to its registrable apex — registries answer host-shaped questions with "no match",
 * which reads as free), trailing dots, ports, upper case, surrounding quotes and whitespace.
 * Punycode and Unicode both pass through unchanged — the checker canonicalises IDN later, and
 * converting here would make two spellings of one name look like two candidates.
 */
export function normaliseDomain(input: string): { domain: string } | { reason: SkipReason } {
  let value = (input ?? "").trim().replace(/^["'<]+|["'>,;]+$/g, "").trim();
  if (!value) return { reason: "empty" };

  // Strip a scheme and everything from the first path separator on.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  value = value.split(/[/?#\\]/)[0];
  // Credentials, then port.
  value = value.split("@").pop() as string;
  value = value.replace(/:\d+$/, "");
  value = value.trim().toLowerCase().replace(/\.$/, "");

  if (!value) return { reason: "empty" };
  if (looksLikeIp(value)) return { reason: "ip_address" };
  if (value.length > MAX_DOMAIN_LENGTH) return { reason: "too_long" };
  // Character check before the dot check, and the order matters for the report the user reads:
  // "not a domain at all" is bad_characters, not "a domain that forgot its dot".
  if (/[^a-z0-9.\-¡-￿]/.test(value)) return { reason: "bad_characters" };
  if (!value.includes(".")) return { reason: "no_dot" };

  const labels = value.split(".");
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH) return { reason: "bad_label" };
    if (label.startsWith("-") || label.endsWith("-")) return { reason: "bad_label" };
  }

  // A host row ("www.example.com", "blog.example.co.uk", a crawler outlink) is reduced to the
  // name a person could register. Kept as-is it is worse than noise: registries answer
  // host-shaped questions with "no match", which the funnel would corroborate into a false
  // "available" on a domain somebody owns. "co.uk" alone never forms an apex — rejected above.
  const apex = apexOf(value);
  if (!apex) return { reason: "not_registrable" };

  return { domain: apex };
}

/**
 * A pasted blob or CSV to a candidate list.
 *
 * CSV handling is deliberately dumb: split each line on the usual separators and take the first
 * field that normalises to a domain. Column headers vary by source and a fixed index would break
 * on the next export; "the field that looks like a domain" survives reordering.
 */
export function parseDomainList(raw: string): IngestResult {
  const domains: string[] = [];
  const skipped: IngestResult["skipped"] = [];
  const seen = new Set<string>();

  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A header row names columns and contains no domain; it falls out naturally below.
    const fields = trimmed.split(/[,;\t|]/).map(f => f.trim()).filter(Boolean);
    const candidates = fields.length ? fields : [trimmed];

    let accepted = false;
    let lastReason: SkipReason = "empty";
    for (const field of candidates) {
      const res = normaliseDomain(field);
      if ("reason" in res) { lastReason = res.reason; continue; }
      if (seen.has(res.domain)) { skipped.push({ value: res.domain, reason: "duplicate" }); accepted = true; break; }
      seen.add(res.domain);
      domains.push(res.domain);
      accepted = true;
      break;
    }
    if (!accepted) skipped.push({ value: trimmed, reason: lastReason });
  }

  return { domains, skipped };
}

/** Counts per reason, for the "54 rows dropped, here is why" line above the import. */
export function summariseSkips(skipped: IngestResult["skipped"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}
