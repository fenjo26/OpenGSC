// Client-side persistence for trained AI-fingerprint models.
// Follows the module's existing convention: localStorage is the working store, the user owns the
// data, nothing is uploaded. A model is keyed by name so one instance can hold several — the
// fingerprint is domain-bound, and a model trained on casino pages tells you nothing useful about
// finance pages. Keeping them separate (and visibly named) is what stops that mistake.
"use client";

import { suggestBannedWords, type AiDetectModel } from "./aidetect";

const KEY = "seoAiFingerprints";
const ACTIVE = "seoAiFingerprintActive";

export interface StoredModel {
  name: string;
  model: AiDetectModel;
  /** what the corpus was gathered for — shown in the UI so the domain binding stays obvious */
  note?: string;
}

export function loadModels(): StoredModel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x: any) => x?.name && x?.model?.weights) : [];
  } catch { return []; }
}

// Never throws: models are large-ish, and a quota failure while saving one must not take the page
// down. On overflow the oldest model is evicted and the write retried, mirroring history.ts.
export function saveModels(list: StoredModel[]): boolean {
  if (typeof window === "undefined") return false;
  let items = [...list];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
      return true;
    } catch {
      if (items.length <= 1) return false;
      items = items.slice(0, -1); // drop the oldest and retry
    }
  }
  return false;
}

export function upsertModel(entry: StoredModel): boolean {
  const list = loadModels();
  const i = list.findIndex(m => m.name === entry.name);
  if (i >= 0) list[i] = entry; else list.unshift(entry);
  return saveModels(list);
}

export function removeModel(name: string): void {
  saveModels(loadModels().filter(m => m.name !== name));
  if (getActiveName() === name) setActiveName("");
}

export function getActiveName(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(ACTIVE) || "";
}

export function setActiveName(name: string): void {
  if (typeof window === "undefined") return;
  if (name) localStorage.setItem(ACTIVE, name); else localStorage.removeItem(ACTIVE);
}

export function getActiveModel(): StoredModel | null {
  const name = getActiveName();
  const list = loadModels();
  return list.find(m => m.name === name) || list[0] || null;
}

// ─── Per-model ban-list edits ───────────────────────────────────────────────────
// The operator's decision to keep a word out of the ban list is stored per model and survives
// retraining, because the reason a word was spared ("we need this term") does not change when the
// corpus grows. Stored as the EXCLUSION set rather than the final list so that new candidates
// surfaced by a retrained model are included by default instead of silently dropped.
const EXCL = "seoAiBannedExcluded";

export function getExcluded(modelName: string): string[] {
  if (typeof window === "undefined" || !modelName) return [];
  try {
    const all = JSON.parse(localStorage.getItem(EXCL) || "{}");
    const list = all?.[modelName];
    return Array.isArray(list) ? list.map(String) : [];
  } catch { return []; }
}

export function setExcluded(modelName: string, words: string[]): void {
  if (typeof window === "undefined" || !modelName) return;
  try {
    const all = JSON.parse(localStorage.getItem(EXCL) || "{}");
    all[modelName] = Array.from(new Set(words));
    localStorage.setItem(EXCL, JSON.stringify(all));
  } catch { /* a failed preference write must never break generation */ }
}

/** The list that actually reaches a prompt: suggested candidates minus the operator's exclusions. */
export function effectiveBannedWords(entry: StoredModel | null, limit = 60): string[] {
  if (!entry) return [];
  const excluded = new Set(getExcluded(entry.name));
  return suggestBannedWords(entry.model, limit).filter(w => !excluded.has(w));
}
