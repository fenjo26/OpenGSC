"use client";

import { usePathname, useRouter } from "next/navigation";
import PasswordChangeGate from "@/components/PasswordChangeGate";
import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, Suspense } from "react";
import { Settings, LogOut, Sparkles, Globe, Newspaper, LayoutDashboard, TrendingUp, Anchor, BarChart2, Users, Compass, Radar } from "lucide-react";
import { usePrivacy } from "@/lib/PrivacyContext";
import { useTheme } from "@/lib/ThemeContext";
import { useLayout } from "@/lib/LayoutContext";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import UpdateBanner from "@/components/UpdateBanner";
import SchemaBanner from "@/components/SchemaBanner";

// ─── Popup menu helpers ───────────────────────────────────────────────────────
function MenuItem({ icon, label, onClick }: { icon: string; label: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="menu-item" style={{
      display: "flex", alignItems: "center", gap: "10px",
      padding: "9px 16px", fontSize: "13px", color: "var(--color-text-secondary)",
      width: "100%", background: "transparent", border: "none", cursor: "pointer",
    }}>
      <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{icon}</span>
      {label}
    </button>
  );
}

// Small version/status footer for the user menu. Fetches /api/system/version once and shows
// the current git commit + whether the server is up to date or a newer version exists on the
// repo. Confirms at a glance that update-detection is wired up (independent of pm2's version col).
function VersionInfo() {
  const { t } = useLanguage();
  const [info, setInfo] = useState<null | { isGit?: boolean; updateAvailable?: boolean; local?: string; behind?: number; version?: string }>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/system/version")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) { setInfo(d); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const commit = info?.local ? String(info.local).slice(0, 7) : "";
  const version = info?.version ? `v${info.version}` : "";
  let status = t("versionChecking");
  let color = "var(--color-text-secondary)";
  if (loaded) {
    if (info?.isGit === false) { status = t("versionDocker"); }
    else if (info?.updateAvailable) { status = `${t("versionUpdate")}${info.behind ? ` (${info.behind})` : ""}`; color = "var(--color-accent-blue)"; }
    else { status = t("versionLatest"); color = "var(--color-accent-green)"; }
  }
  return (
    <div style={{ padding: "8px 16px", fontSize: "11px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 600 }}>{t("versionCurrent")}</span>
      {version && <span style={{ color: "var(--color-text-primary)", fontWeight: 700 }}>{version}</span>}
      {commit && <code style={{ color: "var(--color-text-secondary)", opacity: 0.7 }}>{commit}</code>}
      <span style={{ flex: 1 }} />
      <span style={{ color, fontWeight: 600 }}>{status}</span>
    </div>
  );
}

function ToggleItem({ icon, label, defaultOn = false }: { icon: string; label: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button onClick={() => setOn(o => !o)} className="menu-item" style={{
      display: "flex", alignItems: "center", gap: "10px",
      padding: "9px 16px", fontSize: "13px", color: "var(--color-text-secondary)",
      width: "100%", background: "transparent", border: "none", cursor: "pointer",
    }}>
      <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{icon}</span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <span style={{ fontSize: "11px", fontWeight: 600, color: on ? "var(--color-accent-green)" : "var(--color-text-tertiary, var(--color-text-secondary))" }}>{on ? "ON" : "OFF"}</span>
    </button>
  );
}

function SelectItem({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <button className="menu-item" style={{
      display: "flex", alignItems: "center", gap: "10px",
      padding: "9px 16px", fontSize: "13px", color: "var(--color-text-secondary)",
      width: "100%", background: "transparent", border: "none", cursor: "pointer",
    }}>
      <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{icon}</span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)" }}>{value}</span>
    </button>
  );
}

// ─── Feedback / Help modal ────────────────────────────────────────────────────
const USDT_ADDRESS = "TN7v2NArTXd5J2eMuGFpXmgzAFsoZpWcZu";

function FeedbackModal({ mode, onClose }: { mode: "feedback" | "thanks"; onClose: () => void }) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleSend = () => {
    const msg = encodeURIComponent(`[Feedback] ${text}`);
    window.open(`https://t.me/fenjo26?text=${msg}`, "_blank");
    setSent(true);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(USDT_ADDRESS).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
        }}
      />
      {/* Panel */}
      <div style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 101,
        width: "420px", maxWidth: "calc(100vw - 32px)",
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>
              {mode === "feedback" ? t("modalFeedbackTitle") : t("modalThanksTitle")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
              {mode === "feedback" ? t("modalFeedbackSubtitle") : t("modalThanksSubtitle")}
            </div>
          </div>
          <button onClick={onClose} style={{
            width: "28px", height: "28px", borderRadius: "50%",
            background: "rgba(255,255,255,0.06)", border: "none",
            cursor: "pointer", fontSize: "14px", color: "var(--color-text-secondary)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px 24px" }}>

          {/* ── FEEDBACK MODE ── */}
          {mode === "feedback" && (
            sent ? (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <div style={{ fontSize: "32px", marginBottom: "10px" }}>🎉</div>
                <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                  {t("telegramOpened")}
                </div>
                <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "6px" }}>
                  {t("telegramPreFilled")}
                </div>
                <button onClick={onClose} style={{
                  marginTop: "20px", padding: "9px 24px",
                  background: "var(--color-accent-purple)", color: "#fff",
                  border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: 600,
                  cursor: "pointer",
                }}>{t("close")}</button>
              </div>
            ) : (
              <>
                <a
                  href="https://t.me/fenjo26"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "12px 14px", borderRadius: "10px",
                    background: "rgba(37,166,217,0.08)",
                    border: "1px solid rgba(37,166,217,0.2)",
                    textDecoration: "none", marginBottom: "16px",
                    transition: "background 0.15s",
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = "rgba(37,166,217,0.14)")}
                  onMouseOut={e => (e.currentTarget.style.background = "rgba(37,166,217,0.08)")}
                >
                  <span style={{ fontSize: "20px" }}>✈️</span>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "#29acd9" }}>@fenjo26</div>
                    <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("feedbackTelegramHint")}</div>
                  </div>
                  <span style={{ marginLeft: "auto", fontSize: "12px", color: "var(--color-text-secondary)" }}>↗</span>
                </a>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder={t("feedbackPlaceholder")}
                  rows={4}
                  style={{
                    width: "100%", resize: "none",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "10px", padding: "12px 14px",
                    fontSize: "13px", color: "var(--color-text-primary)",
                    fontFamily: "inherit", outline: "none", lineHeight: "1.5",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = "var(--color-accent-purple)")}
                  onBlur={e => (e.currentTarget.style.borderColor = "var(--color-border)")}
                />
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "6px", marginBottom: "16px" }}>
                  {t("feedbackHint")}
                </div>
                <div style={{ display: "flex", gap: "10px" }}>
                  <button onClick={onClose} style={{
                    flex: 1, padding: "9px",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px", fontSize: "13px",
                    color: "var(--color-text-secondary)", cursor: "pointer",
                  }}>{t("cancel")}</button>
                  <button
                    onClick={handleSend}
                    disabled={!text.trim()}
                    style={{
                      flex: 2, padding: "9px",
                      background: text.trim() ? "var(--color-accent-purple)" : "rgba(139,92,246,0.3)",
                      border: "none", borderRadius: "8px",
                      fontSize: "13px", fontWeight: 600, color: "#fff",
                      cursor: text.trim() ? "pointer" : "not-allowed",
                      transition: "background 0.15s",
                    }}
                  >{t("sendFeedback")}</button>
                </div>
              </>
            )
          )}

          {/* ── THANKS / DONATE MODE ── */}
          {mode === "thanks" && (
            <>
              {/* Story */}
              <div style={{
                padding: "14px 16px", borderRadius: "10px",
                background: "rgba(139,92,246,0.07)",
                border: "1px solid rgba(139,92,246,0.18)",
                marginBottom: "20px",
              }}>
                <div style={{ fontSize: "22px", marginBottom: "8px" }}>👋</div>
                <div style={{ fontSize: "13px", color: "var(--color-text-primary)", lineHeight: "1.6", fontWeight: 500 }}>
                  {t("devStory")}
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: "1.6", marginTop: "6px" }}>
                  {t("devStoryDetail")}
                </div>
              </div>

              {/* USDT block */}
              <div style={{ marginBottom: "8px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>
                  USDT · TRC-20 (Tron network)
                </div>
                <div style={{
                  display: "flex", alignItems: "center", gap: "8px",
                  padding: "11px 14px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "10px",
                }}>
                  <span style={{ fontSize: "18px" }}>💚</span>
                  <code style={{
                    flex: 1, fontSize: "11.5px",
                    color: "var(--color-text-primary)",
                    fontFamily: "monospace", wordBreak: "break-all",
                    lineHeight: "1.4",
                  }}>
                    {USDT_ADDRESS}
                  </code>
                  <button
                    onClick={handleCopy}
                    style={{
                      flexShrink: 0,
                      padding: "5px 12px",
                      borderRadius: "6px",
                      background: copied ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.07)",
                      border: `1px solid ${copied ? "rgba(16,185,129,0.4)" : "var(--color-border)"}`,
                      fontSize: "11px", fontWeight: 600,
                      color: copied ? "#10B981" : "var(--color-text-secondary)",
                      cursor: "pointer", transition: "all 0.2s",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "6px" }}>
                  {t("usdtNote")}
                </div>
              </div>

              <div style={{ height: "1px", background: "var(--color-border)", margin: "16px 0" }} />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                  {t("thankYou")}
                </div>
                <button onClick={onClose} style={{
                  padding: "7px 20px",
                  background: "var(--color-accent-purple)", color: "#fff",
                  border: "none", borderRadius: "8px",
                  fontSize: "13px", fontWeight: 600, cursor: "pointer",
                }}>{t("close")}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Chrome Extension modal ───────────────────────────────────────────────────
function ChromeExtensionModal({ onClose }: { onClose: () => void }) {
  const features = [
    {
      icon: "⚡",
      title: "Instant Metric Retrieval",
      desc: "Fetch and display essential page metrics and website properties from virtually any URL — right in your browser.",
    },
    {
      icon: "📌",
      title: "Effortless Annotations",
      desc: "Add detailed annotations to any tracked property with a few clicks. Context is never lost.",
    },
    {
      icon: "🚀",
      title: "One-Click Dashboard",
      desc: "Jump instantly to your full OpenGSC dashboard for comprehensive data, reporting, and advanced analysis.",
    },
  ];

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 100,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
      }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 101,
        width: "460px", maxWidth: "calc(100vw - 32px)",
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        overflow: "hidden",
      }}>
        {/* Hero */}
        <div style={{
          padding: "28px 28px 24px",
          background: "linear-gradient(135deg, rgba(139,92,246,0.15) 0%, rgba(59,130,246,0.08) 100%)",
          borderBottom: "1px solid var(--color-border)",
          position: "relative",
        }}>
          <button onClick={onClose} style={{
            position: "absolute", top: "16px", right: "16px",
            width: "28px", height: "28px", borderRadius: "50%",
            background: "rgba(255,255,255,0.08)", border: "none",
            cursor: "pointer", fontSize: "14px", color: "var(--color-text-secondary)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>✕</button>

          {/* Chrome icon + badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "16px" }}>
            <div style={{
              width: "52px", height: "52px", borderRadius: "14px",
              background: "linear-gradient(135deg, #8B5CF6, #3B82F6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "26px", flexShrink: 0,
            }}>🔗</div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)" }}>
                  OpenGSC Extension
                </span>
                <span style={{
                  fontSize: "10px", fontWeight: 700,
                  padding: "2px 7px", borderRadius: "100px",
                  background: "rgba(139,92,246,0.2)", color: "#a78bfa",
                  textTransform: "uppercase", letterSpacing: "0.05em",
                }}>Chrome</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px" }}>
                Access your Search Console Analytics anywhere
              </div>
            </div>
          </div>

          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: 0 }}>
            Stop interrupting your workflow. The official OpenGSC Chrome Extension brings the power of our SEO analysis platform directly to your browser.
          </p>
        </div>

        {/* Features */}
        <div style={{ padding: "20px 28px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "14px" }}>
            Key Features
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "24px" }}>
            {features.map(f => (
              <div key={f.title} style={{
                display: "flex", gap: "12px",
                padding: "12px 14px", borderRadius: "10px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid var(--color-border)",
              }}>
                <span style={{ fontSize: "18px", flexShrink: 0, marginTop: "1px" }}>{f.icon}</span>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "3px" }}>
                    {f.title}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: "1.5" }}>
                    {f.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={onClose} style={{
              flex: 1, padding: "10px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid var(--color-border)",
              borderRadius: "9px", fontSize: "13px",
              color: "var(--color-text-secondary)", cursor: "pointer",
            }}>Close</button>
            <button
              onClick={() => window.open("https://chromewebstore.google.com/search/SEO%20Gets", "_blank")}
              style={{
                flex: 2, padding: "10px",
                background: "linear-gradient(135deg, #8B5CF6, #3B82F6)",
                border: "none", borderRadius: "9px",
                fontSize: "13px", fontWeight: 700, color: "#fff",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="2"/>
                <circle cx="12" cy="12" r="4" fill="white"/>
                <path d="M12 8 L20.5 8" stroke="white" strokeWidth="2"/>
                <path d="M6.8 17 L2.3 9" stroke="white" strokeWidth="2"/>
                <path d="M17.2 17 L21.7 9" stroke="white" strokeWidth="2"/>
              </svg>
              Install from Chrome Web Store
            </button>
          </div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textAlign: "center", marginTop: "10px" }}>
            Designed for SEO professionals, marketers, and analysts
          </div>
        </div>
      </div>
    </>
  );
}

// ─── NavLinks component for top navigation ────────────────────────────────────
function NavLinks() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLanguage();

  const items = [
    { href: "/", label: t("menuDashboard"), key: "sites", exact: true, icon: <LayoutDashboard size={14} /> },
    { href: "/striking", label: t("menuStriking"), key: "striking", icon: <TrendingUp size={14} /> },
    { href: "/cannibalization", label: t("menuCannibalization"), key: "cannibalization", icon: <Anchor size={14} /> },
    { href: "/decay", label: t("menuDecay"), key: "decay", icon: <BarChart2 size={14} /> },
    // Competitors and Demand are not here: both live under SEO Tools. Everything in this bar
    // reads data the instance already holds; those two buy data from outside it, which is the
    // line SEO Tools draws.
    { href: "/seo-tools", label: t("seoNavTitle"), key: "seo-tools", icon: <Sparkles size={14} /> },
    { href: "/indexer", label: t("indexerNavTitle"), key: "indexer", icon: <Globe size={14} /> },
    // Sits next to the portfolio tools but points outward: everything above reads this instance's
    // own data, this one looks at somebody else's site.
    { href: "/crawler", label: t("crawlerNavTitle"), key: "crawler", icon: <Radar size={14} /> },
    { href: "/digest", label: t("digestNavTitle"), key: "digest", icon: <Newspaper size={14} /> },
  ];

  return (
    <nav style={{ display: "flex", alignItems: "center", gap: "4px", marginLeft: "20px", flex: 1 }}>
      {items.map(item => {
        const isActive = item.exact
          ? pathname === "/"
          : pathname?.startsWith(item.href);

        const activeColor = item.key === "seo-tools" 
          ? "var(--color-accent-purple)" 
          : item.key === "indexer" 
            ? "var(--color-accent-blue)" 
            : item.key === "digest" 
              ? "var(--color-accent-green, #34c759)" 
              : "var(--color-accent-blue)";

        const bgActive = item.key === "seo-tools" 
          ? "rgba(191,90,242,0.12)" 
          : item.key === "indexer" 
            ? "rgba(41,151,255,0.12)" 
            : item.key === "digest" 
              ? "rgba(52,199,89,0.12)" 
              : "rgba(59,130,246,0.12)";

        return (
          <button
            key={item.href}
            onClick={() => router.push(item.href)}
            style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "6px 14px", borderRadius: "8px",
              fontSize: "13px", fontWeight: isActive ? 700 : 500,
              cursor: "pointer", border: "none",
              color: isActive ? activeColor : "var(--color-text-secondary)",
              background: isActive ? bgActive : "transparent",
              transition: "all 0.15s",
            }}
            onMouseOver={e => { if (!isActive) e.currentTarget.style.background = "var(--color-card-hover)"; }}
            onMouseOut={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────
function TopBar() {
  const router = useRouter();
  const { data: session } = useSession();
  const { blur, setBlur } = usePrivacy();
  const { dark, setDark } = useTheme();
  const { layout, setLayout } = useLayout();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<"feedback" | "thanks" | null>(null);
  const user = session?.user;

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 40,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 24px",
      height: "48px",
      background: "var(--color-bg)",
      borderBottom: "1px solid var(--color-border)",
    }}>
      {/* Logo */}
      <button onClick={() => router.push("/")} style={{
        display: "flex", alignItems: "center", gap: "8px", cursor: "pointer",
        background: "none", border: "none",
      }}>
        {/*
          Circle container with Apple blue ring — works on both dark and light navbars.
          White fill inside ensures the bar-chart icon (SVG default black) is always visible,
          even when <img> can't inherit currentColor.
        */}
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          border: "1.5px solid var(--color-accent-blue)",
          background: "#ffffff",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGSC" height={18} style={{ display: "block" }} />
        </div>
      </button>

      {/* Primary nav tabs */}
      <Suspense fallback={<div style={{ flex: 1 }} />}>
        <NavLinks />
      </Suspense>

      {/* Avatar */}
      {user && (
        <div style={{ position: "relative" }}>
          <button onClick={() => setOpen(o => !o)} style={{
            width: "32px", height: "32px", borderRadius: "50%",
            overflow: "hidden", border: "2px solid transparent",
            cursor: "pointer", background: "none", padding: 0,
            transition: "border-color 0.15s",
          }}
            onMouseOver={e => e.currentTarget.style.borderColor = "var(--color-accent-purple)"}
            onMouseOut={e => { if (!open) e.currentTarget.style.borderColor = "transparent"; }}
          >
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.image} alt="avatar" width={32} height={32} style={{ display: "block" }} />
            ) : (
              <div style={{
                width: "100%", height: "100%",
                background: "var(--color-accent-purple)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)",
              }}>
                {user.name?.[0]?.toUpperCase() ?? "?"}
              </div>
            )}
          </button>

          {open && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
              <div style={{
                position: "absolute", top: "calc(100% + 8px)", right: 0,
                width: "240px",
                background: "var(--color-card)", border: "1px solid var(--color-border)",
                borderRadius: "12px", overflow: "hidden",
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                zIndex: 50,
              }}>
                {/* User info */}
                <div style={{ padding: "14px 16px 12px", borderBottom: "1px solid var(--color-border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    {user.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.image} alt="avatar" width={36} height={36} style={{ borderRadius: "50%" }} />
                    ) : (
                      <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "var(--color-accent-purple)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, color: "#fff" }}>
                        {user.name?.[0]?.toUpperCase() ?? "?"}
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {user.name ?? "Account"}
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {user.email}
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ padding: "6px 0" }}>
                  <MenuItem icon="⚙️" label={t("navSettings")} onClick={() => { setOpen(false); router.push("/settings"); }} />
                </div>

                <div style={{ height: "1px", background: "var(--color-border)" }} />

                <div style={{ padding: "6px 0" }}>
                  {/* Privacy Blur — controlled via global context */}
                  <button
                    onClick={() => setBlur(!blur)}
                    className={blur ? "menu-item menu-item-active" : "menu-item"}
                    style={{
                      display: "flex", alignItems: "center", gap: "10px",
                      padding: "9px 16px", fontSize: "13px",
                      color: blur ? "var(--color-accent-green)" : "var(--color-text-secondary)",
                      width: "100%",
                      background: blur ? "rgba(var(--color-accent-green-rgb, 29,131,72), 0.08)" : "transparent",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>📷</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{t("privacyBlur")}</span>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: blur ? "var(--color-accent-green)" : "var(--color-text-secondary)" }}>
                      {blur ? "ON" : "OFF"}
                    </span>
                  </button>
                  {/* Dark Mode — controlled via ThemeContext */}
                  <button
                    onClick={() => setDark(!dark)}
                    className={dark ? "menu-item menu-item-active" : "menu-item"}
                    style={{
                      display: "flex", alignItems: "center", gap: "10px",
                      padding: "9px 16px", fontSize: "13px",
                      color: dark ? "var(--color-accent-green)" : "var(--color-text-secondary)",
                      width: "100%",
                      background: dark ? "rgba(var(--color-accent-green-rgb, 29,131,72), 0.08)" : "transparent",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>🌙</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{t("darkMode")}</span>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: dark ? "var(--color-accent-green)" : "var(--color-text-secondary)" }}>
                      {dark ? "ON" : "OFF"}
                    </span>
                  </button>
                  {/* Layout — controlled via LayoutContext */}
                  <button
                    onClick={() => setLayout(layout === "wide" ? "default" : "wide")}
                    className={layout === "default" ? "menu-item menu-item-active" : "menu-item"}
                    style={{
                      display: "flex", alignItems: "center", gap: "10px",
                      padding: "9px 16px", fontSize: "13px",
                      color: layout === "default" ? "var(--color-accent-green)" : "var(--color-text-secondary)",
                      width: "100%",
                      background: layout === "default" ? "rgba(var(--color-accent-green-rgb, 29,131,72), 0.08)" : "transparent",
                      border: "none", cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>⇥</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{t("layout")}</span>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: layout === "default" ? "var(--color-accent-green)" : "var(--color-text-secondary)" }}>
                      {layout === "wide" ? t("layoutWide") : t("layoutDefault")}
                    </span>
                  </button>
                </div>

                <div style={{ height: "1px", background: "var(--color-border)" }} />

                <div style={{ padding: "6px 0" }}>
                  <MenuItem icon="♡" label={t("giveFeedback")} onClick={() => { setOpen(false); setModal("feedback"); }} />
                  <MenuItem icon="🙏" label={t("supportDeveloper")} onClick={() => { setOpen(false); setModal("thanks"); }} />
                </div>

                <div style={{ height: "1px", background: "var(--color-border)" }} />

                <div style={{ padding: "6px 0" }}>
                  <button onClick={() => signOut({ callbackUrl: "/login" })} style={{
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "9px 16px", fontSize: "13px", color: "#f87171",
                    width: "100%", background: "transparent", border: "none", cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                    onMouseOver={e => e.currentTarget.style.background = "rgba(239,68,68,0.08)"}
                    onMouseOut={e => e.currentTarget.style.background = "transparent"}
                  >
                    <LogOut size={14} />
                    {t("signOut")}
                  </button>
                </div>

                <div style={{ height: "1px", background: "var(--color-border)" }} />
                <VersionInfo />
              </div>
            </>
          )}
        </div>
      )}

      {/* Feedback / Help modal */}
      {modal && <FeedbackModal mode={modal} onClose={() => setModal(null)} />}
    </header>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────
// Paths rendered without the app shell (no TopBar): auth pages and public share links.
const AUTH_PATHS = ["/login", "/share", "/join"];

function Shell({ children }: { children: React.ReactNode }) {
  // Shell no longer reads the layout context: page width is applied through CSS custom properties
  // set on :root by LayoutProvider, not by re-rendering here. TopBar still subscribes to show the
  // toggle's current state in the menu.
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <TopBar />
      <PasswordChangeGate />
      <UpdateBanner />
      <SchemaBanner />
      <main style={{
        flex: 1,
        overflow: "auto",
      }}>
        {/*
          No maxWidth/margin/padding here anymore. The Layout toggle now drives page width via CSS
          custom properties (--page-max-width / --page-padding) on :root, read by .main-content and
          the seo-tools/indexer layout wrappers. Centering pages here would have double-constrained
          those containers; letting them own their geometry means one toggle reaches every page.
        */}
        {children}
      </main>
    </div>
  );
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = AUTH_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));

  if (isAuthPage) return <>{children}</>;

  return <Shell>{children}</Shell>;
}
