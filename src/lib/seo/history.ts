// Local history of SEO Tools generations (outline / text / analysis).
// Stored in localStorage — same browser-only convention as keys/policies.
"use client";

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
    diagnostics?: {
      mechanics?: { code: string; detail: string; fixed?: boolean; samples?: string[] }[];
      judgeConcerns?: string[];
      usedSources?: number;
      autoCleaned?: boolean;
      incomplete?: boolean;
      missingHeadings?: string[];
    };
  };
}

const KEY = "seoHistory";
const MAX = 40;

// Quota-safe persist: enriched outlines are heavy (100-300KB each), so localStorage's ~5MB
// cap is reachable. On QuotaExceededError evict the OLDEST records and retry — the newest
// record (first in the list) always survives, so redirects to it never break. Never throws:
// a failed history write must not crash the generation onDone flow.
// ─── Server sync: localStorage is the working cache, the server copy survives browser
// resets. Every persist() schedules a debounced push; syncHistoryFromServer() (called once
// on app mount, see SeoKeysSync) restores records missing locally. Pushes are blocked
// until the initial pull finished, so a freshly-wiped browser can never clobber the backup.
let historyPulled = false;
let pushTimer: any = null;
function schedulePush(): void {
  if (typeof window === "undefined" || !historyPulled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const list = loadHistory();
    if (!list.length) return;
    fetch("/api/seo/history", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: list }),
    }).catch(() => {});
  }, 2_500);
}

export async function syncHistoryFromServer(): Promise<number> {
  if (typeof window === "undefined") return 0;
  try {
    const res = await fetch("/api/seo/history", { cache: "no-store" });
    if (!res.ok) { historyPulled = true; return 0; }
    const d = await res.json();
    const server: HistoryItem[] = Array.isArray(d?.records) ? d.records : [];
    const local = loadHistory();
    const have = new Set(local.map(h => h.id));
    const missing = server.filter(r => r?.id && !have.has(r.id));
    if (missing.length) {
      const merged = [...local, ...missing].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      persist(merged);
      window.dispatchEvent(new Event("seo-history-restored"));
    }
    historyPulled = true;
    schedulePush(); // seed/refresh the backup with whatever is local-only
    return missing.length;
  } catch {
    historyPulled = true;
    return 0;
  }
}

function persist(list: HistoryItem[]): void {
  if (typeof window === "undefined") return;
  let next = list.slice(0, MAX);
  schedulePush();
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
        } catch { /* give up silently — history is a cache, not the source of truth */ }
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

export function addHistory(item: { type: HistoryType; keyword: string; data: any; status?: HistoryStatus; meta?: HistoryItem["meta"]; createdAt?: number }): HistoryItem {
  const rec: HistoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: item.type,
    keyword: item.keyword || "—",
    createdAt: item.createdAt ?? Date.now(),
    status: item.status ?? "completed",
    data: item.data,
    meta: item.meta,
  };
  persist([rec, ...loadHistory()]);
  return rec;
}

export function patchHistory(id: string, patch: Partial<Pick<HistoryItem, "status" | "data">> & { meta?: HistoryItem["meta"] }) {
  if (typeof window === "undefined") return;
  persist(loadHistory().map(h =>
    h.id === id ? { ...h, ...patch, meta: { ...h.meta, ...patch.meta } } : h
  ));
}

export function getHistoryItem(id: string): HistoryItem | undefined {
  return loadHistory().find(h => h.id === id);
}

export function updateHistory(id: string, data: any) {
  if (typeof window === "undefined") return;
  persist(loadHistory().map(h => h.id === id ? { ...h, data } : h));
}

export function removeHistory(id: string) {
  if (typeof window === "undefined") return;
  persist(loadHistory().filter(h => h.id !== id));
  fetch(`/api/seo/history?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

export function clearHistory() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
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
