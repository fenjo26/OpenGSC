"use client";

import { LayoutDashboard, Globe, Settings, TrendingUp, Anchor, BarChart2, LogOut, ChevronDown, Users, Compass } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState } from "react";

// ─── Popup menu helpers ───────────────────────────────────────────────────────
function MenuItem({ icon, label, onClick }: { icon: string; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: "10px",
        padding: "9px 16px", fontSize: "13px", color: "var(--color-text-secondary)",
        width: "100%", background: "transparent", border: "none", cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseOver={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#fff"; }}
      onMouseOut={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}
    >
      <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{icon}</span>
      {label}
    </button>
  );
}

function ToggleItem({ icon, label, defaultOn = false }: { icon: string; label: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      onClick={() => setOn(o => !o)}
      style={{
        display: "flex", alignItems: "center", gap: "10px",
        padding: "9px 16px", fontSize: "13px", color: "var(--color-text-secondary)",
        width: "100%", background: "transparent", border: "none", cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
      onMouseOut={e => e.currentTarget.style.background = "transparent"}
    >
      <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{icon}</span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <span style={{ fontSize: "11px", fontWeight: 600, color: on ? "#10B981" : "#6b7280" }}>
        {on ? "ON" : "OFF"}
      </span>
    </button>
  );
}

function SelectItem({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <button
      style={{
        display: "flex", alignItems: "center", gap: "10px",
        padding: "9px 16px", fontSize: "13px", color: "var(--color-text-secondary)",
        width: "100%", background: "transparent", border: "none", cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
      onMouseOut={e => e.currentTarget.style.background = "transparent"}
    >
      <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{icon}</span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <span style={{ fontSize: "11px", fontWeight: 600, color: "#6b7280" }}>{value}</span>
    </button>
  );
}

export default function Sidebar() {
  const { t } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const navItems = [
    { href: "/", icon: <Globe size={18} />, label: t("menuDashboard") },
    { href: "/striking", icon: <TrendingUp size={18} />, label: t("menuStriking") },
    { href: "/cannibalization", icon: <Anchor size={18} />, label: t("menuCannibalization") },
    { href: "/decay", icon: <BarChart2 size={18} />, label: t("menuDecay") },
    { href: "/competitors", icon: <Users size={18} />, label: t("menuCompetitors") },
    // Last in the list on purpose: everything above starts from queries you already have, this
    // one starts from the market and is the only entry that can return keywords you have never
    // been shown for.
    { href: "/demand", icon: <Compass size={18} />, label: t("menuDemand") },
  ];

  const user = session?.user;

  return (
    <aside className="sidebar">
      <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", height: "100%" }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "40px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "var(--color-accent-purple)" }} />
          <h1 style={{ fontSize: "18px", fontWeight: 600, letterSpacing: "-0.02em", color: "#fff" }}>
            OpenGSC
          </h1>
        </div>

        {/* Navigation */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1 }}>
          <div className="title-sm" style={{ marginBottom: "12px", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("menu")}
          </div>

          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                style={{
                  display: "flex", alignItems: "center", gap: "12px",
                  padding: "10px 12px", borderRadius: "8px",
                  backgroundColor: isActive ? "rgba(255,255,255,0.1)" : "transparent",
                  color: isActive ? "#fff" : "var(--color-text-secondary)",
                  transition: "all 0.15s",
                  width: "100%",
                }}
                onMouseOver={e => { if (!isActive) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)"; }}
                onMouseOut={e => { if (!isActive) e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                {item.icon}
                <span style={{ fontSize: "14px", fontWeight: isActive ? 600 : 400 }}>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Bottom: Settings + User profile */}
        <div style={{ paddingTop: "16px", borderTop: "1px solid var(--color-border)" }}>
          <button
            onClick={() => router.push("/settings")}
            style={{
              display: "flex", alignItems: "center", gap: "12px",
              padding: "10px 12px", borderRadius: "8px",
              backgroundColor: pathname === "/settings" ? "rgba(255,255,255,0.1)" : "transparent",
              color: pathname === "/settings" ? "#fff" : "var(--color-text-secondary)",
              width: "100%", transition: "all 0.15s", marginBottom: "8px",
            }}
            onMouseOver={e => { if (pathname !== "/settings") e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)"; }}
            onMouseOut={e => { if (pathname !== "/settings") e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <Settings size={18} />
            <span style={{ fontSize: "14px", fontWeight: pathname === "/settings" ? 600 : 400 }}>
              {t("menuSettings")}
            </span>
          </button>

          {/* User profile */}
          {user && (
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setUserMenuOpen(o => !o)}
                style={{
                  display: "flex", alignItems: "center", gap: "10px",
                  padding: "10px 12px", borderRadius: "8px", width: "100%",
                  background: userMenuOpen ? "rgba(255,255,255,0.07)" : "transparent",
                  transition: "background 0.15s", cursor: "pointer",
                }}
                onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.07)"}
                onMouseOut={e => { if (!userMenuOpen) e.currentTarget.style.background = "transparent"; }}
              >
                {/* Avatar */}
                {user.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.image}
                    alt="avatar"
                    width={28} height={28}
                    style={{ borderRadius: "50%", flexShrink: 0 }}
                  />
                ) : (
                  <div style={{
                    width: "28px", height: "28px", borderRadius: "50%", flexShrink: 0,
                    background: "var(--color-accent-purple)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "12px", fontWeight: 700, color: "#fff",
                  }}>
                    {user.name?.[0]?.toUpperCase() ?? user.email?.[0]?.toUpperCase() ?? "?"}
                  </div>
                )}

                {/* Name + email */}
                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {user.name ?? "Account"}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {user.email}
                  </div>
                </div>

                <ChevronDown size={13} style={{ color: "var(--color-text-secondary)", flexShrink: 0, transform: userMenuOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
              </button>

              {/* Popup menu */}
              {userMenuOpen && (
                <>
                  {/* Backdrop */}
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 49 }}
                    onClick={() => setUserMenuOpen(false)}
                  />
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 8px)", left: 0,
                    width: "240px",
                    background: "#1e1e1e", border: "1px solid var(--color-border)",
                    borderRadius: "12px", overflow: "hidden",
                    boxShadow: "0 -8px 32px rgba(0,0,0,0.6)",
                    zIndex: 50,
                  }}>
                    {/* User info header */}
                    <div style={{ padding: "14px 16px 12px", borderBottom: "1px solid var(--color-border)" }}>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "#fff", marginBottom: "2px" }}>
                        {user?.name ?? "Account"}
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                        {user?.email}
                      </div>
                    </div>

                    {/* Menu items */}
                    <div style={{ padding: "6px 0" }}>
                      <MenuItem icon="⚙️" label="Settings" onClick={() => { setUserMenuOpen(false); router.push("/settings"); }} />
                    </div>

                    <div style={{ height: "1px", background: "var(--color-border)" }} />

                    {/* Toggles */}
                    <div style={{ padding: "6px 0" }}>
                      <ToggleItem icon="📷" label="Privacy Blur" />
                      <ToggleItem icon="🌙" label="Dark Mode" defaultOn />
                      <SelectItem icon="⇥" label="Layout" value="Wide" />
                    </div>

                    <div style={{ height: "1px", background: "var(--color-border)" }} />

                    {/* Links */}
                    <div style={{ padding: "6px 0" }}>
                      <MenuItem icon="♡" label="Give Feedback" onClick={() => setUserMenuOpen(false)} />
                      <MenuItem icon="?" label="Need Help?" onClick={() => setUserMenuOpen(false)} />
                      <MenuItem icon="🔗" label="Chrome Extension" onClick={() => setUserMenuOpen(false)} />
                    </div>

                    <div style={{ height: "1px", background: "var(--color-border)" }} />

                    {/* Sign out */}
                    <div style={{ padding: "6px 0" }}>
                      <button
                        onClick={() => signOut({ callbackUrl: "/login" })}
                        style={{
                          display: "flex", alignItems: "center", gap: "10px",
                          padding: "9px 16px", fontSize: "13px", color: "#f87171",
                          width: "100%", background: "transparent", border: "none", cursor: "pointer",
                          transition: "background 0.15s",
                        }}
                        onMouseOver={e => e.currentTarget.style.background = "rgba(239,68,68,0.08)"}
                        onMouseOut={e => e.currentTarget.style.background = "transparent"}
                      >
                        <LogOut size={14} />
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
