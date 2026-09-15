// SERP Monitor — host-level diff (CONTRACT.md §3.3, §0 traps 2–4, 6, 7).
// Pure module: imported by both server and client code — no server-only imports here.
// rboExt comes from the sibling pure module ./volatility (same owner, same import constraints).
import type { ChangeKind, HostChange, HostPos, KeywordDiff, SerpRow } from "./types";
import { MOVE_THRESHOLDS, RBO_P_FULL, RBO_P_TOP10 } from "./types";
import { rboExt } from "./volatility";

/** Host list in order of best position, rows beyond `depth` ignored. */
export function hostPositions(rows: SerpRow[], depth: number): HostPos[] {
  const byHost = new Map<string, HostPos>();
  for (const row of rows) {
    if (row.position > depth) continue;
    const known = byHost.get(row.host);
    if (known) {
      if (row.position < known.best) known.best = row.position;
      known.urls += 1;
    } else {
      byHost.set(row.host, { host: row.host, best: row.position, urls: 1 });
    }
  }
  // Ties (two hosts sharing a best position) fall back to the host name for determinism.
  return [...byHost.values()].sort((a, b) => a.best - b.best || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

function round4(x: number): number {
  const rounded = Math.round(x * 10_000) / 10_000;
  return rounded === 0 ? 0 : rounded; // never hand −0 to the DB/UI
}

/** The |delta| that counts as a move inside the band min(from, to) belongs to. */
function moveThreshold(position: number): number {
  for (const band of MOVE_THRESHOLDS) {
    if (position <= band.upTo) return band.delta;
  }
  const last = MOVE_THRESHOLDS[MOVE_THRESHOLDS.length - 1];
  return last ? last.delta : Number.MAX_SAFE_INTEGER;
}

function groupRank(kind: ChangeKind): number {
  // enters first, then moves, then exits — the order the UI shows a change list in.
  return kind === "enter" ? 0 : kind === "exit" ? 2 : 1;
}

function compareChanges(a: HostChange, b: HostChange): number {
  const byGroup = groupRank(a.kind) - groupRank(b.kind);
  if (byGroup !== 0) return byGroup;
  if (a.kind === "enter") return ((a.to ?? 0) - (b.to ?? 0)) || byName(a.host, b.host);
  if (a.kind === "exit") return ((a.from ?? 0) - (b.from ?? 0)) || byName(a.host, b.host);
  const deltaA = Math.abs((a.from ?? 0) - (a.to ?? 0));
  const deltaB = Math.abs((b.from ?? 0) - (b.to ?? 0));
  return (deltaB - deltaA) || byName(a.host, b.host);
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function diffKeyword(
  prev: SerpRow[], cur: SerpRow[],
  opts: { depth: number; ignore: (host: string) => boolean },
): KeywordDiff {
  const prevPos = hostPositions(prev, opts.depth);
  const curPos = hostPositions(cur, opts.depth);
  const prevMap = new Map(prevPos.map((h) => [h.host, h]));
  const curMap = new Map(curPos.map((h) => [h.host, h]));

  const changes: HostChange[] = [];

  for (const [host, to] of curMap) {
    const from = prevMap.get(host);
    if (!from) {
      changes.push({ host, kind: "enter", from: null, to: to.best, urls: to.urls, hidden: opts.ignore(host) });
      continue;
    }
    // Trap 4: the tail is noisy on its own — the threshold grows with the position band.
    if (Math.abs(from.best - to.best) < moveThreshold(Math.min(from.best, to.best))) continue;
    changes.push({
      host,
      kind: to.best < from.best ? "up" : "down",
      from: from.best,
      to: to.best,
      urls: to.urls,
      hidden: opts.ignore(host),
    });
  }
  for (const [host, from] of prevMap) {
    if (curMap.has(host)) continue;
    // Trap 2: nine dropped URLs of one host are ONE exit; `urls` is the reference count.
    changes.push({ host, kind: "exit", from: from.best, to: null, urls: from.urls, hidden: opts.ignore(host) });
  }
  changes.sort(compareChanges);

  // Trap 6: platforms are not competitors, but the SERP did change — volatility counts ALL hosts.
  const prevHosts = prevPos.map((h) => h.host);
  const curHosts = curPos.map((h) => h.host);
  return {
    comparedDepth: opts.depth,
    changes,
    volatility: round4(1 - rboExt(prevHosts, curHosts, RBO_P_FULL)),
    volTop10: round4(1 - rboExt(prevHosts.slice(0, 10), curHosts.slice(0, 10), RBO_P_TOP10)),
    visibleCount: changes.filter((c) => !c.hidden).length,
  };
}
