"use client";

// R+, Wave A — the operator-editable per-category domain lists the citation classifier consults
// as an overlay on its built-in defaults (plan §7.4). Lives on the AEO settings panel next to
// the sentiment toggle: same "classification context" family, same settings-card idiom. The
// lists are instance-wide, so the component fetches/saves its own /api/aeo/domain-lists
// endpoint instead of riding the per-site settings PUT around it.
//
// Editing is chips + Enter: an entry is validated client-side with the SAME normalizer the
// server sanitizes with (normalizeOverlayHost, exported from the import-free classifier), so
// what the operator sees accepted is exactly what a save keeps.

import { useEffect, useState } from "react";
import { Check, Globe, Plus, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  OVERLAY_CATEGORIES, normalizeOverlayHost,
  type ExtraDomainLists, type OverlayListCategory,
} from "@/lib/seo/aeoCitationClassify";
import { CATEGORY_COLOR, CATEGORY_LABEL_KEY } from "./citationCategoryUi";

const VIOLET = "#8B5CF6";
const GREEN = "#10B981";

const chipInputStyle: React.CSSProperties = {
  padding: "4px 8px", borderRadius: "7px", border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "11.5px",
  outline: "none", width: "100%", boxSizing: "border-box", fontFamily: "inherit",
};

function CategoryEditor({ category, hosts, onAdd, onRemove, invalid, onTyping }: {
  category: OverlayListCategory;
  hosts: string[];
  onAdd: (category: OverlayListCategory, raw: string) => void;
  onRemove: (category: OverlayListCategory, host: string) => void;
  invalid: boolean;
  onTyping: () => void;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState("");
  const color = CATEGORY_COLOR[category];

  const submit = () => {
    if (!draft.trim()) return;
    onAdd(category, draft);
    setDraft("");
  };

  return (
    <div>
      <label style={{
        fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--color-text-tertiary)", marginBottom: "4px", display: "block",
      }}>
        <span style={{ display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: color, marginRight: "5px" }} />
        {t(CATEGORY_LABEL_KEY[category])}
      </label>
      {hosts.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "5px" }}>
          {hosts.map(h => (
            <span key={h} style={{
              display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 4px 2px 8px",
              borderRadius: "999px", fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap",
              color, border: `1px solid ${color}44`, background: `${color}12`,
            }}>
              {h}
              <button onClick={() => onRemove(category, h)} title={h}
                style={{ display: "flex", border: "none", background: "transparent", padding: 0, cursor: "pointer", color, opacity: 0.7 }}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: "4px" }}>
        <input
          value={draft}
          onChange={e => { setDraft(e.target.value); onTyping(); }}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="example.gr"
          style={{ ...chipInputStyle, ...(invalid ? { borderColor: "#EF4444" } : {}) }}
        />
        <button onClick={submit} disabled={!draft.trim()} title="+"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: "28px",
            border: "1px solid var(--color-border)", borderRadius: "7px", background: "var(--color-bg)",
            color: "var(--color-text-secondary)", cursor: draft.trim() ? "pointer" : "not-allowed",
            opacity: draft.trim() ? 1 : 0.5,
          }}>
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

export default function DomainListsEditor() {
  const { t } = useLanguage();
  // null = still loading → render nothing rather than a form that flashes nine empty categories.
  const [lists, setLists] = useState<ExtraDomainLists | null>(null);
  const [invalidCat, setInvalidCat] = useState<OverlayListCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/aeo/domain-lists")
      .then(r => r.json())
      .then(d => { if (!cancelled && d && !d.error && !d.notMigrated) setLists(d.lists ?? {}); })
      .catch(() => { if (!cancelled) setLists({}); });
    return () => { cancelled = true; };
  }, []);

  const add = (category: OverlayListCategory, raw: string) => {
    const host = normalizeOverlayHost(raw); // the exact rule the save path applies
    if (!host) { setInvalidCat(category); return; }
    setInvalidCat(c => (c === category ? null : c));
    setLists(l => {
      if (!l) return l;
      const cur = l[category] ?? [];
      if (cur.includes(host)) return l;
      return { ...l, [category]: [...cur, host] };
    });
  };

  const remove = (category: OverlayListCategory, host: string) => {
    setLists(l => {
      if (!l) return l;
      const kept = (l[category] ?? []).filter(h => h !== host);
      const next = { ...l };
      if (kept.length) next[category] = kept;
      else delete next[category]; // an empty category is an absent category — same as the store
      return next;
    });
  };

  const save = async () => {
    if (!lists) return;
    setSaving(true); setSaved(false);
    try {
      const r = await fetch("/api/aeo/domain-lists", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lists }),
      });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        // Echo the SERVER-sanitized lists back into the form: what stuck, not what was typed.
        if (d?.lists) setLists(d.lists);
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
      }
    } finally { setSaving(false); }
  };

  if (lists === null) return null;

  return (
    <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <Globe size={13} color="var(--color-text-secondary)" />
        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aeoDomainLists")}</span>
        {saving && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>…</span>}
        {saved && <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", color: GREEN, fontWeight: 600 }}>
          <Check size={11} /> {t("aeoListsSaved")}
        </span>}
      </div>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "10px", lineHeight: 1.5 }}>
        {t("aeoDomainListsDesc")}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "10px" }}>
        {OVERLAY_CATEGORIES.map(cat => (
          <CategoryEditor
            key={cat}
            category={cat}
            hosts={lists[cat] ?? []}
            onAdd={add}
            onRemove={remove}
            invalid={invalidCat === cat}
            onTyping={() => setInvalidCat(c => (c === cat ? null : c))}
          />
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
        <button onClick={save} disabled={saving}
          style={{
            display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "8px",
            border: `1.5px solid rgba(139,92,246,0.5)`, background: "rgba(139,92,246,0.08)", color: VIOLET,
            fontSize: "12px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer",
          }}>
          {saving ? "…" : t("setSave")}
        </button>
      </div>
    </div>
  );
}
