"use client";

// "Update available" banner + one-click updater. Shown app-wide (mounted in DashboardShell).
// Checks GitHub for a newer main commit; if behind, shows a bar with a changelog and an
// "Update now" button that runs update.sh on the VPS and streams its log. On success it
// prompts a page reload. Owner-only actions are enforced server-side; guests never see it
// (no session → /api/system/version returns 401 and the banner stays hidden).

import { useEffect, useRef, useState } from "react";
import { Loader2, Download, X, CheckCircle, AlertTriangle, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type Info = { isGit: boolean; updateAvailable: boolean; behind?: number; local?: string; remote?: string; changelog?: { sha: string; message: string; date: string }[] };

export default function UpdateBanner() {
  const { t } = useLanguage();
  const [info, setInfo] = useState<Info | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [log, setLog] = useState("");
  // When the poll last got an answer. update.sh stops the app for the build window, so polls fail
  // for minutes BY DESIGN; the modal says so instead of spinning silently, and only after a long
  // silence tells the owner to look at the server.
  const [lastSeen, setLastSeen] = useState(0);
  const [now, setNow] = useState(0);
  const pollRef = useRef<any>(null);
  const logBoxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // Check once on mount, then hourly. Silent on any error (network / not owner / docker).
    let cancelled = false;
    const check = async () => {
      try {
        const d = await fetch("/api/system/version").then(r => (r.ok ? r.json() : null));
        if (!cancelled && d) setInfo(d);
      } catch { /* silent */ }
    };
    check();
    const iv = setInterval(check, 60 * 60 * 1000);
    // remember dismissal per remote commit so a NEW version re-shows the bar
    try {
      const d = sessionStorage.getItem("update_dismissed");
      if (d) setDismissed(true);
    } catch {}
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Re-show the bar if a newer remote arrives than the one we dismissed
  useEffect(() => {
    if (!info?.remote) return;
    try {
      const d = sessionStorage.getItem("update_dismissed");
      setDismissed(d === info.remote);
    } catch {}
  }, [info?.remote]);

  const startUpdate = async () => {
    setPhase("running"); setLog(""); setLastSeen(Date.now()); setNow(Date.now());
    try {
      const res = await fetch("/api/system/update", { method: "POST" });
      const d = await res.json();
      if (!res.ok) { setPhase("failed"); setLog(d.message || d.error || "error"); return; }
    } catch (e: any) { setPhase("failed"); setLog(String(e?.message ?? e)); return; }
    // Poll the log. pm2 restart mid-way makes the API blink — tolerate fetch errors.
    pollRef.current = setInterval(async () => {
      setNow(Date.now());
      try {
        const r = await fetch("/api/system/update", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status)); // nginx 502 while the app is stopped
        const d = await r.json();
        setLastSeen(Date.now());
        setLog(d.log || "");
        if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
        if (d.done) { clearInterval(pollRef.current); setPhase("done"); }
        else if (d.failed) { clearInterval(pollRef.current); setPhase("failed"); }
      } catch { /* API restarting — keep polling */ }
    }, 2000);
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const dismiss = () => {
    setDismissed(true);
    try { if (info?.remote) sessionStorage.setItem("update_dismissed", info.remote); } catch {}
  };

  if (!info?.updateAvailable || (dismissed && phase === "idle")) return null;

  return (
    <>
      {/* Top bar */}
      {!dismissed && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 16px", background: "linear-gradient(90deg, rgba(59,130,246,0.14), rgba(139,92,246,0.14))", borderBottom: "1px solid rgba(59,130,246,0.3)", fontSize: "13px", color: "var(--color-text-primary)", flexWrap: "wrap" }}>
          <Download size={15} style={{ color: "var(--color-accent-blue)", flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>{t("updateAvailable")}</span>
          {info.behind ? <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>({info.behind} {t("updateCommitsBehind")})</span> : null}
          <span style={{ flex: 1 }} />
          <button onClick={() => setOpen(true)} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "8px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
            <Download size={13} /> {t("updateNow")}
          </button>
          <button onClick={dismiss} title={t("updateLater")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "4px", display: "flex" }}><X size={15} /></button>
        </div>
      )}

      {/* Modal */}
      {open && (
        <div onClick={() => phase !== "running" && setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "14px", width: "100%", maxWidth: "620px", maxHeight: "85vh", overflow: "auto", padding: "22px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
              <Download size={20} style={{ color: "var(--color-accent-blue)" }} />
              <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0, color: "var(--color-text-primary)" }}>{t("updateTitle")}</h2>
              <span style={{ flex: 1 }} />
              {phase !== "running" && <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}><X size={18} /></button>}
            </div>

            {phase === "idle" && (
              <>
                <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{t("updateIntro")}</p>
                {info.changelog && info.changelog.length > 0 && (
                  <div style={{ margin: "12px 0", border: "1px solid var(--color-border)", borderRadius: "10px", overflow: "hidden" }}>
                    <div style={{ fontSize: "12px", fontWeight: 700, padding: "10px 14px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}>{t("updateChangelog")}</div>
                    <div style={{ maxHeight: "220px", overflow: "auto" }}>
                      {info.changelog.map((c, i) => (
                        <div key={i} style={{ display: "flex", gap: "8px", padding: "7px 14px", fontSize: "12px", borderTop: i ? "1px solid var(--color-border)" : "none", color: "var(--color-text-secondary)" }}>
                          <code style={{ color: "var(--color-accent-blue)", flexShrink: 0 }}>{c.sha}</code>
                          <span style={{ color: "var(--color-text-primary)" }}>{c.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ fontSize: "12px", color: "#f59e0b", marginBottom: "14px", display: "flex", alignItems: "flex-start", gap: "6px" }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: "1px" }} /> {t("updateWarn")}
                </div>
                <button onClick={startUpdate} style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "11px 20px", borderRadius: "10px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: "pointer" }}>
                  <Download size={15} /> {t("updateStart")}
                </button>
              </>
            )}

            {(phase === "running" || phase === "failed" || phase === "done") && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", margin: "8px 0 12px", fontSize: "14px", fontWeight: 600 }}>
                  {phase === "running" && <><Loader2 size={16} className="spin" style={{ color: "var(--color-accent-blue)" }} /> <span style={{ color: "var(--color-text-primary)" }}>{t("updateRunning")}</span></>}
                  {phase === "done" && <><CheckCircle size={16} style={{ color: "#34c759" }} /> <span style={{ color: "#34c759" }}>{t("updateDone")}</span></>}
                  {phase === "failed" && <><AlertTriangle size={16} style={{ color: "#ff375f" }} /> <span style={{ color: "#ff375f" }}>{t("updateFailed")}</span></>}
                </div>
                {phase === "running" && now - lastSeen > 6000 && (
                  <div style={{ margin: "0 0 12px", fontSize: "13px", lineHeight: 1.5, color: now - lastSeen > 20 * 60 * 1000 ? "#ff375f" : "var(--color-text-secondary)" }}>
                    {now - lastSeen > 20 * 60 * 1000 ? t("updateUnreachable") : t("updateRebuilding")}
                  </div>
                )}
                <pre ref={logBoxRef} style={{ background: "#0b0b0f", color: "#c9d1d9", borderRadius: "10px", padding: "12px 14px", fontSize: "11px", lineHeight: 1.5, maxHeight: "300px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
                  {log || t("updateWaiting")}
                </pre>
                {phase === "done" && (
                  <button onClick={() => window.location.reload()} style={{ marginTop: "14px", display: "inline-flex", alignItems: "center", gap: "8px", padding: "11px 20px", borderRadius: "10px", border: "none", background: "#34c759", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: "pointer" }}>
                    <RefreshCw size={15} /> {t("updateReload")}
                  </button>
                )}
                {phase === "failed" && (
                  <div style={{ marginTop: "12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("updateFailedHint")}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
