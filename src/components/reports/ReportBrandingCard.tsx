"use client";

// N8 — Settings → ReportBrandingCard: the white-label identity of every client report.
// The logo is read locally into a data-URL (≤ 200 KiB checked client-side for a fast
// refusal, and again server-side because a client-side check is a courtesy, not a rule).

import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const LOGO_MAX_BYTES = 200 * 1024;

interface Branding {
  companyName: string;
  logoDataUrl: string;
  accentColor: string;
  footer: string;
  website: string;
  showPoweredBy: boolean;
}

const DEFAULTS: Branding = { companyName: "", logoDataUrl: "", accentColor: "#2563eb", footer: "", website: "", showPoweredBy: false };

const input: React.CSSProperties = {
  width: "100%", padding: "8px 11px", borderRadius: 8, border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 13, outline: "none", fontFamily: "inherit",
};
const label: React.CSSProperties = { fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4, display: "block", fontWeight: 600 };

export default function ReportBrandingCard() {
  const { t } = useLanguage();
  const [branding, setBranding] = useState<Branding>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [logoError, setLogoError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/reports/branding");
      if (!r.ok) return;
      const body = await r.json();
      if (body.branding) setBranding({ ...DEFAULTS, ...body.branding });
    } finally {
      setLoaded(true);
    }
  }, []);

  // State writes happen after the awaited fetch (load's first statement is the await
  // itself), so the effect cannot cascade renders.
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), 3500);
    return () => clearTimeout(timer);
  }, [note]);

  const set = (patch: Partial<Branding>) => setBranding(b => ({ ...b, ...patch }));

  const onLogoFile = (file: File | undefined) => {
    setLogoError("");
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError(t("repBrandLogoTooLarge" as never) || "Logo is over 200 KiB");
      return;
    }
    if (!/image\/(png|svg\+xml|jpe?g)/.test(file.type)) {
      setLogoError(t("repBrandLogoBadType" as never) || "PNG, SVG or JPEG only");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set({ logoDataUrl: String(reader.result ?? "") });
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    setNote("");
    try {
      const r = await fetch("/api/reports/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branding }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setNote(String(body.error ?? r.status)); return; }
      if (Array.isArray(body.issues) && body.issues.length) {
        setNote(body.issues.join(", "));
        return;
      }
      if (body.branding) setBranding({ ...DEFAULTS, ...body.branding });
      setNote(t("repBrandSaved" as never) || "Saved");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)" }}>{t("repBrandingTitle")}</div>
      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 4 }}>
        {t("repBrandHint" as never) || "Applied to every client report snapshot, e-mail and client page."}
      </div>

      {!loaded ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-secondary)", fontSize: 13, marginTop: 12 }}>
          <Loader2 size={14} className="rb-spin" />
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 14 }}>
            <div>
              <label style={label}>{t("repBrandCompany")}</label>
              <input style={input} value={branding.companyName} onChange={e => set({ companyName: e.target.value })} maxLength={120} />
            </div>
            <div>
              <label style={label}>{t("repBrandWebsite" as never) || "Website"}</label>
              <input style={input} value={branding.website} onChange={e => set({ website: e.target.value })} placeholder="https://agency.com" />
            </div>
            <div>
              <label style={label}>{t("repBrandColor")}</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="color" aria-label={t("repBrandColor")}
                  value={/^#[0-9a-fA-F]{6}$/.test(branding.accentColor) ? branding.accentColor : "#2563eb"}
                  onChange={e => set({ accentColor: e.target.value })}
                  style={{ width: 42, height: 34, padding: 2, borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg)", cursor: "pointer" }}
                />
                <input style={input} value={branding.accentColor} onChange={e => set({ accentColor: e.target.value })} maxLength={9} />
              </div>
            </div>
            <div>
              <label style={label}>{t("repBrandLogo")}</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button" className="btn" onClick={() => fileRef.current?.click()}
                  style={{ ...input, width: "auto", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                  aria-label={t("repBrandLogo")}
                >
                  <ImageIcon size={13} /> {branding.logoDataUrl ? t("remove") : (t("repBrandLogoUpload" as never) || "Upload")}
                </button>
                {branding.logoDataUrl && (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a data-URL preview, not a Next image */}
                    <img src={branding.logoDataUrl} alt="" style={{ maxHeight: 28, maxWidth: 90, objectFit: "contain" }} />
                    <button
                      type="button" className="btn" onClick={() => set({ logoDataUrl: "" })}
                      style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer" }}
                      aria-label={t("annDeleteNote") || "Remove"}
                    >
                      ×
                    </button>
                  </>
                )}
                <input ref={fileRef} type="file" accept="image/png,image/svg+xml,image/jpeg" hidden onChange={e => onLogoFile(e.target.files?.[0])} />
              </div>
              {logoError && <div style={{ fontSize: 11.5, color: "var(--color-accent-red, #dc2626)", marginTop: 4 }}>{logoError}</div>}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={label}>{t("repBrandFooter")}</label>
            <input style={input} value={branding.footer} onChange={e => set({ footer: e.target.value })} maxLength={300} />
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: "var(--color-text-primary)", cursor: "pointer" }}>
            <input type="checkbox" checked={branding.showPoweredBy} onChange={e => set({ showPoweredBy: e.target.checked })} />
            {t("repBrandPoweredBy")}
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
            <button
              type="button" onClick={() => void save()} disabled={saving}
              style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid transparent", background: "#2563eb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}
            >
              {t("seoSave") || "Save"}
            </button>
            {note && <span style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>{note}</span>}
          </div>
        </>
      )}

      <style>{`.rb-spin { animation: rb-rotate 0.9s linear infinite; } @keyframes rb-rotate { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
