"use client";

// Local → Google Business Profile (N4, brief §6). The tab is a state machine first and a
// dashboard second, because the API's pre-approval quota-0 state is a STATE, not an error
// (CONTRACT.md §0.4): the card explains it and links the application form. Everything below
// "ok" (reviews, posts, photos) runs through the same classified-call routes, so a quota
// regression mid-session degrades to the same explanation, never to a stack trace.

import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock, ExternalLink, Image as ImageIcon, Loader2, MessageSquareReply,
  Plus, RefreshCw, Send, Trash2, Unlink,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { btnDanger, btnGhost, btnPrimary, btnDisabled, fieldLabel, inputStyle, statusPill, tdStyle, thStyle, sendJson } from "./shared";

type GbpState = "gbp_not_configured" | "gbp_no_token" | "gbp_auth_failed" | "gbp_access_required" | "gbp_error" | "ok";

interface Status {
  state: GbpState;
  connected: boolean;
  applyUrl: string;
  accounts?: { name: string; accountName: string }[];
  message?: string;
  redirectUri: string;
}

interface ReviewRow {
  id: string; author: string; rating: number; comment: string;
  createTime: string; replyText: string | null;
}

interface PostRow {
  id: string; summary: string; ctaType: string | null; scheduledAt: string;
  status: string; error: string | null;
}

interface PhotoRow { name: string; sourceUrl?: string }

const POST_STATUS_TONE: Record<string, "good" | "warn" | "bad" | "mute"> = {
  published: "good", scheduled: "mute", draft: "mute", failed: "bad",
};

export default function GbpCard({ siteId, hasProfile, selected }: {
  siteId: string;
  hasProfile: boolean;
  selected: { gbpAccount: string | null; gbpLocation: string | null };
}) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<Status | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/local/gbp/status");
      const data = await res.json();
      if (data.notMigrated) { setNotMigrated(true); return; }
      setStatus(data as Status);
    } catch { setStatus({ state: "gbp_error", connected: false, applyUrl: "", redirectUri: "", message: "network_error" }); }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => { setStatus(null); void loadStatus(); }, 0);
    return () => clearTimeout(id);
  }, [loadStatus]);

  if (notMigrated) {
    return <div className="panel" style={{ padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>⚠ {t("locNotMigrated" as never)}</div>;
  }
  if (!status) {
    return <div className="panel" style={{ padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>…</div>;
  }

  // ── the two states that block everything, each with its own honest explanation ──
  if (status.state === "gbp_not_configured") {
    return (
      <InfoPanel>
        {t("locGbpNotConfigured" as never)}
      </InfoPanel>
    );
  }
  if (status.state === "gbp_no_token") {
    return (
      <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary)" }}>
          {t("locGbpConnectHint" as never)}
        </p>
        <a href="/api/local/gbp/connect" style={{ ...btnPrimary, textDecoration: "none" }}>
          {t("locGbpConnect")}
        </a>
        <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
          {t("locGbpRedirectHint" as never)}: <code>{status.redirectUri}</code>
        </span>
      </div>
    );
  }

  const blocked = status.state === "gbp_access_required" || status.state === "gbp_auth_failed" || status.state === "gbp_error";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {status.state === "gbp_access_required" && (
        // CONTRACT.md §0.4: quota 0 before approval — explanation + application link, never a 500.
        <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start", borderLeft: "3px solid var(--color-accent-blue)" }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-primary)", lineHeight: 1.55 }}>{t("locGbpAccessRequired")}</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a href={status.applyUrl} target="_blank" rel="noreferrer" style={{ ...btnPrimary, textDecoration: "none" }}>
              {t("locGbpApply")} <ExternalLink size={12} />
            </a>
            <a href="/api/local/gbp/connect" style={{ ...btnGhost, textDecoration: "none" }}>{t("locGbpConnect")}</a>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>
            {t("locGbpRedirectHint" as never)}: <code>{status.redirectUri}</code>
          </span>
        </div>
      )}
      {status.state === "gbp_auth_failed" && (
        <InfoPanel tone="warn">
          {t("locGbpAuthFailed" as never)}{" "}
          <a href="/api/local/gbp/connect" style={{ color: "var(--color-accent-blue)" }}>{t("locGbpConnect")}</a>
        </InfoPanel>
      )}
      {status.state === "gbp_error" && (
        <InfoPanel tone="bad">{status.message || status.state}</InfoPanel>
      )}

      {/* account + location pickers; the site's saved selection can outlive a reconnect */}
      {!blocked && hasProfile && (
        <GbpSelection
          siteId={siteId}
          accounts={status.accounts ?? []}
          selected={selected}
          onResaved={() => void loadStatus()}
        />
      )}

      {/* reviews / posts / photos — only meaningful once a location is selected */}
      {!blocked && (
        <>
          <ReviewsSection siteId={siteId} locationSelected={!!selected.gbpLocation} />
          <PostsSection siteId={siteId} />
          <PhotosSection siteId={siteId} locationSelected={!!selected.gbpLocation} />
        </>
      )}

      {status.connected && (
        <div>
          <button type="button" onClick={async () => { await sendJson("/api/local/gbp/disconnect", "POST"); void loadStatus(); }}
            style={{ ...btnDanger, fontSize: 12 }}>
            <Unlink size={13} /> {t("locGbpDisconnect" as never)}
          </button>
        </div>
      )}
    </div>
  );
}

function InfoPanel({ children, tone = "mute" }: { children: React.ReactNode; tone?: "mute" | "warn" | "bad" }) {
  const color = tone === "bad" ? "var(--color-danger)" : tone === "warn" ? "#F59E0B" : "var(--color-text-secondary)";
  return (
    <div className="panel" style={{ padding: 18, fontSize: 13, color, lineHeight: 1.55 }}>{children}</div>
  );
}

// ─── account / location selection ──────────────────────────────────────────────

function GbpSelection({ siteId, accounts, selected, onResaved }: {
  siteId: string;
  accounts: { name: string; accountName: string }[];
  selected: { gbpAccount: string | null; gbpLocation: string | null };
  onResaved: () => void;
}) {
  const { t } = useLanguage();
  const [account, setAccount] = useState(selected.gbpAccount ?? "");
  const [location, setLocation] = useState(selected.gbpLocation ?? "");
  const [locations, setLocations] = useState<{ name: string; title: string; address: string }[]>([]);
  const [loadingLocs, setLoadingLocs] = useState(false);
  const [locError, setLocError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setAccount(selected.gbpAccount ?? "");
      setLocation(selected.gbpLocation ?? "");
      setSaved(false);
    }, 0);
    return () => clearTimeout(id);
  }, [selected]);

  const loadLocations = useCallback(async (acc: string) => {
    setLoadingLocs(true); setLocError(""); setLocations([]);
    try {
      const res = await fetch(`/api/local/gbp/locations?account=${encodeURIComponent(acc)}`);
      const data = await res.json();
      if (data.error) setLocError(String(data.error));
      else setLocations(data.locations ?? []);
    } catch { setLocError("network_error"); }
    setLoadingLocs(false);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => { if (account) void loadLocations(account); else setLocations([]); }, 0);
    return () => clearTimeout(id);
  }, [account, loadLocations]);

  const save = async () => {
    const { ok } = await sendJson("/api/local/gbp/select", "PUT", {
      siteId, account: account || null, location: location || null,
    });
    if (ok) { setSaved(true); onResaved(); }
  };

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div>
          <span style={fieldLabel}>{t("locGbpAccount" as never)}</span>
          <select style={{ ...inputStyle, width: "100%" }} value={account} onChange={e => { setAccount(e.target.value); setLocation(""); }}>
            <option value="">—</option>
            {accounts.map(a => <option key={a.name} value={a.name}>{a.accountName || a.name}</option>)}
          </select>
        </div>
        <div>
          <span style={fieldLabel}>{t("locGbpLocation" as never)}</span>
          <select style={{ ...inputStyle, width: "100%" }} value={location} disabled={!account || loadingLocs}
            onChange={e => setLocation(e.target.value)}>
            <option value="">{loadingLocs ? "…" : "—"}</option>
            {locations.map(l => <option key={l.name} value={l.name}>{l.title}{l.address ? ` · ${l.address}` : ""}</option>)}
          </select>
          {locError && <span style={{ fontSize: 11.5, color: "var(--color-danger)" }}>{locError}</span>}
        </div>
      </div>
      <div>
        <button type="button" onClick={save} style={btnGhost}>{t("setSave")}</button>
        {saved && <span style={{ marginLeft: 10, fontSize: 12, color: "#10B981" }}>✓ {t("apiKeySaved")}</span>}
      </div>
    </div>
  );
}

// ─── reviews ───────────────────────────────────────────────────────────────────

function ReviewsSection({ siteId, locationSelected }: { siteId: string; locationSelected: boolean }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/local/gbp/reviews?siteId=${encodeURIComponent(siteId)}`);
      const data = await res.json();
      setRows(data.reviews ?? []);
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    const id = setTimeout(() => { setRows(null); setNotice(""); void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const sync = async () => {
    setBusy(true); setNotice("");
    const { ok, data } = await sendJson("/api/local/gbp/reviews/sync", "POST", { siteId });
    setBusy(false);
    setNotice(ok
      ? `${data.inserted ?? 0} + ${data.updated ?? 0}${data.notified ? ` · ${data.notified} ${t("locGbpNotified" as never)}` : ""}`
      : String(data.error ?? "error"));
    await load();
  };

  const sendReply = async (id: string) => {
    const comment = replyText.trim();
    if (!comment) return;
    setBusy(true);
    const { ok, data } = await sendJson("/api/local/gbp/reviews/reply", "POST", { siteId, reviewId: id, comment });
    setBusy(false);
    if (!ok) { setNotice(String(data.error ?? "error")); return; }
    setReplyFor(null); setReplyText("");
    await load();
  };

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{t("locGbpReviews")}</h3>
        <button type="button" onClick={sync} disabled={!locationSelected || busy}
          style={{ ...btnGhost, ...btnDisabled(!locationSelected || busy) }}
          title={locationSelected ? undefined : t("locGbpPickLocation" as never)}>
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {t("refresh")}
        </button>
        {notice && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{notice}</span>}
        <span className="metric-cost">free · Google API</span>
      </div>
      {rows && rows.length === 0 && (
        <span style={{ fontSize: 12.5, color: "var(--color-text-tertiary)" }}>{t("locGbpNoReviews" as never)}</span>
      )}
      {rows?.map(r => (
        <div key={r.id} style={{ borderTop: "1px solid var(--color-border-soft)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 12.5, color: "var(--color-text-primary)" }}>{r.author || "?"}</strong>
            <span style={statusPill(`${r.rating}★`, r.rating >= 4 ? "good" : r.rating >= 3 ? "warn" : "bad")}>{r.rating}★</span>
            <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{new Date(r.createTime).toLocaleDateString()}</span>
          </div>
          {r.comment && <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{r.comment}</p>}
          {r.replyText ? (
            <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-tertiary)", borderLeft: "2px solid var(--color-border)", paddingLeft: 8 }}>
              ↩ {r.replyText}
            </p>
          ) : replyFor === r.id ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <textarea style={{ ...inputStyle, flex: "1 1 240px", minHeight: 54 }} value={replyText}
                onChange={e => setReplyText(e.target.value)} placeholder={t("locGbpReply")} />
              <button type="button" onClick={() => sendReply(r.id)} disabled={!replyText.trim() || busy} style={btnPrimary}>
                <Send size={13} /> {t("locGbpReply")}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => { setReplyFor(r.id); setReplyText(""); }} style={{ ...btnGhost, padding: "4px 10px" }}>
              <MessageSquareReply size={12} /> {t("locGbpReply")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── posts ─────────────────────────────────────────────────────────────────────

function PostsSection({ siteId }: { siteId: string }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<PostRow[] | null>(null);
  const [summary, setSummary] = useState("");
  const [ctaType, setCtaType] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/local/gbp/posts?siteId=${encodeURIComponent(siteId)}`);
      const data = await res.json();
      setRows(data.posts ?? []);
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    const id = setTimeout(() => { setRows(null); void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const create = async (status: "draft" | "scheduled") => {
    if (!summary.trim()) return;
    setBusy(true);
    await sendJson("/api/local/gbp/posts", "POST", {
      siteId, summary, ctaType: ctaType || null, ctaUrl: ctaUrl || null, mediaUrl: mediaUrl || null,
      scheduledAt: when ? new Date(when).toISOString() : new Date().toISOString(),
      status,
    });
    setBusy(false);
    setSummary(""); setCtaType(""); setCtaUrl(""); setMediaUrl(""); setWhen("");
    await load();
  };

  const remove = async (id: string) => {
    await sendJson(`/api/local/gbp/posts?id=${encodeURIComponent(id)}`, "DELETE");
    await load();
  };

  const half = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 } as const;

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{t("locGbpPosts")}</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <textarea style={{ ...inputStyle, width: "100%", minHeight: 60 }} value={summary}
          placeholder={t("locGbpPostSummary" as never)} onChange={e => setSummary(e.target.value)} maxLength={1500} />
        <div style={half}>
          <select style={{ ...inputStyle, width: "100%" }} value={ctaType} onChange={e => setCtaType(e.target.value)}>
            <option value="">CTA —</option>
            {["BOOK", "ORDER", "LEARN_MORE", "CALL", "SIGN_UP"].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input style={{ ...inputStyle, width: "100%" }} value={ctaUrl} placeholder="https://cta-url…" onChange={e => setCtaUrl(e.target.value)} />
          <input style={{ ...inputStyle, width: "100%" }} value={mediaUrl} placeholder="https://image-url…" onChange={e => setMediaUrl(e.target.value)} />
          <input style={{ ...inputStyle, width: "100%" }} type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={() => create("draft")} disabled={!summary.trim() || busy} style={{ ...btnGhost, ...btnDisabled(!summary.trim() || busy) }}>
            <Plus size={13} /> {t("locGbpPost_draft")}
          </button>
          <button type="button" onClick={() => create("scheduled")} disabled={!summary.trim() || busy} style={{ ...btnPrimary, ...btnDisabled(!summary.trim() || busy) }}>
            {busy ? <Loader2 size={13} className="spin" /> : <CalendarClock size={13} />} {t("locGbpSchedule")}
          </button>
        </div>
      </div>

      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t("locGbpPosts")}</th>
                <th style={thStyle}>{t("locGbpWhen" as never)}</th>
                <th style={thStyle}>—</th>
                <th style={{ ...thStyle, textAlign: "right" }}>—</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id}>
                  <td style={{ ...tdStyle, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }} title={p.error ?? undefined}>
                    {p.summary}
                    {p.error && <span style={{ color: "var(--color-danger)", fontSize: 11 }}> · {p.error}</span>}
                  </td>
                  <td style={tdStyle}>{new Date(p.scheduledAt).toLocaleString()}</td>
                  <td style={tdStyle}>
                    <span style={statusPill(t(`locGbpPost_${p.status}` as never), POST_STATUS_TONE[p.status] ?? "mute")}>
                      {t(`locGbpPost_${p.status}` as never)}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <button type="button" onClick={() => remove(p.id)} style={{ ...btnDanger, padding: "4px 8px" }} title={t("remove")}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── photos ────────────────────────────────────────────────────────────────────

function PhotosSection({ siteId, locationSelected }: { siteId: string; locationSelected: boolean }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<PhotoRow[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/local/gbp/photos?siteId=${encodeURIComponent(siteId)}`);
      const data = await res.json();
      if (data.error && data.error !== "gbp_not_selected") setError(String(data.error));
      else setError("");
      setRows(data.photos ?? []);
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    const id = setTimeout(() => { setRows(null); void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const add = async () => {
    setBusy(true); setError("");
    const { ok, data } = await sendJson("/api/local/gbp/photos", "POST", { siteId, url });
    setBusy(false);
    if (!ok) { setError(String(data.error ?? "error")); return; }
    setUrl("");
    await load();
  };

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{t("locGbpPhotos")}</h3>
        <button type="button" onClick={load} disabled={!locationSelected} style={{ ...btnGhost, ...btnDisabled(!locationSelected) }}>
          <ImageIcon size={13} /> {t("refresh")}
        </button>
        <span className="metric-cost">free · Google API</span>
      </div>
      {error && <span style={{ fontSize: 12, color: "var(--color-danger)" }}>{error}</span>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, width: "min(360px, 100%)" }} value={url} placeholder="https://image-url…"
          onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void add(); }} />
        <button type="button" onClick={add} disabled={!/^https:\/\/\S+$/i.test(url.trim()) || busy}
          style={{ ...btnPrimary, ...btnDisabled(!url.trim() || busy) }}>
          {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {t("locGbpAddPhoto" as never)}
        </button>
      </div>
      {rows && rows.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--color-text-secondary)" }}>
          {rows.map(p => (
            <li key={p.name} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.sourceUrl ? <a href={p.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>{p.sourceUrl}</a> : p.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
