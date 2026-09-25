"use client";

// /local (N4, docs/tasks/wave-nov/N4-local-seo.md) — Local SEO for one site at a time: the
// business card every other tab reads, the NAP check of the site's own pages, directory
// listings, the LocalBusiness schema generator and Google Business Profile. A site selector on
// top (like the other shared pages); the choice is remembered per browser.

import { useCallback, useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { LocalProfileData } from "@/lib/local/types";
import ProfileCard from "@/components/local/ProfileCard";
import NapCard from "@/components/local/NapCard";
import CitationsCard from "@/components/local/CitationsCard";
import SchemaCard from "@/components/local/SchemaCard";
import GbpCard from "@/components/local/GbpCard";
import { fieldLabel, inputStyle } from "@/components/local/shared";

type Tab = "profile" | "nap" | "citations" | "schema" | "gbp";

const TABS: { id: Tab; key: string }[] = [
  { id: "profile", key: "locTabProfile" },
  { id: "nap", key: "locTabNap" },
  { id: "citations", key: "locTabCitations" },
  { id: "schema", key: "locTabSchema" },
  { id: "gbp", key: "locTabGbp" },
];

const SITE_STORE_KEY = "localSiteId";

export default function LocalPage() {
  const { t } = useLanguage();
  const [sites, setSites] = useState<{ id: string; url: string; hasProfile: boolean }[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [profile, setProfile] = useState<LocalProfileData | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [tab, setTab] = useState<Tab>("profile");
  const [gbpBanner, setGbpBanner] = useState("");

  // Site list for the selector — the serp-monitor load shape: every setState lives inside the
  // async callback, never synchronously in the effect body.
  const loadSites = useCallback(async () => {
    try {
      const d = await fetch("/api/local/profile").then(r => r.json());
      if (d.notMigrated) { setNotMigrated(true); return; }
      const list = (d.sites ?? []) as { id: string; url: string; hasProfile: boolean }[];
      setSites(list);
      const saved = localStorage.getItem(SITE_STORE_KEY);
      if (saved && list.some(s => s.id === saved)) setSiteId(saved);
      else if (list.length === 1) setSiteId(list[0].id);
    } catch { setSites([]); }
  }, []);

  // Initial load defers one tick: the set-state-in-effect rule this repo lints with flags a
  // fetch-then-setState helper called straight from the effect body (IndexAutoPanel pattern).
  useEffect(() => {
    const id = setTimeout(() => { void loadSites(); }, 0);
    return () => clearTimeout(id);
  }, [loadSites]);

  // The OAuth callback returns here with a one-word verdict (?gbp=connected|denied|failed|…).
  // window.location is client-only, so the read happens after mount, inside a microtask.
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("gbp");
    if (!v) return;
    void (async () => {
      await Promise.resolve();
      setGbpBanner(t(`locGbpBanner_${v}` as never));
      setTab("gbp");
      window.history.replaceState(null, "", "/local");
    })();
  }, [t]);

  // The selected site's profile (the whole page keys off it).
  const loadProfile = useCallback(async (id: string) => {
    setProfile(null);
    const d = await fetch(`/api/local/profile?siteId=${encodeURIComponent(id)}`).then(r => r.json()).catch(() => ({}));
    setProfile(d.profile ? (d.profile as LocalProfileData) : null);
  }, []);

  useEffect(() => {
    if (!siteId) return;
    localStorage.setItem(SITE_STORE_KEY, siteId);
    const id = setTimeout(() => { void loadProfile(siteId); }, 0);
    return () => clearTimeout(id);
  }, [siteId, loadProfile]);

  const siteLabel = (url: string) => url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/+$/, "");
  const hasProfile = !!profile;

  if (notMigrated) {
    return (
      <div className="main-content">
        <h1>{t("locTitle")}</h1>
        <div className="panel" style={{ padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>
          ⚠ {t("locNotMigrated" as never)}
        </div>
      </div>
    );
  }

  return (
    <div className="main-content">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{t("locTitle")}</h1>
      </div>

      {/* Site selector — the shared-page convention: all sites, hidden included. */}
      <div style={{ marginTop: 16, maxWidth: 420 }}>
        <span style={fieldLabel}><Building2 size={11} style={{ verticalAlign: "-1px" }} /> {t("selectSite")}</span>
        <select style={{ ...inputStyle, width: "100%" }} value={siteId} onChange={e => setSiteId(e.target.value)}>
          <option value="">—</option>
          {(sites ?? []).map(s => (
            <option key={s.id} value={s.id}>{siteLabel(s.url)}{s.hasProfile ? " ●" : ""}</option>
          ))}
        </select>
      </div>

      {gbpBanner && (
        <div className="panel" style={{ marginTop: 14, padding: "10px 14px", fontSize: 12.5, color: "var(--color-text-secondary)" }}>
          {gbpBanner}
        </div>
      )}

      {siteId && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            {TABS.map(({ id, key }) => (
              <button key={id} type="button" className={`pill${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
                {t(key as never)}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            {tab === "profile" && <ProfileCard siteId={siteId} profile={profile} onChanged={() => void loadProfile(siteId)} />}
            {tab === "nap" && <NapCard siteId={siteId} hasProfile={hasProfile} />}
            {tab === "citations" && <CitationsCard siteId={siteId} hasProfile={hasProfile} />}
            {tab === "schema" && <SchemaCard siteId={siteId} hasProfile={hasProfile} />}
            {tab === "gbp" && (
              <GbpCard siteId={siteId} hasProfile={hasProfile}
                selected={{ gbpAccount: profile?.gbpAccount ?? null, gbpLocation: profile?.gbpLocation ?? null }} />
            )}
          </div>
        </>
      )}

      {sites && sites.length === 0 && (
        <div className="panel" style={{ marginTop: 16, padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>
          {t("locNoSites" as never)}
        </div>
      )}
    </div>
  );
}
