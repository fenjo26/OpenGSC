"use client";

// N8 — the report constructor dialog (create + edit). The template picks the default
// section set; ticking a section off/on afterwards is free-form. The schedule row adapts:
// weekly shows weekdays, monthly shows 1–28 (the 29th–31st are deliberately not offered —
// February would silently skip them), "off" hides the day entirely.

import { useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  REPORT_SECTION_IDS, REPORT_TEMPLATE_IDS, REPORT_TEMPLATES as TPL,
  type ReportSectionId, type ReportTemplateId,
} from "@/lib/reports/sections";
import type { ReportRow } from "@/lib/reports/store";

export interface EditorDraft {
  siteId: string;
  title: string;
  template: ReportTemplateId;
  sections: ReportSectionId[];
  periodDays: number;
  schedule: "off" | "weekly" | "monthly";
  sendDay: number;
  recipients: string;
  notes: string;
}

const emptyDraft = (sites: { id: string; domain: string }[]): EditorDraft => ({
  siteId: sites[0]?.id ?? "",
  title: "",
  template: "executive",
  sections: [...TPL.executive],
  periodDays: 30,
  schedule: "off",
  sendDay: 1,
  recipients: "",
  notes: "",
});

const draftOf = (r: ReportRow): EditorDraft => ({
  siteId: r.siteId,
  title: r.title,
  template: (["executive", "detailed", "technical", "local"].includes(r.template) ? r.template : "executive") as ReportTemplateId,
  sections: [...r.sections],
  periodDays: r.periodDays,
  schedule: (["off", "weekly", "monthly"].includes(r.schedule) ? r.schedule : "off") as EditorDraft["schedule"],
  sendDay: r.sendDay || 1,
  recipients: r.recipients.join(", "),
  notes: r.notes,
});

const input: React.CSSProperties = {
  width: "100%", padding: "8px 11px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "var(--color-bg)",
  color: "var(--color-text-primary)", fontSize: 13, outline: "none", fontFamily: "inherit",
};
const label: React.CSSProperties = { fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4, display: "block", fontWeight: 600 };

const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function ReportEditor({
  sites, editing, onSave, onClose, saving, error,
}: {
  sites: { id: string; domain: string }[];
  editing: ReportRow | null;
  saving: boolean;
  error: string;
  onSave: (draft: EditorDraft) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  // Seeded once during the first render: the parent keys the dialog per open, so mount-time
  // IS the open moment — no prop-to-state sync loop while it is on screen.
  const [draft, setDraft] = useState<EditorDraft>(() => (editing ? draftOf(editing) : emptyDraft(sites)));

  const set = (patch: Partial<EditorDraft>) => setDraft(d => ({ ...d, ...patch }));

  const onTemplate = (tpl: ReportTemplateId) => {
    set({ template: tpl, sections: [...TPL[tpl]] });
  };

  const toggleSection = (id: ReportSectionId) => {
    setDraft(d => ({
      ...d,
      sections: d.sections.includes(id) ? d.sections.filter(s => s !== id) : [...d.sections, id],
    }));
  };

  const schedule = draft.schedule;

  return (
    <div
      role="dialog" aria-modal="true" aria-label={editing ? t("repEdit" as never) || "Edit report" : t("repNew")}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "28px 14px", overflowY: "auto" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 620, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)" }}>
            {editing ? (t("repEdit" as never) || "Edit report") : t("repNew")}
          </div>
          <button onClick={onClose} aria-label="close" className="btn" style={{ background: "transparent", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={label}>{t("repTitle")}</label>
            <input style={input} value={draft.title} onChange={e => set({ title: e.target.value })} placeholder={t("repTitle") || "Title"} maxLength={120} />
          </div>
          <div>
            <label style={label}>{t("repSite" as never) || "Site"}</label>
            <select style={input} value={draft.siteId} onChange={e => set({ siteId: e.target.value })}>
              {sites.length === 0 && <option value="">—</option>}
              {sites.map(s => <option key={s.id} value={s.id}>{s.domain}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>{t("repPeriod")}</label>
            <select style={input} value={draft.periodDays} onChange={e => set({ periodDays: Number(e.target.value) })}>
              <option value={7}>7</option>
              <option value={30}>30</option>
              <option value={90}>90</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={label}>{t("repSections")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {REPORT_TEMPLATE_IDS.map(tpl => (
              <button
                key={tpl} type="button" onClick={() => onTemplate(tpl)} aria-pressed={draft.template === tpl}
                style={{
                  padding: "5px 12px", borderRadius: 16, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  background: draft.template === tpl ? "rgba(59,130,246,0.15)" : "transparent",
                  color: draft.template === tpl ? "#3B82F6" : "var(--color-text-secondary)",
                  border: `1px solid ${draft.template === tpl ? "rgba(59,130,246,0.35)" : "var(--color-border)"}`,
                }}
              >
                {t(`repTemplate_${tpl}` as never) || tpl}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {REPORT_SECTION_IDS.map(id => {
              const active = draft.sections.includes(id);
              return (
                <button
                  key={id} type="button" onClick={() => toggleSection(id)} aria-pressed={active}
                  title={t(`repSection_${id}` as never) || id}
                  style={{
                    padding: "4px 10px", borderRadius: 14, fontSize: 11.5, cursor: "pointer",
                    background: active ? "rgba(22,163,74,0.14)" : "transparent",
                    color: active ? "#16a34a" : "var(--color-text-secondary)",
                    border: `1px solid ${active ? "rgba(22,163,74,0.4)" : "var(--color-border)"}`,
                  }}
                >
                  {active ? "✓ " : ""}{t(`repSection_${id}` as never) || id}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label}>{t("repSchedule")}</label>
            <select style={input} value={schedule} onChange={e => set({ schedule: e.target.value as EditorDraft["schedule"], sendDay: 1 })}>
              <option value="off">{t("repSchedule_off")}</option>
              <option value="weekly">{t("repSchedule_weekly")}</option>
              <option value="monthly">{t("repSchedule_monthly")}</option>
            </select>
          </div>
          <div>
            <label style={label}>{schedule === "weekly" ? (t("repSendDay" as never) || "Send day") : schedule === "monthly" ? (t("repSendDay" as never) || "Send day") : "—"}</label>
            {schedule === "weekly" ? (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {WEEKDAYS_SHORT.map((wd, i) => (
                  <button
                    key={wd} type="button" onClick={() => set({ sendDay: i + 1 })} aria-pressed={draft.sendDay === i + 1}
                    aria-label={wd}
                    style={{
                      width: 34, height: 30, borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer",
                      background: draft.sendDay === i + 1 ? "rgba(59,130,246,0.15)" : "transparent",
                      color: draft.sendDay === i + 1 ? "#3B82F6" : "var(--color-text-secondary)",
                      border: `1px solid ${draft.sendDay === i + 1 ? "rgba(59,130,246,0.35)" : "var(--color-border)"}`,
                    }}
                  >
                    {wd}
                  </button>
                ))}
              </div>
            ) : schedule === "monthly" ? (
              <select style={input} value={draft.sendDay} onChange={e => set({ sendDay: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div style={{ ...input, color: "var(--color-text-tertiary)", borderStyle: "dashed" }}>—</div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={label}>{t("repRecipients")}</label>
          <input style={input} value={draft.recipients} onChange={e => set({ recipients: e.target.value })} placeholder="client@example.com, boss@company.com" />
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={label}>{t("repWorkDone")}</label>
          <textarea
            style={{ ...input, minHeight: 110, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
            value={draft.notes} onChange={e => set({ notes: e.target.value })} maxLength={8000}
            placeholder={"## June\n- Published /guides/transfer-pricing\n- Fixed 12 broken links"}
          />
        </div>

        {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--color-accent-red, #dc2626)" }}>{error}</div>}

        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} className="btn" style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: 13, cursor: "pointer" }}>
            {t("cancel") || "Cancel"}
          </button>
          <button
            type="button" onClick={() => onSave(draft)} disabled={saving || !draft.title.trim() || !draft.siteId}
            className="btn" style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid transparent", background: "#2563eb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", opacity: saving || !draft.title.trim() || !draft.siteId ? 0.6 : 1 }}
          >
            {saving ? "…" : t("seoSave") || "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
