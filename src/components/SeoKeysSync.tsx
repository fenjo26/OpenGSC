"use client";

// Invisible component (mounted once in the root layout) that keeps the browser-side SEO
// settings (API keys, providers, models, policies) backed up to the server per user.
//
// - On mount: pull the server snapshot and RESTORE any keys missing locally — so after
//   clearing browser storage everything comes back on the next page load.
// - Every 20s + on tab hide: push a snapshot IF it changed — so newly entered keys are
//   backed up without wiring every settings input.

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { syncHistoryFromServer } from "@/lib/seo/history";

const EXACT_KEYS = [
  "aiProvider", "aiApiKey", "seoProvider", "seoModel", "seoSerpProvider", "seoSerpProvider_rank",
  "seoActivePolicy", "seoPolicies",
  "seoAutoFactcheck", "seoAutoImages", "seoHardRedact", "seoFactSources",
  "seoFactBearingOnly", "seoFactReuseCorpus",
  // The scheduled warm-up is the only setting here a *server* process reads: the cron has no
  // browser, so a value that lived only in localStorage would be invisible to the thing it
  // configures. It rides the same mirror as everything else rather than getting its own endpoint.
  "seoWarmupSchedule",
  // The keyword-source selector and its behaviour flags — same reason the metrics layer is
  // mirrored: restoring a browser without them silently reverts the content tools to "off".
  "seoKwSource", "seoKwAuto", "seoKwLimit",
];
// `seoMetrics` covers the whole metrics layer: mode, base URL, monthly cap, active provider.
//
// It has to be here, and leaving it out was a real bug rather than a missing nicety. The key
// itself matches `seoKey_` and so was already backed up and restored — but the host it must be
// sent to was not. Restore then produced a reseller key pointed at the official API: the mode
// silently reverted to "official", and every request 401'd for a reason nothing on screen
// explained. Server-side code reads the same snapshot, so it had no way to learn the host either.
const PREFIXES = [
  "aiKey_", "aiBaseUrl_", "aiModel_", "seoKey_", "seoTaskProvider_", "seoTaskModel_",
  "seoMetrics",
];

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (EXACT_KEYS.includes(k) || PREFIXES.some(p => k.startsWith(p))) {
      const v = localStorage.getItem(k);
      if (v != null && v !== "") out[k] = v;
    }
  }
  return out;
}

let lastPushed = ""; // module-level: survives re-mounts within the same page session

async function pullAndRestore(): Promise<void> {
  const res = await fetch("/api/settings/seo-sync", { cache: "no-store" });
  if (!res.ok) return;
  const d = await res.json();
  const server: Record<string, string> = d?.settings && typeof d.settings === "object" ? d.settings : {};
  let restored = 0;
  for (const [k, v] of Object.entries(server)) {
    if (typeof v !== "string") continue;
    if (!(EXACT_KEYS.includes(k) || PREFIXES.some(p => k.startsWith(p)))) continue;
    if (localStorage.getItem(k) == null) { localStorage.setItem(k, v); restored++; }
  }
  if (restored > 0) window.dispatchEvent(new Event("seo-keys-restored"));
}

async function pushIfChanged(): Promise<void> {
  const snap = snapshot();
  if (!Object.keys(snap).length) return; // nothing configured — don't overwrite a backup with emptiness
  const json = JSON.stringify(snap);
  if (json === lastPushed) return;
  const res = await fetch("/api/settings/seo-sync", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: snap }),
  });
  if (res.ok) lastPushed = json;
}

function isTrackedKey(k: string): boolean {
  return EXACT_KEYS.includes(k) || PREFIXES.some(p => k.startsWith(p));
}

let patched = false;
let pushSoonTimer: any = null;

// Debounced immediate push: fires ~600ms after the last tracked-key write, instead of
// waiting for the 20s interval or an actual tab-hide event. This is what makes freshly
// saved keys show up right away (e.g. the AI Visibility "configured engines" badge).
function pushSoon() {
  clearTimeout(pushSoonTimer);
  pushSoonTimer = setTimeout(() => { pushIfChanged().catch(() => {}); }, 600);
}

function patchLocalStorageOnce() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const origSetItem = localStorage.setItem.bind(localStorage);
  const origRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = function (k: string, v: string) {
    origSetItem(k, v);
    if (isTrackedKey(k)) pushSoon();
  };
  localStorage.removeItem = function (k: string) {
    origRemoveItem(k);
    if (isTrackedKey(k)) pushSoon();
  };
}

export default function SeoKeysSync() {
  const { status } = useSession();
  useEffect(() => {
    if (status !== "authenticated") return;
    patchLocalStorageOnce();
    let timer: any;
    (async () => {
      try { await pullAndRestore(); } catch { /* offline / not migrated — silent */ }
      try { await pushIfChanged(); } catch { /* silent */ }
      try { await syncHistoryFromServer(); } catch { /* silent */ }
      timer = setInterval(() => { pushIfChanged().catch(() => {}); }, 20_000);
    })();
    const onHide = () => { if (document.visibilityState === "hidden") pushIfChanged().catch(() => {}); };
    document.addEventListener("visibilitychange", onHide);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onHide); };
  }, [status]);
  return null;
}
