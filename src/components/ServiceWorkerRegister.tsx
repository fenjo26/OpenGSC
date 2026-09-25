"use client";

// N10 (docs/tasks/wave-nov/N10-pwa-push.md): registers /sw.js and carries the offline-data
// mark. Rendered once from src/app/layout.tsx inside LanguageProvider.
//
// Registration happens only in a secure context — CONTRACT.md §0.8: a service worker (and
// with it the whole Push API) exists on https:// and localhost only. On plain http:// the
// register() call would throw, so it is not attempted and no push UI anywhere on the page
// pretends otherwise.
//
// The banner is the "данные от {time}" half of the offline-reading whitelist: the worker
// serves cached GET /api/uptime/status and /api/gsc/sites when the network is gone and
// posts { type: "opengsc-offline-data", time } — this component turns that into a pill
// and clears it the moment the connection returns.

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function ServiceWorkerRegister() {
  const { t } = useLanguage();
  const [cachedAt, setCachedAt] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* a failed registration must never break the page */ });

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; time?: string } | null;
      if (data && data.type === "opengsc-offline-data" && data.time) setCachedAt(data.time);
    };
    const onOnline = () => setCachedAt("");
    navigator.serviceWorker.addEventListener("message", onMessage);
    window.addEventListener("online", onOnline);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  if (!cachedAt) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed", bottom: "18px", left: "50%", transform: "translateX(-50%)",
        zIndex: 90, pointerEvents: "none",
      }}
    >
      <span className="pill" style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}>
        <WifiOff size={13} />
        {t("pwaOfflineData").replace("{time}", new Date(cachedAt).toLocaleString())}
      </span>
    </div>
  );
}
