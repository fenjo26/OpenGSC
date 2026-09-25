// Lost-link recovery priority (N2) — pure, database-free.
//
// The scorer answers one question: "if I have one hour to win links back, which lost link is
// that hour best spent on?" DR alone would put a DR-90 footer link above a DR-40 editorial
// link to the money page, so the score multiplies what the link was actually worth:
//
//   DR weight (apiDr/100, floor 0.05)
//   × dofollow (1 | 0.3)          — a nofollowed link still has click value, barely weight
//   × in-content (1 | 0.5)        — boilerplate/footer placements were never worth much
//   × target value (1 + log10(1 + clicks28 of urlTo))
//   × freshness of the loss (≤30d 1 · ≤90d 0.6 · older 0.3 · unknown 0.6)
//   × favourite (1.5 | 1)
//
// Each row also gets an ACTION TYPE — the thing to actually do — derived from what the two
// witnesses (the provider and our own check) disagree about. That disagreement is exactly the
// split the checkStatus/pageStatus fields exist for: "page is up, link is gone" is a webmaster
// email; "page is gone" is a restore-or-redirect request; guessing them apart is the product.

export type RecoveryAction =
  | "page_alive_link_removed" // page up, our link is not on it → write the webmaster
  | "page_dead"               // donor page 404/dead → ask to restore or redirect
  | "nofollowed"              // link survives but passes no weight any more
  | "retargeted"              // link now points at a different page of ours
  | "unknown";                // the provider says lost, we never verified → check first

/** One SiteBacklink row plus the two facts the events table adds: when the loss happened and
 *  whether a dofollow link was downgraded to nofollow/sponsored (a transition, not a state —
 *  every nofollow link ever built must not flood this table). */
export interface RecoveryInput {
  id: string;
  urlFrom: string;
  domainFrom: string;
  urlTo: string;
  apiAnchor: string;
  apiDr: number | null;
  apiContent: boolean;
  apiDofollow: boolean;
  apiNofollow: boolean;
  apiSponsored: boolean;
  apiHttpCode: number | null;
  apiLost: boolean;
  checkStatus: string; // unchecked|found|missing|blocked|error
  checkNofollow: boolean;
  checkSponsored: boolean;
  checkTargetOk: boolean | null;
  pageStatus: string; // unknown|alive|dead|blocked
  favorite: boolean;
  /** ISO date of the loss event (or of the check that confirmed it); null = age unknown */
  lostAt: string | null;
  /** the dofollow→nofollow/sponsored downgrade event exists for this row */
  relDowngraded: boolean;
  /** clicks of urlTo over the last 28 days, from DailyMetric (0 when unknown) */
  targetClicks28: number;
}

export interface RecoveryRow extends RecoveryInput {
  score: number;
  action: RecoveryAction;
}

/** Is this row "lost" in the sense that belongs on the recovery table? (brief §4) */
export function isLostLink(r: RecoveryInput): boolean {
  return (
    r.apiLost ||
    r.checkStatus === "missing" ||
    r.checkTargetOk === false ||
    r.relDowngraded
  );
}

function currentlyNoFollow(r: RecoveryInput): boolean {
  // Our check's rel wins when it found the link (seconds old), the provider's otherwise.
  if (r.checkStatus === "found") return r.checkNofollow || r.checkSponsored;
  return r.apiNofollow || r.apiSponsored || !r.apiDofollow;
}

/** The action type. Precedence follows what is actionable: a dead page outranks everything
 *  (there is no link to inspect), a live page with the link missing is the headline case,
 *  and only then the subtler degradations. */
export function recoveryAction(r: RecoveryInput): RecoveryAction {
  const pageDead = r.pageStatus === "dead" || (r.apiHttpCode != null && r.apiHttpCode >= 400);
  if (pageDead) return "page_dead";
  if (r.checkStatus === "missing" && r.pageStatus === "alive") return "page_alive_link_removed";
  if (r.relDowngraded || (r.checkStatus === "found" && (r.checkNofollow || r.checkSponsored))) return "nofollowed";
  if (r.checkTargetOk === false) return "retargeted";
  return "unknown";
}

/** Freshness multiplier of the loss. Unknown age gets the middle band: claiming "brand new"
 *  without a date would inflate it, dumping it to 0.3 would bury a loss the provider only
 *  just noticed. */
export function lossFreshness(lostAt: string | null, now: Date = new Date()): number {
  if (!lostAt) return 0.6;
  const t = Date.parse(lostAt);
  if (Number.isNaN(t)) return 0.6;
  const days = (now.getTime() - t) / 86_400_000;
  if (days <= 30) return 1;
  if (days <= 90) return 0.6;
  return 0.3;
}

/** The value score of one lost link (brief §4 formula). */
export function recoveryScore(r: RecoveryInput, now: Date = new Date()): number {
  const dr = Math.max(0.05, (r.apiDr ?? 0) / 100);
  const dofollow = currentlyNoFollow(r) ? 0.3 : 1;
  const content = r.apiContent ? 1 : 0.5;
  const targetValue = 1 + Math.log10(1 + Math.max(0, r.targetClicks28 || 0));
  const fresh = lossFreshness(r.lostAt, now);
  const fav = r.favorite ? 1.5 : 1;
  return Math.round(dr * dofollow * content * targetValue * fresh * fav * 100) / 100;
}

/** Score and sort the lost links, worst loss (highest value) first. */
export function rankRecovery(rows: readonly RecoveryInput[], now: Date = new Date()): RecoveryRow[] {
  return rows
    .filter(isLostLink)
    .map((r) => ({ ...r, score: recoveryScore(r, now), action: recoveryAction(r) }))
    .sort((a, b) => b.score - a.score || a.domainFrom.localeCompare(b.domainFrom));
}
