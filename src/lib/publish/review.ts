// Pre-publish footprint review — the honest subset of the plan's "connection shares signs
// with other satellites" warning. We do NOT crawl satellites, so signals like "same WP theme"
// or "same credentials" do not exist and are not pretended to. What genuinely exists before
// sending:
//   (a) identical title skeletons among the planned batch (the footprint module's own
//       skeletonOf, applied to a batch instead of a portfolio);
//   (b) anchor concentration — the same exact money-site anchor repeated across posts;
//   (c) scheduledAt clustering — several planned publications inside one clock hour.
// All three are WARNINGS: rendered, never silently blocking (blocking is the uniqueness
// gate's job, and it runs at send time, not here).

import { skeletonOf, skeletonWordCount, domainEntity, MIN_SKELETON_WORDS } from "@/lib/footprint/skeleton";

// ─── link inventory ─────────────────────────────────────────────────────────────

export interface LinkRef {
  /** The anchor text exactly as written (trimmed). */
  anchor: string;
  /** Absolute target URL. */
  url: string;
}

/**
 * Every markdown link whose target belongs to the money-site host (host equals it or a
 * subdomain). This is firstMoneySiteLink generalized: the first money-site link is the
 * backlink row's fallback target, the full inventory is the anchor distribution. Relative
 * and malformed targets cannot be money-site links and are skipped for the same reason
 * firstMoneySiteLink skips them.
 */
export function linkInventory(markdown: string, host: string): LinkRef[] {
  if (!host) return [];
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  const out: LinkRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown || ""))) {
    try {
      const target = new URL(m[2]);
      const h = target.hostname.toLowerCase();
      if (h === host || h.endsWith(`.${host}`)) out.push({ anchor: m[1].trim(), url: target.href });
    } catch { /* not an absolute URL — cannot be the money-site link */ }
  }
  return out;
}

// ─── anchor distribution ────────────────────────────────────────────────────────

export interface AnchorRow {
  anchor: string;
  /** How many of the reviewed posts use this exact anchor toward the money site. */
  posts: number;
  /** Distinct target URLs the anchor points at. */
  urls: string[];
  /** The same exact anchor on 2+ posts — the repeated-commercial-anchor footprint. */
  repeated: boolean;
}

export interface AnchorSummary {
  rows: AnchorRow[];
  /** Posts that contained at least one money-site link. */
  postsWithLinks: number;
}

/** The repeated-anchor flag threshold: 2 satellites sharing one exact anchor is already a pattern. */
export const ANCHOR_REPEAT_MIN_POSTS = 2;
/** Rendered rows cap — a summary that lists 200 anchors stops being a summary. */
export const ANCHOR_ROWS_CAP = 20;

/**
 * Anchor → how many posts → which URLs, across the markdowns given. Empty anchors collapse
 * into "" and are kept: an empty anchor (a bare URL or image link) repeated across satellites
 * is as much a template as a commercial keyword.
 */
export function anchorDistribution(markdowns: string[], host: string): AnchorSummary {
  const byAnchor = new Map<string, { posts: number; urls: Set<string> }>();
  let postsWithLinks = 0;
  for (const md of markdowns) {
    const refs = linkInventory(md, host);
    if (refs.length) postsWithLinks++;
    const seenInThisPost = new Set<string>();
    for (const ref of refs) {
      // Every URL is collected (the row shows where the anchor points across posts), but the
      // POSTS counter increments once per post — the row counts posts, not occurrences.
      const e = byAnchor.get(ref.anchor) ?? { posts: 0, urls: new Set<string>() };
      e.urls.add(ref.url);
      if (!seenInThisPost.has(ref.anchor)) {
        seenInThisPost.add(ref.anchor);
        e.posts++;
      }
      byAnchor.set(ref.anchor, e);
    }
  }
  const rows: AnchorRow[] = [...byAnchor.entries()]
    .map(([anchor, e]) => ({
      anchor,
      posts: e.posts,
      urls: [...e.urls].sort(),
      repeated: e.posts >= ANCHOR_REPEAT_MIN_POSTS,
    }))
    .sort((a, b) => b.posts - a.posts || a.anchor.localeCompare(b.anchor))
    .slice(0, ANCHOR_ROWS_CAP);
  return { rows, postsWithLinks };
}

// ─── batch warnings ─────────────────────────────────────────────────────────────

export interface SkeletonGroup {
  skeleton: string;
  titles: string[];
}

export interface ClusterGroup {
  /** The hour bucket in ISO (YYYY-MM-DDTHH). */
  hour: string;
  titles: string[];
}

export interface BatchWarnings {
  /** ≥2 planned posts whose titles reduce to the same skeleton (entity/years/numbers folded). */
  skeletons: SkeletonGroup[];
  /** Anchor rows repeated across posts (subset of anchorDistribution's rows). */
  repeatedAnchors: AnchorRow[];
  /** ≥2 planned publication times inside one clock hour. */
  clusters: ClusterGroup[];
}

/** One planned post, in the shape the review needs — markdown for anchors, title for skeletons. */
export interface PlannedLike {
  title: string;
  markdown: string;
  scheduledAt?: Date | string | null;
}

/**
 * The batch's footprint review. `extraEntities` are the satellites' own domain labels: a
 * title template reused across satellites swaps THE SATELLITE'S name in, so without them the
 * fold would miss exactly the swap a shared template performs.
 */
export function reviewBatch(planned: PlannedLike[], host: string, extraEntities: string[] = []): BatchWarnings {
  // (a) Title skeletons. The entities folded to {x} are the money site's domain label and
  // the satellites' own — the parts a template would swap. Two titles match when they share
  // the construction after entity/years/numbers fold, which is the footprint module's own
  // reduction applied to the planned batch.
  // Titles below the footprint module's own MIN_SKELETON_WORDS are skipped: "casino review"
  // matches everything and would bury the signal.
  const entities = [...new Set([...(host ? [domainEntity(host)] : []), ...extraEntities.map(e => domainEntity(e))].filter(Boolean))];
  const bySkeleton = new Map<string, string[]>();
  for (const p of planned) {
    const skeleton = skeletonOf(p.title || "", entities);
    if (!skeleton || skeletonWordCount(skeleton) < MIN_SKELETON_WORDS) continue;
    const list = bySkeleton.get(skeleton) ?? [];
    list.push(p.title);
    bySkeleton.set(skeleton, list);
  }
  const skeletons = [...bySkeleton.entries()]
    .filter(([, titles]) => titles.length >= 2)
    .map(([skeleton, titles]) => ({ skeleton, titles }))
    .sort((a, b) => b.titles.length - a.titles.length);

  // (b) Anchor concentration.
  const repeatedAnchors = anchorDistribution(planned.map(p => p.markdown), host).rows.filter(r => r.repeated);

  // (c) scheduledAt clustering: ≥2 posts inside the same clock hour. Random jitter inside a
  // small window legitimately lands two posts in one hour — that is exactly when the warning
  // should say so, while the spread control is still in the operator's hand.
  const byHour = new Map<string, string[]>();
  for (const p of planned) {
    if (!p.scheduledAt) continue;
    const iso = new Date(p.scheduledAt).toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const list = byHour.get(iso) ?? [];
    list.push(p.title);
    byHour.set(iso, list);
  }
  const clusters = [...byHour.entries()]
    .filter(([, titles]) => titles.length >= 2)
    .map(([hour, titles]) => ({ hour, titles }))
    .sort((a, b) => b.titles.length - a.titles.length);

  return { skeletons, repeatedAnchors, clusters };
}
