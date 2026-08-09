"use client";

import { useState, useEffect, useCallback } from "react";
import { Settings, Sparkles, Plus, X, Copy, Check, Trash2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import MetricsImport from "@/components/MetricsImport";
import { getTaskCreds } from "@/lib/seo/keys";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Cluster { id: string; name: string; rules: string; }
interface Group   { id: string; name: string; rules: string; }

// ─── Helpers ───────────────────────────────────────────────────────────────────
function parseRuleValues(rulesJson: string): string {
  try {
    const rules = JSON.parse(rulesJson) as { type: string; values: string[] }[];
    return rules.flatMap(r => r.values ?? []).join(', ');
  } catch { return rulesJson; }
}

function cuidFront(): string {
  return 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

// ─── AI status badge ───────────────────────────────────────────────────────────
function AiBadge({ status }: { status: 'idle' | 'loading' | 'ok' | 'nokey' | 'err' }) {
  if (status === 'idle') return null;
  const map = {
    loading: { color: '#8B5CF6', bg: 'rgba(139,92,246,0.1)', text: 'Generating…' },
    ok:      { color: '#10B981', bg: 'rgba(16,185,129,0.1)', text: 'Done!' },
    nokey:   { color: '#F59E0B', bg: 'rgba(245,158,11,0.1)',  text: 'No AI key — set one in Settings' },
    err:     { color: '#EF4444', bg: 'rgba(239,68,68,0.1)',   text: 'AI error — check your key' },
  }[status];
  return (
    <span style={{ padding: "3px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 600, color: map.color, background: map.bg }}>
      {map.text}
    </span>
  );
}

// ─── One-click AI button ───────────────────────────────────────────────────────
function OneClickBtn({ label, onClick, loading }: { label: string; onClick: () => void; loading: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: "flex", alignItems: "center", gap: "6px",
        padding: "8px 16px", borderRadius: "8px",
        border: "1px solid rgba(167,139,250,0.3)",
        background: loading ? "rgba(167,139,250,0.03)" : "rgba(167,139,250,0.05)",
        color: loading ? "var(--color-text-secondary)" : "var(--color-text-primary)",
        fontSize: "13px", fontWeight: 600, cursor: loading ? "default" : "pointer",
        boxShadow: loading ? "none" : "0 0 10px rgba(167,139,250,0.2)",
        transition: "all 0.15s",
      }}
    >
      <Sparkles size={14} color={loading ? "var(--color-text-secondary)" : "#A78BFA"} />
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Branded Keywords ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function BrandedSection({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  const key = `brandedKw_${siteDbId}`;
  const [kws, setKws]           = useState<string[]>([]);
  const [input, setInput]       = useState('');
  const [aiStatus, setAiStatus] = useState<'idle'|'loading'|'ok'|'nokey'|'err'>('idle');

  useEffect(() => {
    try { setKws(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch {}
  }, [key]);

  const persist = (next: string[]) => {
    setKws(next);
    localStorage.setItem(key, JSON.stringify(next));
  };

  const add = () => {
    const val = input.trim().toLowerCase();
    if (!val || kws.includes(val)) return;
    persist([...kws, val]);
    setInput('');
  };

  const remove = (kw: string) => persist(kws.filter(k => k !== kw));

  const oneClick = async () => {
    setAiStatus('loading');
    try {
      // `utility` task — a short mechanical pass, resolved the same way as everywhere else.
      const { provider, apiKey, model, baseUrl } = getTaskCreds('utility');

      if (!apiKey) {
        // No AI key: just add domain brand term
        const brand = domain.replace(/^sc-domain:/, '').replace(/^www\./, '').split('.')[0].toLowerCase();
        persist([...new Set([...kws, brand])]);
        setAiStatus('nokey');
        return;
      }

      const qs = new URLSearchParams({ siteId: siteDbId, aiProvider: provider, aiApiKey: apiKey });
      if (model) qs.set('aiModel', model);
      if (baseUrl) qs.set('aiBaseUrl', baseUrl);
      const res = await fetch(`/api/gsc/branded?${qs.toString()}`);
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      persist([...new Set([...kws, ...(data.branded ?? [])])]);
      setAiStatus('ok');
    } catch { setAiStatus('err'); }
  };

  return (
    <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ color: "#3B82F6" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9"/><path d="M9 9h1.5a1.5 1.5 0 0 1 0 3H9v3m3-6h1.5"/>
            </svg>
          </div>
          <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("setBrandedKw")}</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <AiBadge status={aiStatus} />
          <OneClickBtn label={t("setOneClickBranded")} onClick={oneClick} loading={aiStatus === 'loading'} />
        </div>
      </div>

      <p style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "8px" }}>
        {t("setBrandedDesc1").replace("{domain}", domain)}
      </p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "4px" }}>
        {t("setBrandedDesc2")}
      </p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "20px" }}>
        {t("setBrandedDesc3")}
      </p>

      {/* Chips */}
      {kws.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
          {kws.map(kw => (
            <div key={kw} style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "4px 10px", borderRadius: "20px",
              background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)",
            }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: "#3B82F6" }}>{kw}</span>
              <button onClick={() => remove(kw)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", color: "#3B82F6", opacity: 0.6 }}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add input */}
      <div style={{ display: "flex", gap: "12px" }}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          placeholder={t("setEnterKw")}
          style={{
            width: "300px", padding: "10px 14px", borderRadius: "8px",
            border: "1px solid var(--color-border)", background: "var(--color-bg)",
            color: "var(--color-text-primary)", fontSize: "14px", outline: "none",
          }}
        />
        <button
          onClick={add}
          style={{
            padding: "10px 24px", borderRadius: "8px", border: "1px solid var(--color-border)",
            background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "14px", fontWeight: 600, cursor: "pointer",
          }}
        >
          {t("setAdd")}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Topic Clusters ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function ClustersSection({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading]   = useState(true);
  const [aiStatus, setAiStatus] = useState<'idle'|'loading'|'ok'|'nokey'|'err'>('idle');
  const [adding, setAdding]     = useState(false);
  const [newName, setNewName]   = useState('');
  const [newKws, setNewKws]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/gsc/clusters?siteId=${siteDbId}`);
      const data = await res.json();
      setClusters(data.clusters ?? []);
    } finally { setLoading(false); }
  }, [siteDbId]);

  useEffect(() => { load(); }, [load]);

  const addCluster = async () => {
    const name = newName.trim();
    const values = newKws.split(',').map(s => s.trim()).filter(Boolean);
    if (!name || values.length === 0) return;

    const updated = [
      ...clusters,
      { id: cuidFront(), name, rules: JSON.stringify([{ type: 'contains', values }]) },
    ];
    await fetch('/api/gsc/clusters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteDbId, clusters: updated.map(c => ({ name: c.name, rules: c.rules })) }),
    });
    setNewName(''); setNewKws(''); setAdding(false);
    load();
  };

  const deleteCluster = async (id: string) => {
    await fetch(`/api/gsc/clusters?id=${id}`, { method: 'DELETE' });
    setClusters(prev => prev.filter(c => c.id !== id));
  };

  const oneClick = async () => {
    setAiStatus('loading');
    try {
      // `utility` task — a short mechanical pass, resolved the same way as everywhere else.
      const { provider, apiKey, model, baseUrl } = getTaskCreds('utility');

      if (!apiKey) { setAiStatus('nokey'); return; }

      const res = await fetch('/api/gsc/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: siteDbId, aiProvider: provider, aiApiKey: apiKey,
          aiModel: model || undefined, aiBaseUrl: baseUrl || undefined,
        }),
      });
      if (!res.ok) throw new Error('Setup error');
      const data = await res.json();

      if (data.clusters?.length) {
        await fetch('/api/gsc/clusters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: siteDbId, clusters: data.clusters.map((c: any) => ({ name: c.name, rules: c.rules })) }),
        });
        load();
        setAiStatus('ok');
      } else {
        setAiStatus('err');
      }
    } catch { setAiStatus('err'); }
  };

  return (
    <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ color: "#3B82F6" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
              <polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
          </div>
          <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("setTopicClusters")}</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <AiBadge status={aiStatus} />
          <OneClickBtn label={t("setOneClickTopic")} onClick={oneClick} loading={aiStatus === 'loading'} />
        </div>
      </div>

      <p style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("setTopicDesc1")}</p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "20px" }}>{t("setTopicDesc2")}</p>

      {/* List */}
      {loading ? (
        <div style={{ padding: "20px 0", textAlign: "center" }}>
          <div style={{ width: "24px", height: "24px", borderRadius: "50%", border: "2px solid var(--color-border)", borderTopColor: "#8B5CF6", animation: "spin 0.7s linear infinite", margin: "0 auto" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : clusters.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
          {clusters.map(c => (
            <div key={c.id} style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px",
              padding: "12px 14px", borderRadius: "8px",
              background: "var(--color-bg)", border: "1px solid var(--color-border)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{c.name}</div>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {parseRuleValues(c.rules)}
                </div>
              </div>
              <button onClick={() => deleteCluster(c.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "2px", flexShrink: 0, opacity: 0.6 }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "20px 0", fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>
          {t("setNoClusters")}
        </div>
      )}

      {/* Add form */}
      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "16px", background: "var(--color-bg)", borderRadius: "8px", border: "1px solid var(--color-border)", marginBottom: "12px" }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t("setClusterNamePlaceholder")}
            style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none" }}
          />
          <input
            value={newKws}
            onChange={e => setNewKws(e.target.value)}
            placeholder={t("setClusterKwPlaceholder")}
            style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none" }}
          />
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={addCluster} style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#8B5CF6", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>{t("setSave")}</button>
            <button onClick={() => { setAdding(false); setNewName(''); setNewKws(''); }} style={{ padding: "8px 16px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "13px", cursor: "pointer" }}>{t("setCancel")}</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "10px 16px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}
        >
          <Plus size={14} /> {t("setNewTopic")}
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Content Groups ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function GroupsSection({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [groups, setGroups]     = useState<Group[]>([]);
  const [loading, setLoading]   = useState(true);
  const [aiStatus, setAiStatus] = useState<'idle'|'loading'|'ok'|'nokey'|'err'>('idle');
  const [adding, setAdding]     = useState(false);
  const [newName, setNewName]   = useState('');
  const [newPattern, setNewPattern] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/gsc/groups?siteId=${siteDbId}`);
      const data = await res.json();
      setGroups(data.groups ?? []);
    } finally { setLoading(false); }
  }, [siteDbId]);

  useEffect(() => { load(); }, [load]);

  const addGroup = async () => {
    const name = newName.trim();
    const pattern = newPattern.trim();
    if (!name || !pattern) return;

    const isEquals = pattern === '/';
    const updated = [
      ...groups,
      { id: cuidFront(), name, rules: JSON.stringify([{ type: isEquals ? 'equals' : 'contains', values: [pattern] }]) },
    ];
    await fetch('/api/gsc/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteDbId, groups: updated.map(g => ({ name: g.name, rules: g.rules })) }),
    });
    setNewName(''); setNewPattern(''); setAdding(false);
    load();
  };

  const deleteGroup = async (id: string) => {
    await fetch(`/api/gsc/groups?id=${id}`, { method: 'DELETE' });
    setGroups(prev => prev.filter(g => g.id !== id));
  };

  const oneClick = async () => {
    setAiStatus('loading');
    try {
      // `utility` task — a short mechanical pass, resolved the same way as everywhere else.
      const { provider, apiKey, model, baseUrl } = getTaskCreds('utility');

      if (!apiKey) { setAiStatus('nokey'); return; }

      const res = await fetch('/api/gsc/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: siteDbId, aiProvider: provider, aiApiKey: apiKey,
          aiModel: model || undefined, aiBaseUrl: baseUrl || undefined,
        }),
      });
      if (!res.ok) throw new Error('Setup error');
      const data = await res.json();

      if (data.groups?.length) {
        await fetch('/api/gsc/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: siteDbId, groups: data.groups.map((g: any) => ({ name: g.name, rules: g.rules })) }),
        });
        load();
        setAiStatus('ok');
      } else {
        setAiStatus('err');
      }
    } catch { setAiStatus('err'); }
  };

  return (
    <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ color: "#3B82F6" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="8" y="8" width="8" height="8" rx="1"/>
              <rect x="3" y="3" width="5" height="5" rx="1"/>
              <rect x="16" y="3" width="5" height="5" rx="1"/>
              <rect x="3" y="16" width="5" height="5" rx="1"/>
              <rect x="16" y="16" width="5" height="5" rx="1"/>
            </svg>
          </div>
          <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("setContentGroupsTab")}</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <AiBadge status={aiStatus} />
          <OneClickBtn label={t("setOneClickContent")} onClick={oneClick} loading={aiStatus === 'loading'} />
        </div>
      </div>

      <p style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("setContentDesc1")}</p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "20px" }}>{t("setContentDesc2")}</p>

      {loading ? (
        <div style={{ padding: "20px 0", textAlign: "center" }}>
          <div style={{ width: "24px", height: "24px", borderRadius: "50%", border: "2px solid var(--color-border)", borderTopColor: "#8B5CF6", animation: "spin 0.7s linear infinite", margin: "0 auto" }} />
        </div>
      ) : groups.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
          {groups.map(g => (
            <div key={g.id} style={{
              display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px",
              padding: "12px 14px", borderRadius: "8px",
              background: "var(--color-bg)", border: "1px solid var(--color-border)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{g.name}</div>
                <div style={{ fontSize: "12px", color: "#A78BFA", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {parseRuleValues(g.rules)}
                </div>
              </div>
              <button onClick={() => deleteGroup(g.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "2px", flexShrink: 0, opacity: 0.6 }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "20px 0", fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>
          {t("setNoGroups")}
        </div>
      )}

      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "16px", background: "var(--color-bg)", borderRadius: "8px", border: "1px solid var(--color-border)", marginBottom: "12px" }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder={t("setGroupNamePlaceholder")}
            style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none" }}
          />
          <input
            value={newPattern}
            onChange={e => setNewPattern(e.target.value)}
            placeholder={t("setUrlPatternPlaceholder")}
            style={{ padding: "8px 12px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none" }}
          />
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={addGroup} style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#8B5CF6", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>{t("setSave")}</button>
            <button onClick={() => { setAdding(false); setNewName(''); setNewPattern(''); }} style={{ padding: "8px 16px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "13px", cursor: "pointer" }}>{t("setCancel")}</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "10px 16px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}
        >
          <Plus size={14} /> {t("setNewContent")}
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Shared Link ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
function SharedLinkSection({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  const [enabled, setEnabled] = useState(false);
  const [token, setToken]     = useState<string | null>(null);
  const [copied, setCopied]   = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!siteDbId) return;
    setLoading(true);
    fetch(`/api/gsc/site/share?siteId=${siteDbId}`)
      .then(r => r.json())
      .then(d => {
        setEnabled(!!d.shareEnabled);
        setToken(d.shareToken || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [siteDbId]);

  const updateShare = async (action: 'generate' | 'revoke' | 'toggle', val?: boolean) => {
    try {
      const res = await fetch('/api/gsc/site/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: siteDbId,
          action: action !== 'toggle' ? action : undefined,
          shareEnabled: action === 'toggle' ? val : undefined,
        }),
      });
      const d = await res.json();
      setEnabled(!!d.shareEnabled);
      setToken(d.shareToken || null);
    } catch {}
  };

  const shareUrl = token ? `${typeof window !== 'undefined' ? window.location.origin : ''}/share/${siteDbId}/${token}` : '';

  const copy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "24px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>
        {t("shareSettingsLoading") || "Loading share settings..."}
      </div>
    );
  }

  return (
    <div style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <div style={{ color: "#3B82F6" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
        </div>
        <h3 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("setSharedLink")}</h3>
      </div>

      <p style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "4px" }}>
        {t("setSharedLinkDesc1").replace("{domain}", domain)}
      </p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "20px" }}>
        {t("setSharedLinkDesc3")}
      </p>

      {token ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", cursor: "pointer" }}>
            <input type="checkbox" checked={enabled} onChange={e => updateShare('toggle', e.target.checked)} />
            {t("shareActiveCheckbox") || "Enable read-only guest access link"}
          </label>
          
          {enabled && (
            <div style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "10px 14px", borderRadius: "8px",
              background: "var(--color-bg)", border: "1px solid var(--color-border)",
            }}>
              <span style={{ flex: 1, fontSize: "12px", fontFamily: "monospace", color: "#3B82F6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {shareUrl}
              </span>
              <button onClick={copy} style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: copied ? "rgba(16,185,129,0.1)" : "transparent", color: copied ? "#10B981" : "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer", flexShrink: 0 }}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? t("setCopied") : t("setCopy")}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
            <button onClick={() => updateShare('generate')} style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {t("setRegenerateLink") || "Reset link"}
            </button>
            <button onClick={() => updateShare('revoke')} style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)", color: "#EF4444", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {t("setRevokeLink")}
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0 }}>{t("setSharedLinkNote")}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <button
            onClick={() => updateShare('generate')}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "10px 16px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "14px", fontWeight: 600, cursor: "pointer", width: "fit-content" }}
          >
            {t("setGenerateLink")}
          </button>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0 }}>{t("setSharedLinkNote")}</p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Main export ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
export default function SiteSettingsTab({ domain, siteDbId }: { domain: string; siteDbId: string }) {
  const { t } = useLanguage();

  return (
    <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: "24px", width: "100%", boxSizing: "border-box" }}>

      {/* Hero */}
      <div style={{
        background: "linear-gradient(to right, rgba(167,139,250,0.05), rgba(167,139,250,0.15))",
        borderRadius: "12px", border: "1px solid rgba(167,139,250,0.2)", padding: "28px 32px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
          <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: "rgba(59,130,246,0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "#3B82F6" }}>
            <Settings size={18} />
          </div>
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
            {t("setHelpTitle")}
          </h2>
        </div>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: "0 0 20px" }}>
          {t("setHelpDesc")}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px" }}>
          {[
            { color: "#10B981", bg: "rgba(16,185,129,0.1)", icon: <div style={{ width: "10px", height: "10px", borderRadius: "50%", border: "2px solid currentColor" }} />, title: t("setBrandMonitor"), desc: t("setBrandMonitorDesc") },
            { color: "#A78BFA", bg: "rgba(167,139,250,0.1)", icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>, title: t("setContentGroups"), desc: t("setContentGroupsDesc") },
            { color: "#F59E0B", bg: "rgba(245,158,11,0.1)", icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9"/><line x1="9" y1="21" x2="21" y2="3"/><line x1="21" y1="21" x2="3" y2="3"/></svg>, title: t("setClientPortal"), desc: t("setClientPortalDesc") },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", gap: "12px" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "6px", background: item.bg, color: item.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {item.icon}
              </div>
              <div>
                <h4 style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" }}>{item.title}</h4>
                <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: "1.5", margin: 0 }}>{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sections */}
      <BrandedSection siteDbId={siteDbId} domain={domain} />
      <ClustersSection siteDbId={siteDbId} />
      <GroupsSection siteDbId={siteDbId} />
      <SharedLinkSection siteDbId={siteDbId} domain={domain} />

      {/* The same import panel as Settings → SEO Metrics, with the target already known.
          Referring-domain exports belong to one site, and being on that site's page is the
          moment you have the file — sending people to a global screen to pick the site they
          just came from is the long way round. */}
      <MetricsImport siteId={siteDbId} />

    </div>
  );
}
