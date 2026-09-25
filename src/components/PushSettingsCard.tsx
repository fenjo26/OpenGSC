"use client";

// N10 (docs/tasks/wave-nov/N10-pwa-push.md) — Settings card for web push + PWA install.
//
// The honest-support matrix from CONTRACT.md §0.8 and the brief:
//   • http:// (not a secure context)     → explain "push needs HTTPS", no buttons at all;
//   • no PushManager in this browser     → "browser does not support push";
//   • iOS but not installed to Home Screen → "install the app first" (iOS 16.4+ limitation);
//   • permission denied in the browser   → "blocked in browser settings";
//   • otherwise                          → enable/disable, device list, per-device filter, test.
//
// The install button uses beforeinstallprompt where it exists (Chrome/Edge/Android); iOS
// Safari never fires it, so there the card shows the Share → Add to Home Screen instruction.

import { useEffect, useState } from "react";
import { Bell, BellRing, CheckCircle, Download, Smartphone, Trash2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { EventPicker } from "@/components/NotifyChannelsCard";
import type { NotifyEvent } from "@/lib/notify/types";

interface DeviceRow {
  endpoint: string;
  userAgent: string;
  events: NotifyEvent[];
  failures: number;
  lastOkAt: string | null;
  createdAt: string;
}

interface SupportState {
  ready: boolean;         // secure context + SW + PushManager + Notification
  needsHttps: boolean;
  unsupported: boolean;
  iosNotStandalone: boolean;
  denied: boolean;
}

const INITIAL_SUPPORT: SupportState = { ready: false, needsHttps: false, unsupported: false, iosNotStandalone: false, denied: false };

function detectSupport(): SupportState {
  if (typeof window === "undefined") return INITIAL_SUPPORT;
  const secure = window.isSecureContext;
  const hasSw = "serviceWorker" in navigator;
  const hasPush = "PushManager" in window;
  const hasNotification = "Notification" in window;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const denied = hasNotification && Notification.permission === "denied";
  return {
    ready: secure && hasSw && hasPush && hasNotification,
    needsHttps: !secure,
    unsupported: secure && (!hasSw || !hasPush || !hasNotification),
    iosNotStandalone: isIos && !standalone,
    denied,
  };
}

/** VAPID key arrives urlsafe-base64; subscribe() wants the raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export default function PushSettingsCard() {
  const { t } = useLanguage();
  // Detect during render (PasswordChangeGate convention): detectSupport() answers the
  // all-false INITIAL_SUPPORT shape on the server, so there is no state to sync in an effect.
  const [support] = useState<SupportState>(() => detectSupport());
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [currentEndpoint, setCurrentEndpoint] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();
  const [installEvent, setInstallEvent] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);

  const loadDevices = () => fetch("/api/push/subscribe")
    .then(r => r.json())
    .then(d => setDevices(Array.isArray(d?.subscriptions) ? d.subscriptions : []))
    .catch(() => setDevices([]));

  useEffect(() => {
    loadDevices();
    // Which of the listed devices is THIS browser — read from the live subscription so the
    // "disable on this device" button targets the right endpoint.
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.ready
        .then(reg => reg.pushManager.getSubscription())
        .then(sub => setCurrentEndpoint(sub?.endpoint ?? ""))
        .catch(() => {});
    }
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // keep the browser mini-infobar out; our button is the prompt
      setInstallEvent(e as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const enable = async () => {
    setBusy("enable");
    setMsg(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMsg({ ok: false, text: permission === "denied" ? t("pwaPushDenied") : t("no") });
        return;
      }
      const vapidRes = await fetch("/api/push/vapid");
      const vapid = await vapidRes.json();
      if (!vapidRes.ok || !vapid?.publicKey) {
        setMsg({ ok: false, text: vapid?.notMigrated ? t("autoSyncNotMigrated") : t("pwaPushUnsupported") });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub = existing ?? await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(String(vapid.publicKey)),
      });
      const json = sub.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          userAgent: navigator.userAgent,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        // The browser holds a subscription the server refused — drop it so the next attempt starts clean.
        await sub.unsubscribe().catch(() => {});
        setMsg({ ok: false, text: d?.notMigrated ? t("autoSyncNotMigrated") : String(d?.error ?? "error") });
        return;
      }
      setCurrentEndpoint(sub.endpoint);
      await loadDevices();
      setMsg({ ok: true, text: "✓" });
    } catch {
      setMsg({ ok: false, text: t("pwaPushUnsupported") });
    }
    setBusy("");
  };

  const disable = async () => {
    setBusy("disable");
    setMsg(undefined);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setCurrentEndpoint("");
      await loadDevices();
      setMsg({ ok: true, text: "✓" });
    } catch {
      setMsg({ ok: false, text: "error" });
    }
    setBusy("");
  };

  const removeDevice = async (endpoint: string) => {
    setBusy(`del:${endpoint}`);
    try {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      if (endpoint === currentEndpoint) setCurrentEndpoint("");
      await loadDevices();
    } catch { /* the row stays; retry works */ }
    setBusy("");
  };

  const setDeviceEvents = async (endpoint: string, events: NotifyEvent[]) => {
    setDevices(prev => (prev ?? []).map(d => (d.endpoint === endpoint ? { ...d, events } : d)));
    await fetch("/api/push/subscribe", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, events }),
    }).catch(() => {});
  };

  const sendTest = async () => {
    setBusy("test");
    setMsg(undefined);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const d = await res.json();
      if (!res.ok) setMsg({ ok: false, text: d?.notMigrated ? t("autoSyncNotMigrated") : String(d?.error ?? "error") });
      else if (d?.ok) setMsg({ ok: true, text: t("notifyChTestOk") });
      else setMsg({ ok: false, text: d?.error === "not_configured" ? t("apiKeyNotConfigured") : String(d?.error ?? "error") });
      await loadDevices();
    } catch {
      setMsg({ ok: false, text: "error" });
    }
    setBusy("");
  };

  const install = async () => {
    if (!installEvent) return;
    setBusy("install");
    try {
      await installEvent.prompt();
    } catch { /* dismissed — nothing to do */ }
    setBusy("");
  };

  const enabledHere = !!currentEndpoint && devices?.some(d => d.endpoint === currentEndpoint);

  const deviceLabel = (ua: string): string => {
    const browser = /firefox/i.test(ua) ? "Firefox" : /edg\//i.test(ua) ? "Edge" : /chrome/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Browser";
    const os = /iphone|ipad|ipod/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : /mac os/i.test(ua) ? "macOS" : /windows/i.test(ua) ? "Windows" : /linux/i.test(ua) ? "Linux" : "";
    return `${browser}${os ? ` · ${os}` : ""}`;
  };

  return (
    <div id="push-settings" className="card" style={{ display: "flex", flexDirection: "column", gap: "10px", scrollMarginTop: "80px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <Smartphone size={17} color="#2997ff" />
        <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("pwaPushTitle")}</h2>
        {devices && devices.length > 0 && (
          <span className="pill" style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {t("pwaPushCount").replace("{n}", String(devices.length))}
          </span>
        )}
      </div>

      {/* Support matrix — explain instead of showing a button that cannot work (§0.8). */}
      {support.needsHttps && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "#f87171" }}>
          <X size={14} /> {t("pwaPushNeedsHttps")}
        </div>
      )}
      {support.unsupported && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "#f87171" }}>
          <X size={14} /> {t("pwaPushUnsupported")}
        </div>
      )}
      {support.iosNotStandalone && !support.needsHttps && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <Bell size={14} /> {t("pwaPushIosStandalone")}
        </div>
      )}
      {support.denied && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "#f87171" }}>
          <X size={14} /> {t("pwaPushDenied")}
        </div>
      )}

      {/* Push buttons — only where push can actually work. */}
      {support.ready && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {!support.denied && !enabledHere && (
            <button type="button" onClick={enable} disabled={!!busy}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
              <BellRing size={13} /> {busy === "enable" ? "…" : t("pwaPushEnable")}
            </button>
          )}
          {enabledHere && (
            <>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#10B981", fontWeight: 600 }}>
                <CheckCircle size={13} /> {deviceLabel(navigator.userAgent)}
              </span>
              <button type="button" onClick={disable} disabled={!!busy}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
                {busy === "disable" ? "…" : t("pwaPushDisable")}
              </button>
              <button type="button" onClick={sendTest} disabled={!!busy}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
                {busy === "test" ? "…" : t("pwaPushTest")}
              </button>
            </>
          )}
          {msg && <span style={{ fontSize: "12px", color: msg.ok ? "#10B981" : "#f87171" }}>{msg.text}</span>}
        </div>
      )}

      {/* Install — beforeinstallprompt where it exists, the iOS instruction where it does not. */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        {installEvent ? (
          <button type="button" onClick={install} disabled={!!busy}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
            <Download size={13} /> {t("pwaInstall")}
          </button>
        ) : /iphone|ipad|ipod/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") ? (
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("pwaInstallIos")}</span>
        ) : null}
      </div>

      {/* Devices — one event filter per phone. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-secondary)" }}>{t("pwaPushDevices")}</div>
        {devices === null && <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>}
        {devices !== null && devices.length === 0 && (
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("apiKeyNotConfigured")}</div>
        )}
        {(devices ?? []).map(d => (
          <div key={d.endpoint} style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <Smartphone size={13} color="var(--color-text-secondary)" />
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)" }}>{deviceLabel(d.userAgent)}</span>
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{new Date(d.createdAt).toLocaleDateString()}</span>
              {d.endpoint === currentEndpoint && (
                <span className="pill" style={{ fontSize: "11px", color: "#10B981" }}>✓</span>
              )}
              {d.lastOkAt && (
                <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                  {t("notifyChLastOk").replace("{time}", new Date(d.lastOkAt).toLocaleString())}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => removeDevice(d.endpoint)} disabled={busy === `del:${d.endpoint}`}
                aria-label={t("remove")} title={t("remove")}
                style={{ display: "inline-flex", alignItems: "center", padding: "5px", border: "none", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
                <Trash2 size={13} />
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <EventPicker events={d.events} onToggle={ev =>
                setDeviceEvents(d.endpoint, d.events.includes(ev) ? d.events.filter(x => x !== ev) : [...d.events, ev])} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
