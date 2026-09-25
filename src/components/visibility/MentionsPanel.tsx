"use client";

// Brand mentions panel (T6): Google News + Wikipedia/Wikidata feed for the site, on the
// «Видимость» hub's "Mentions" sub-tab. All sources are free and public; the daily watcher
// runs server-side (scheduler.ts), this panel is the lens over BrandMention rows plus the
// three per-row actions: check the link, review/dismiss, push to Outreach.
//
// The SEO point of the feature is the UNLINKED mention: an outlet that wrote about the brand
// and did not link is the cheapest link request there is — hence linkStatus is a first-class
// filter and the outreach button.

import { useCallback, useEffect, useState } from "react";
import {
  Check, ChevronDown, ChevronUp, ExternalLink, Eye, EyeOff, Link2,
  Loader2, Plus, RefreshCw, Search, Send, Settings2, X,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import type { MentionLinkStatus, MentionRow, MentionSettings, MentionSource } from "@/lib/mentions/types";

const GREEN = "#10B981";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const VIOLET = "#8B5CF6";

const SOURCES: MentionSource[] = ["news", "wikipedia", "wikidata"];
// "all" is rendered with the generic `all` key — §7.8 defines labels only for the real states.
const STATES = ["new", "reviewed", "dismissed"] as const;
type StateFilter = (typeof STATES)[number] | "all";
const LINK_STATUSES: MentionLinkStatus[] = ["unchecked", "linked", "unlinked", "unreachable"];

const LINK_COLOR: Record<MentionLinkStatus, string> = {
  linked: GREEN,
  unlinked: AMBER,
  unreachable: RED,
  unchecked: "var(--color-text-tertiary)",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "11px", fontWeight: 600, letterSpacing: "0.02em",
  color: "var(--color-text-secondary)", marginBottom: "5px",
};
const smallBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 10px", borderRadius: "7px",
  border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
  fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
};

type Feed = { total: number; rows: MentionRow[] };

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" }) : "—";

export default function MentionsPanel({
  siteDbId, domain, readOnly = false,
}: { siteDbId: string; domain: string; readOnly?: boolean }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};
  void domain; // kept from the stub's prop shape (the hub passes it); the feed speaks for itself

  const [settings, setSettings] = useState<MentionSettings | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [state, setState] = useState<StateFilter>("new");
  const [source, setSource] = useState<MentionSource | "all">("all");
  const [linkStatus, setLinkStatus] = useState<MentionLinkStatus | "all">("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<null | "run" | "save" | "toggle">(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null); // `${action}:${id}`
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Two extra keys T0/R must add to the locales (reported in the task report); until then t()
  // falls back to the key text itself, and the db-push instruction stays readable.
  const tKey = (key: string): string => (t as (k: string) => string)(key);

  const loadSettings = useCallback(async () => {
    const res = await fetch(`/api/mentions/settings?siteId=${encodeURIComponent(siteDbId)}`);
    const d = await res.json().catch(() => ({}));
    if (d?.notMigrated) { setNotMigrated(true); return; }
    if (d && typeof d === "object" && "on" in d) setSettings(d as MentionSettings);
  }, [siteDbId]);

  const loadFeed = useCallback(async () => {
    const params = new URLSearchParams({
      siteId: siteDbId, state, source, linkStatus, limit: "50",
      ...(q.trim() ? { q: q.trim() } : {}),
    });
    const res = await fetch(`/api/mentions?${params}`);
    const d = await res.json().catch(() => ({}));
    if (d?.notMigrated) { setNotMigrated(true); return; }
    setFeed(d && Array.isArray(d.rows) ? { total: d.total, rows: d.rows } : { total: 0, rows: [] });
  }, [siteDbId, state, source, linkStatus, q]);

  // Initial settings load, off the effect body (the lint rule is right that a synchronous
  // setState chain there re-renders; a zero timeout keeps the same behavior).
  useEffect(() => {
    const id = setTimeout(() => { void loadSettings(); }, 0);
    return () => clearTimeout(id);
  }, [loadSettings]);

  // Debounced feed reload on any filter change.
  useEffect(() => {
    const id = setTimeout(() => { void loadFeed(); }, q ? 300 : 0);
    return () => clearTimeout(id);
  }, [loadFeed, q]);

  const saveSettings = useCallback(async (next: MentionSettings, mark?: "toggle") => {
    setBusy(mark ?? "save");
    try {
      const res = await fetch(`/api/mentions/settings?siteId=${encodeURIComponent(siteDbId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, settings: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (d && typeof d === "object" && "on" in d) {
        setSettings(d as MentionSettings);
        setNotice(mark ? null : { ok: true, text: t("setSave") });
      } else if (d?.notMigrated) {
        setNotMigrated(true);
      } else {
        setNotice({ ok: false, text: t("mentionsEmpty") });
      }
    } finally {
      setBusy(null);
    }
  }, [siteDbId, t]);

  const runNow = useCallback(async () => {
    setBusy("run");
    setNotice(null);
    try {
      const res = await fetch("/api/mentions/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId }),
      });
      const d = await res.json().catch(() => ({}));
      if (d?.notMigrated) { setNotMigrated(true); return; }
      if (typeof d?.found === "number") {
        setNotice({
          ok: true,
          text: t("mentionsRunDone").replace("{n}", String(d.found)).replace("{m}", String(d.inserted)),
        });
        await loadFeed();
      } else {
        setNotice({ ok: false, text: String(d?.error ?? "run_failed") });
      }
    } finally {
      setBusy(null);
    }
  }, [siteDbId, loadFeed, t]);

  const rowAction = useCallback(async (id: string, action: "check" | "review" | "dismiss" | "outreach") => {
    setRowBusy(`${action}:${id}`);
    try {
      if (action === "check") {
        const res = await fetch(`/api/mentions/${id}/check-link`, { method: "POST" });
        const d = await res.json().catch(() => ({}));
        if (d?.notMigrated) { setNotMigrated(true); return; }
        if (d?.error === "mention_not_found") { await loadFeed(); return; }
        await loadFeed(); // the row's linkStatus/url came back updated
      } else if (action === "outreach") {
        const res = await fetch(`/api/mentions/${id}/outreach`, { method: "POST" });
        const d = await res.json().catch(() => ({}));
        if (d?.notMigrated) { setNotMigrated(true); return; }
        // check_link_first is the expected nudge for an unexpanded Google News redirect.
        setNotice(d?.prospectId
          ? { ok: true, text: t("mentionsToOutreach") }
          : { ok: false, text: d?.error === "check_link_first" ? t("mentionsCheckLink") : String(d?.error ?? "outreach_failed") });
        return;
      } else {
        const patch = action === "review" ? { reviewed: true } : { dismissed: true };
        await fetch(`/api/mentions/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
        });
        await loadFeed();
      }
    } finally {
      setRowBusy(null);
    }
  }, [loadFeed, t]);

  if (notMigrated) {
    return (
      <div className="card" style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
        {tKey("mentionsNotMigrated")}
      </div>
    );
  }

  const on = settings?.on ?? false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* ── Header: title, free badge, hint, on/off, run ── */}
      <div className="card">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "10px" }}>
          <div style={{ flex: "1 1 240px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("mentionsTitle")}</span>
              <span className="pill" style={{ fontSize: "11px" }}>{t("mentionsFree")}</span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "6px", lineHeight: 1.5 }}>
              {t("mentionsHint")}
            </div>
          </div>
          {!readOnly && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "13px", color: "var(--color-text-primary)" }}>
                <input
                  type="checkbox" checked={on} disabled={!settings || busy === "toggle"}
                  onChange={e => {
                    if (settings) void saveSettings({ ...settings, on: e.target.checked }, "toggle");
                  }}
                  style={{ cursor: "pointer", accentColor: VIOLET }}
                  aria-label={t("mentionsOn")}
                />
                {t("mentionsOn")}
              </label>
              <button
                className="pill active" onClick={() => void runNow()} disabled={busy === "run"}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", cursor: busy === "run" ? "wait" : "pointer", fontSize: "12px" }}
              >
                {busy === "run" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                {t("mentionsRunNow")}
              </button>
              <button
                className="pill" onClick={() => setSettingsOpen(v => !v)}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "12px" }}
                aria-expanded={settingsOpen}
              >
                <Settings2 size={13} />
                {t("menuSettings")}
                {settingsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            </div>
          )}
        </div>
        {notice && (
          <div style={{
            marginTop: "10px", fontSize: "12px", fontWeight: 600,
            color: notice.ok ? GREEN : RED,
          }}>{notice.text}</div>
        )}
      </div>

      {/* ── Settings (collapsible; never in the read-only share view) ── */}
      {!readOnly && settingsOpen && settings && (
        <SettingsEditor settings={settings} saving={busy === "save"} onSave={s => void saveSettings(s)} />
      )}

      {/* ── Feed ── */}
      <div className="card">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
          <select value={state} onChange={e => setState(e.target.value as StateFilter)} style={{ ...inputStyle, fontSize: "12px" }} aria-label={t("mentionsState_new")}>
            <option value="all">{t("all")}</option>
            {STATES.map(s => <option key={s} value={s}>{t(`mentionsState_${s}`)}</option>)}
          </select>
          <select value={source} onChange={e => setSource(e.target.value as MentionSource | "all")} style={{ ...inputStyle, fontSize: "12px" }} aria-label={t("mentionsSource_news")}>
            <option value="all">{t("all")}</option>
            {SOURCES.map(s => <option key={s} value={s}>{t(`mentionsSource_${s}`)}</option>)}
          </select>
          <select value={linkStatus} onChange={e => setLinkStatus(e.target.value as MentionLinkStatus | "all")} style={{ ...inputStyle, fontSize: "12px" }} aria-label={t("mentionsLink_unchecked")}>
            <option value="all">{t("all")}</option>
            {LINK_STATUSES.map(s => <option key={s} value={s}>{t(`mentionsLink_${s}`)}</option>)}
          </select>
          <div style={{ position: "relative", flex: "1 1 160px", minWidth: "140px" }}>
            <Search size={13} style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", color: "var(--color-text-tertiary)" }} />
            <input
              value={q} onChange={e => setQ(e.target.value)}
              placeholder={tKey("mentionsSearchPlaceholder")}
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box", paddingLeft: "28px", fontSize: "12px" }}
            />
          </div>
        </div>

        {feed === null ? (
          <div style={{ fontSize: "13px", color: "var(--color-text-tertiary)" }}>{t("loading")}</div>
        ) : feed.rows.length === 0 ? (
          <div style={{ fontSize: "13px", color: "var(--color-text-tertiary)" }}>{t("mentionsEmpty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {feed.rows.map(row => (
              <MentionRowView
                key={row.id} row={row} busy={rowBusy} readOnly={readOnly}
                blurStyle={blurStyle} onAction={rowAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── One mention row ──────────────────────────────────────────────────────────

function MentionRowView({ row, busy, readOnly, blurStyle, onAction }: {
  row: MentionRow;
  busy: string | null;
  readOnly: boolean;
  blurStyle: React.CSSProperties;
  onAction: (id: string, action: "check" | "review" | "dismiss" | "outreach") => Promise<void>;
}) {
  const { t } = useLanguage();
  const isBusy = (a: string) => busy === `${a}:${row.id}`;
  const date = fmtDate(row.publishedAt ?? row.firstSeenAt);

  return (
    <div style={{
      padding: "12px 0",
      borderTop: "1px solid var(--color-border)",
      display: "flex", flexDirection: "column", gap: "8px",
      opacity: row.dismissed ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", fontSize: "11px" }}>
        <span style={{ color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>{date}</span>
        <span className="pill" style={{ fontSize: "10.5px" }}>{t(`mentionsSource_${row.source}`)}</span>
        <span className="pill" style={{ fontSize: "10.5px" }}>{t(`mentionsKind_${row.kind}`)}</span>
        <span
          className="pill" style={{ fontSize: "10.5px", display: "inline-flex", alignItems: "center", gap: "5px" }}
          aria-label={t(`mentionsLink_${row.linkStatus}`)}
          title={t(`mentionsLink_${row.linkStatus}`)}
        >
          <span aria-hidden style={{ width: "7px", height: "7px", borderRadius: "50%", background: LINK_COLOR[row.linkStatus], flexShrink: 0 }} />
          {t(`mentionsLink_${row.linkStatus}`)}
        </span>
        {row.reviewed && (
          <span className="pill" style={{ fontSize: "10.5px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <Check size={10} aria-hidden /> {t("mentionsState_reviewed")}
          </span>
        )}
      </div>

      <div>
        <a
          href={row.url} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--color-text-primary)", textDecoration: "none", ...blurStyle }}
        >
          {row.title || row.url}
        </a>
        <ExternalLink size={11} style={{ marginLeft: "5px", color: "var(--color-text-tertiary)", verticalAlign: "baseline" }} aria-hidden />
        {row.publisher && (
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{row.publisher}</div>
        )}
        {row.snippet && (
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px", lineHeight: 1.5, ...blurStyle }}>
            {row.snippet}
          </div>
        )}
      </div>

      {!readOnly && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          <button className="pill" style={{ ...smallBtn, cursor: isBusy("check") ? "wait" : "pointer" }} disabled={isBusy("check")} onClick={() => void onAction(row.id, "check")}>
            {isBusy("check") ? <Loader2 size={12} className="spin" /> : <Link2 size={12} />}
            {t("mentionsCheckLink")}
          </button>
          <button className="pill" style={{ ...smallBtn, cursor: isBusy("review") ? "wait" : "pointer" }} disabled={isBusy("review")} onClick={() => void onAction(row.id, "review")}>
            <Eye size={12} />
            {t("mentionsReviewed")}
          </button>
          <button className="pill" style={{ ...smallBtn, cursor: isBusy("dismiss") ? "wait" : "pointer" }} disabled={isBusy("dismiss")} onClick={() => void onAction(row.id, "dismiss")}>
            <EyeOff size={12} />
            {t("mentionsDismiss")}
          </button>
          <button className="pill" style={{ ...smallBtn, cursor: isBusy("outreach") ? "wait" : "pointer" }} disabled={isBusy("outreach")} onClick={() => void onAction(row.id, "outreach")}>
            {isBusy("outreach") ? <Loader2 size={12} className="spin" /> : <Send size={12} />}
            {t("mentionsToOutreach")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Settings editor ──────────────────────────────────────────────────────────

function SettingsEditor({ settings, saving, onSave }: {
  settings: MentionSettings;
  saving: boolean;
  onSave: (s: MentionSettings) => void;
}) {
  const { t } = useLanguage();

  // Local draft; nothing hits the API until Save — a terms editor that saves on every
  // keystroke would write half-typed phrases into tomorrow's news queries.
  const [draft, setDraft] = useState<MentionSettings>(settings);
  const [error, setError] = useState("");

  const setTerm = (i: number, patch: Partial<{ term: string; mustInclude: string[] }>) => {
    setDraft(d => ({ ...d, terms: d.terms.map((t2, j) => (j === i ? { ...t2, ...patch } : t2)) }));
  };

  const save = () => {
    const terms = draft.terms.filter(t2 => t2.term.trim().length >= 2);
    if (draft.terms.length !== terms.length) {
      setError(t("mentionsTermHint"));
      return;
    }
    setError("");
    onSave({ ...draft, terms });
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div>
        <label style={labelStyle}>{t("mentionsTerms")}</label>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px", lineHeight: 1.5 }}>
          {t("mentionsTermHint")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {draft.terms.map((term, i) => (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "flex-start" }}>
              <input
                value={term.term}
                onChange={e => setTerm(i, { term: e.target.value })}
                style={{ ...inputStyle, flex: "1 1 180px", minWidth: "150px" }}
                aria-label={t("mentionsTerms")}
              />
              <div style={{ flex: "2 1 240px", minWidth: "200px" }}>
                <input
                  value={term.mustInclude.join(", ")}
                  onChange={e => setTerm(i, { mustInclude: e.target.value.split(",").map(w => w.trim()).filter(Boolean) })}
                  placeholder={t("mentionsMustInclude")}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                  aria-label={t("mentionsMustInclude")}
                />
                {term.mustInclude.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "5px" }}>
                    {term.mustInclude.map(w => (
                      <span key={w} className="pill" style={{ fontSize: "10.5px" }}>{w}</span>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="pill" aria-label={t("mentionsDismiss")}
                onClick={() => setDraft(d => ({ ...d, terms: d.terms.filter((_, j) => j !== i) }))}
                style={{ ...smallBtn, padding: "8px" }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            className="pill" onClick={() => setDraft(d => ({ ...d, terms: [...d.terms, { term: "", mustInclude: [] }] }))}
            style={{ ...smallBtn, alignSelf: "flex-start" }}
          >
            <Plus size={12} />
            {t("addManual")}
          </button>
        </div>
      </div>

      <div>
        <label style={labelStyle}>{t("mentionsExclude")}</label>
        <input
          value={draft.exclude.join(", ")}
          onChange={e => setDraft(d => ({ ...d, exclude: e.target.value.split(",").map(w => w.trim()).filter(Boolean) }))}
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
          aria-label={t("mentionsExclude")}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
        <div>
          <label style={labelStyle}>{t("mentionsSource_news")} / {t("mentionsSource_wikipedia")} / {t("mentionsSource_wikidata")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px", paddingTop: "4px" }}>
            {SOURCES.map(s => (
              <label key={s} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer", color: "var(--color-text-primary)" }}>
                <input
                  type="checkbox" checked={draft.sources.includes(s)}
                  onChange={e => setDraft(d => ({
                    ...d,
                    sources: e.target.checked
                      ? SOURCES.filter(x => d.sources.includes(x) || x === s)
                      : d.sources.filter(x => x !== s),
                  }))}
                  style={{ cursor: "pointer", accentColor: VIOLET }}
                />
                {t(`mentionsSource_${s}`)}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>{t("language")}</label>
          <select value={draft.lang} onChange={e => setDraft(d => ({ ...d, lang: e.target.value }))} style={{ ...inputStyle, width: "100%" }}>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("seoCountry")}</label>
          <select value={draft.country} onChange={e => setDraft(d => ({ ...d, country: e.target.value }))} style={{ ...inputStyle, width: "100%" }}>
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "13px", color: "var(--color-text-primary)" }}>
        <input
          type="checkbox" checked={draft.notify}
          onChange={e => setDraft(d => ({ ...d, notify: e.target.checked }))}
          style={{ cursor: "pointer", accentColor: VIOLET }}
        />
        {t("mentionsNotify")}
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button className="pill active" onClick={save} disabled={saving} style={{ cursor: saving ? "wait" : "pointer", fontSize: "12px", fontWeight: 600 }}>
          {saving ? <Loader2 size={12} className="spin" /> : <Check size={12} />}
          {t("setSave")}
        </button>
        {error && <span style={{ fontSize: "12px", color: RED }}>{error}</span>}
      </div>
    </div>
  );
}
