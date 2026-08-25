// Local history of SEO Tools generations (outline / text / analysis).
//
// The SERVER table SeoHistory is the source of truth: the History page reads it with
// pagination and every record ever pushed stays there. localStorage is only a working cache —
// it makes tool pages and pickers instant and keeps the newest records readable offline. The
// cache holds the newest CACHE_MAX records and evicts older ones freely; nothing is lost,
// because the server copy is permanent. Server pushes are per-record (dirty ids), never the
// whole list, so an unbounded server history costs nothing on the browser side.
"use client";

import type { SeoDiagnostics } from "@/lib/seo/historyShared";

export type HistoryType = "outline" | "text" | "analysis" | "landing" | "cluster" | "googlebot";
export type HistoryStatus = "processing" | "completed" | "error";

export interface HistoryItem {
  id: string;
  type: HistoryType;
  keyword: string;
  createdAt: number;
  status: HistoryStatus;
  data: any; // outline object | article string | gap report object
  meta?: {
    tone?: string; promptType?: string; version?: string; error?: string; outlineId?: string;
    factcheck?: any; images?: any; serpIntent?: any; jobId?: string;
    /**
     * What the pipeline noticed about this result but could not fix by itself.
     *
     * `data` for a text record is the article STRING, so everything the generator reported
     * alongside it — the mechanics audit, the QA reviewer's soft findings, how many sources
     * grounded it — had nowhere to live and was dropped at import. A report nobody can see is
     * not a report, and this is the only screen where the article itself is read.
     */
    diagnostics?: SeoDiagnostics;
  };
}

const KEY = "seoHistory";
// Soft target for the CACHE only. The server keeps everything; past records are one fetch away
// (History page pagination, resolveHistoryItem). A target well under the ~5MB localStorage
// quota keeps persist() from churning through evict-retry loops on every write.
const CACHE_MAX = 150;
// Ids changed locally and not yet confirmed on the server. Survives reloads so a record
// created seconds before a tab close still reaches the server on the next visit.
const DIRTY_KEY = "seoHistoryDirty";

// Quota-safe persist: enriched outlines are heavy (100-300KB each), so localStorage's ~5MB
// cap is reachable. On QuotaExceededError evict the OLDEST records and retry — the newest
// record (first in the list) always survives, so redirects to it never break. Evicted records
// still exist on the server; the cache refills them on demand. Never throws: a failed history
// write must not crash the generation onDone flow.
// ─── Server sync: pushes are per-record. Mutators mark record ids dirty; a debounced flush
// PUTs exactly those records. Pulls (syncHistoryFromServer / adoptIntoCache) only fill the
// cache and never mark anything dirty, so a freshly-wiped browser can never clobber the
// server copy, and a restored record is never re-pushed in a loop.
let historyPulled = false;
let pushTimer: any = null;
let flushInFlight = false;

function readDirty(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const arr = JSON.parse(localStorage.getItem(DIRTY_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter(x => typeof x === "string") : [];
  } catch { return []; }
}
function writeDirty(ids: string[]): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(DIRTY_KEY, JSON.stringify([...new Set(ids)])); } catch { /* cache-only loss */ }
}
function markDirty(ids: string[]): void {
  if (!ids.length) return;
  writeDirty([...readDirty(), ...ids]);
}

function schedulePush(): void {
  if (typeof window === "undefined" || !historyPulled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { void flushHistoryDirty(); }, 2_500);
}

// Push every dirty record that still exists locally. Ids whose records vanished (cache
// eviction) are dropped from the list — the server copy, if any, is authoritative anyway.
export async function flushHistoryDirty(): Promise<void> {
  if (typeof window === "undefined" || !historyPulled || flushInFlight) return;
  const ids = readDirty();
  if (!ids.length) return;
  const idSet = new Set(ids);
  const recs = loadHistory().filter(h => idSet.has(h.id));
  if (!recs.length) { writeDirty([]); return; }
  flushInFlight = true;
  try {
    const res = await fetch("/api/seo/history", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: recs }),
    });
    if (res.ok) {
      const pushed = new Set(recs.map(r => r.id));
      writeDirty(readDirty().filter(i => !pushed.has(i)));
    }
  } catch { /* keep ids dirty — the next debounce retries */ }
  finally { flushInFlight = false; }
}

export async function syncHistoryFromServer(): Promise<number> {
  if (typeof window === "undefined") return 0;
  try {
    const res = await fetch("/api/seo/history?limit=150", { cache: "no-store" });
    if (!res.ok) { historyPulled = true; return 0; }
    const d = await res.json();
    const server: HistoryItem[] = Array.isArray(d?.records) ? d.records : [];
    const missing = adoptIntoCache(server);
    historyPulled = true;
    void flushHistoryDirty(); // records created before the pull still waiting on their push
    return missing;
  } catch {
    historyPulled = true;
    return 0;
  }
}

// Merge server records into the cache. Records already present locally are left untouched —
// the local copy may carry edits whose push is still in flight. Returns how many were adopted.
function adoptIntoCache(server: HistoryItem[]): number {
  if (typeof window === "undefined" || !server.length) return 0;
  const local = loadHistory();
  const have = new Set(local.map(h => h.id));
  const missing = server.filter(r => r?.id && !have.has(r.id));
  if (missing.length) {
    persist([...missing, ...local].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    window.dispatchEvent(new Event("seo-history-restored"));
  }
  return missing.length;
}

function persist(list: HistoryItem[]): void {
  if (typeof window === "undefined") return;
  let next = list.length > CACHE_MAX ? list.slice(0, CACHE_MAX) : list;
  for (;;) {
    try { localStorage.setItem(KEY, JSON.stringify(next)); return; }
    catch {
      if (next.length <= 1) {
        // Single record still too big — strip the heavy carried blocks and try once more.
        try {
          const slim = next.map(h => {
            const d = h?.data && typeof h.data === "object" ? { ...h.data } : h.data;
            if (d && typeof d === "object" && d.meta && typeof d.meta === "object") {
              const { sources: _s, facts_bank: _f, ...metaSlim } = d.meta;
              void _s; void _f;
              d.meta = metaSlim;
            }
            return { ...h, data: d };
          });
          localStorage.setItem(KEY, JSON.stringify(slim));
        } catch { /* give up silently — the server copy is the source of truth */ }
        return;
      }
      next = next.slice(0, next.length - Math.max(1, Math.ceil(next.length * 0.2))); // evict oldest ~20%
    }
  }
}

export function loadHistory(): HistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function addHistory(item: { id?: string; type: HistoryType; keyword: string; data: any; status?: HistoryStatus; meta?: HistoryItem["meta"]; createdAt?: number }): HistoryItem {
  const rec: HistoryItem = {
    // An explicit id (the server uses the job id for imported jobs) converges browser and
    // server on one row; everything else keeps the generated id.
    id: item.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: item.type,
    keyword: item.keyword || "—",
    createdAt: item.createdAt ?? Date.now(),
    status: item.status ?? "completed",
    data: item.data,
    meta: item.meta,
  };
  persist([rec, ...loadHistory().filter(h => h.id !== rec.id)]);
  markDirty([rec.id]);
  schedulePush();
  return rec;
}

export function patchHistory(id: string, patch: Partial<Pick<HistoryItem, "status" | "data">> & { meta?: HistoryItem["meta"] }) {
  if (typeof window === "undefined") return;
  persist(loadHistory().map(h =>
    h.id === id ? { ...h, ...patch, meta: { ...h.meta, ...patch.meta } } : h
  ));
  markDirty([id]);
  schedulePush();
}

export function getHistoryItem(id: string): HistoryItem | undefined {
  return loadHistory().find(h => h.id === id);
}

// Cache-first read with a server fallback. Records evicted from the cache (anything older
// than the newest CACHE_MAX) still exist on the server; this fetches one by id, adopts it
// into the cache, and returns it.
export async function resolveHistoryItem(id: string): Promise<HistoryItem | null> {
  const local = getHistoryItem(id);
  if (local) return local;
  try {
    const res = await fetch(`/api/seo/history?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    const rec: HistoryItem | null = d?.record ?? null;
    if (rec?.id) adoptIntoCache([rec]);
    return rec;
  } catch { return null; }
}

export function updateHistory(id: string, data: any) {
  if (typeof window === "undefined") return;
  persist(loadHistory().map(h => h.id === id ? { ...h, data } : h));
  markDirty([id]);
  schedulePush();
}

export function removeHistory(id: string) {
  if (typeof window === "undefined") return;
  persist(loadHistory().filter(h => h.id !== id));
  writeDirty(readDirty().filter(i => i !== id));
  fetch(`/api/seo/history?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

export function clearHistory() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
  writeDirty([]);
  fetch("/api/seo/history?all=1", { method: "DELETE" }).catch(() => {});
}

// Hand a history item to its tool page for viewing (read on that page's mount).
export function stashForView(item: HistoryItem) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem("seoView", JSON.stringify({ type: item.type, data: item.data, keyword: item.keyword }));
}

export function takeView(): { type: HistoryType; data: any; keyword: string } | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem("seoView");
  if (!raw) return null;
  sessionStorage.removeItem("seoView");
  try { return JSON.parse(raw); } catch { return null; }
}
