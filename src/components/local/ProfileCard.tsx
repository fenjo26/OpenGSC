"use client";

// Local → Business profile (N4, brief §1). The card every other tab reads: NAP compares against
// it, the schema is generated from it, GBP publishes for it. "Fill from the site" fetches the
// homepage's JSON-LD/meta into a DRAFT the user confirms — nothing is saved silently.

import { useMemo, useState } from "react";
import { Check, Loader2, MapPin, Save, Wand2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { LocalProfileData, OpeningHoursDay } from "@/lib/local/types";
import { BUSINESS_TYPES } from "@/lib/local/schema";
import { btnGhost, btnPrimary, btnDisabled, fieldLabel, inputStyle, sendJson } from "./shared";

const DAYS: OpeningHoursDay["day"][] = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** An editable copy of the profile; "" lat/lng inputs keep numbers out of the form state. */
interface Form {
  name: string; businessType: string;
  street: string; locality: string; region: string; postalCode: string; country: string;
  phone: string; email: string; lat: string; lng: string;
  hours: Record<string, { opens: string; closes: string }>;
  priceRange: string; sameAs: string; serviceAreas: string;
}

const formOf = (p: LocalProfileData | null): Form => ({
  name: p?.name ?? "",
  businessType: p?.businessType ?? "LocalBusiness",
  street: p?.street ?? "", locality: p?.locality ?? "", region: p?.region ?? "",
  postalCode: p?.postalCode ?? "", country: p?.country ?? "",
  phone: p?.phone ?? "", email: p?.email ?? "",
  lat: p?.lat != null ? String(p.lat) : "", lng: p?.lng != null ? String(p.lng) : "",
  hours: Object.fromEntries((p?.hours ?? []).map(h => [h.day, { opens: h.opens, closes: h.closes }])),
  priceRange: p?.priceRange ?? "",
  sameAs: (p?.sameAs ?? []).join("\n"),
  serviceAreas: (p?.serviceAreas ?? []).join("\n"),
});

const num = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default function ProfileCard({ siteId, profile, onChanged }: {
  siteId: string;
  profile: LocalProfileData | null;
  /** Called after a successful save so the page refreshes hasProfile for the other tabs. */
  onChanged?: () => void;
}) {
  const { t } = useLanguage();
  const [form, setForm] = useState<Form>(formOf(profile));
  const [busy, setBusy] = useState<"" | "save" | "fill">("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const areas = useMemo(() =>
    form.serviceAreas.split("\n").map(s => s.trim()).filter(Boolean), [form.serviceAreas]);

  async function save() {
    setBusy("save"); setError(""); setSaved(false);
    const hours: OpeningHoursDay[] = DAYS
      .filter(d => form.hours[d]?.opens && form.hours[d]?.closes)
      .map(d => ({ day: d, opens: form.hours[d]!.opens, closes: form.hours[d]!.closes }));
    const { ok, data } = await sendJson("/api/local/profile", "PUT", {
      siteId,
      name: form.name, businessType: form.businessType,
      street: form.street, locality: form.locality, region: form.region,
      postalCode: form.postalCode, country: form.country,
      phone: form.phone, email: form.email,
      lat: num(form.lat), lng: num(form.lng),
      hours,
      priceRange: form.priceRange,
      sameAs: form.sameAs.split("\n").map(s => s.trim()).filter(Boolean),
      serviceAreas: form.serviceAreas.split("\n").map(s => s.trim()).filter(Boolean),
    });
    setBusy("");
    if (!ok) {
      setError(data.notMigrated ? t("locNotMigrated" as never) : t("locSaveFailed" as never));
      return;
    }
    setSaved(true);
    // The server normalises (E.164 phone, hours) — the form shows what was actually stored.
    if (data.profile) setForm(formOf(data.profile as LocalProfileData));
    onChanged?.();
  }

  /** "Fill from the site": a draft into the form — the user reviews and presses Save. */
  async function fillFromSite() {
    setBusy("fill"); setError("");
    const { ok, data } = await sendJson("/api/local/profile/fill", "POST", { siteId });
    setBusy("");
    if (!ok || !data.draft) {
      setError(String(data.error ?? "fill_failed"));
      return;
    }
    const d = data.draft as Partial<LocalProfileData>;
    setForm(f => ({
      ...f,
      ...("name" in d && d.name ? { name: d.name } : {}),
      ...("businessType" in d && d.businessType ? { businessType: d.businessType } : {}),
      ...(d.street ? { street: d.street } : {}),
      ...(d.locality ? { locality: d.locality } : {}),
      ...(d.region ? { region: d.region } : {}),
      ...(d.postalCode ? { postalCode: d.postalCode } : {}),
      ...(d.country ? { country: d.country } : {}),
      ...(d.phone ? { phone: d.phone } : {}),
      ...(d.email ? { email: d.email } : {}),
      ...(d.lat != null ? { lat: String(d.lat) } : {}),
      ...(d.lng != null ? { lng: String(d.lng) } : {}),
      ...(Array.isArray(d.hours) && d.hours.length
        ? { hours: Object.fromEntries(d.hours.map(h => [h.day, { opens: h.opens, closes: h.closes }])) }
        : {}),
      ...(d.priceRange ? { priceRange: d.priceRange } : {}),
      ...(Array.isArray(d.sameAs) && d.sameAs.length ? { sameAs: d.sameAs.join("\n") } : {}),
    }));
  }

  const half = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 } as const;

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={half}>
        <div>
          <span style={fieldLabel}>{t("locName")}</span>
          <input style={{ ...inputStyle, width: "100%" }} value={form.name}
            onChange={e => set("name", e.target.value)} placeholder="Sky Taxi Thessaloniki" />
        </div>
        <div>
          <span style={fieldLabel}>{t("locType")}</span>
          <select style={{ ...inputStyle, width: "100%" }} value={form.businessType}
            onChange={e => set("businessType", e.target.value)}>
            {BUSINESS_TYPES.map(bt => <option key={bt.value} value={bt.value}>{bt.value}</option>)}
          </select>
        </div>
      </div>

      <div>
        <span style={fieldLabel}>{t("locAddress")}</span>
        <div style={half}>
          <input style={{ ...inputStyle, width: "100%" }} value={form.street} placeholder={t("locStreet" as never)}
            onChange={e => set("street", e.target.value)} />
          <input style={{ ...inputStyle, width: "100%" }} value={form.locality} placeholder={t("locCity" as never)}
            onChange={e => set("locality", e.target.value)} />
          <input style={{ ...inputStyle, width: "100%" }} value={form.region} placeholder={t("locRegion" as never)}
            onChange={e => set("region", e.target.value)} />
          <input style={{ ...inputStyle, width: "100%" }} value={form.postalCode} placeholder={t("locPostal" as never)}
            onChange={e => set("postalCode", e.target.value)} />
          <input style={{ ...inputStyle, width: "100%" }} value={form.country} placeholder={t("locCountry" as never)}
            onChange={e => set("country", e.target.value)} maxLength={2} title="ISO-3166 alpha-2, e.g. GR" />
        </div>
      </div>

      <div style={half}>
        <div>
          <span style={fieldLabel}>{t("locPhone")} (E.164)</span>
          <input style={{ ...inputStyle, width: "100%" }} value={form.phone} placeholder="+302310123456"
            onChange={e => set("phone", e.target.value)} />
        </div>
        <div>
          <span style={fieldLabel}>E-mail</span>
          <input style={{ ...inputStyle, width: "100%" }} value={form.email} placeholder="info@example.gr"
            onChange={e => set("email", e.target.value)} />
        </div>
        <div>
          <span style={fieldLabel}>{t("locCoords" as never)}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...inputStyle, width: "100%" }} value={form.lat} placeholder="40.5197"
              onChange={e => set("lat", e.target.value)} inputMode="decimal" />
            <input style={{ ...inputStyle, width: "100%" }} value={form.lng} placeholder="22.9709"
              onChange={e => set("lng", e.target.value)} inputMode="decimal" />
          </div>
        </div>
        <div>
          <span style={fieldLabel}>{t("locPriceRange" as never)}</span>
          <input style={{ ...inputStyle, width: "100%" }} value={form.priceRange} placeholder="€€"
            onChange={e => set("priceRange", e.target.value)} />
        </div>
      </div>

      {/* Opening hours: one row per day, empty = closed that day (the row is simply not sent). */}
      <div>
        <span style={fieldLabel}>{t("locHours")}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {DAYS.map(day => (
            <label key={day} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ width: 26, fontWeight: 600, color: "var(--color-text-secondary)" }}>{day}</span>
              <input style={{ ...inputStyle, width: 100 }} type="time"
                value={form.hours[day]?.opens ?? ""}
                onChange={e => set("hours", { ...form.hours, [day]: { opens: e.target.value, closes: form.hours[day]?.closes ?? "" } })} />
              <span style={{ color: "var(--color-text-tertiary)" }}>–</span>
              <input style={{ ...inputStyle, width: 100 }} type="time"
                value={form.hours[day]?.closes ?? ""}
                onChange={e => set("hours", { ...form.hours, [day]: { opens: form.hours[day]?.opens ?? "", closes: e.target.value } })} />
              {!form.hours[day]?.opens && !form.hours[day]?.closes && (
                <span style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>{t("locHoursClosed" as never)}</span>
              )}
            </label>
          ))}
        </div>
      </div>

      <div style={half}>
        <div>
          <span style={fieldLabel}>sameAs</span>
          <textarea style={{ ...inputStyle, width: "100%", minHeight: 64, resize: "vertical" }} value={form.sameAs}
            onChange={e => set("sameAs", e.target.value)} placeholder={"https://facebook.com/…\nhttps://instagram.com/…"} />
        </div>
        <div>
          <span style={fieldLabel}>{t("locAreas")}</span>
          <textarea style={{ ...inputStyle, width: "100%", minHeight: 64, resize: "vertical" }} value={form.serviceAreas}
            onChange={e => set("serviceAreas", e.target.value)} placeholder={"Halkidiki\nKaterini"} />
        </div>
      </div>

      {/* Service-area landing pages (brief §5): open the outline generator with the keyword
          prefilled via the sessionStorage handover it already accepts, plus the local-landing
          note in the clipboard — see the report for the query-param ask. */}
      {areas.length > 0 && (
        <ServiceAreas areas={areas} country={form.country} />
      )}

      {error && <div style={{ fontSize: 12.5, color: "var(--color-danger)" }}>⚠ {error}</div>}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={save} disabled={!form.name.trim() || busy !== ""}
          style={{ ...btnPrimary, ...btnDisabled(!form.name.trim() || busy !== "") }}>
          {busy === "save" ? <Loader2 size={14} className="spin" /> : <Save size={14} />} {t("setSave")}
        </button>
        <button type="button" onClick={fillFromSite} disabled={busy !== ""} style={{ ...btnGhost, ...btnDisabled(busy !== "") }}>
          {busy === "fill" ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} {t("locFillFromSite")}
        </button>
        {saved && <span style={{ fontSize: 12.5, color: "#10B981", display: "inline-flex", gap: 5, alignItems: "center" }}><Check size={14} /> {t("apiKeySaved")}</span>}
      </div>
    </div>
  );
}

/** One row per service area with a "create page" handover to /seo-tools/outline. */
function ServiceAreas({ areas, country }: { areas: string[]; country: string }) {
  const { t } = useLanguage();
  const [service, setService] = useState<Record<string, string>>({});

  const createPage = async (area: string) => {
    const svc = (service[area] ?? "").trim();
    if (!svc) return;
    const note = t("locCreatePageNote" as never);
    // The outline page accepts a sessionStorage handover (its own "cluster seed" channel):
    // keyword + market. The local-landing note travels via the clipboard.
    try {
      sessionStorage.setItem("seoClusterSeed", JSON.stringify({ keyword: `${svc} ${area}`, ...(country ? { gl: country.toLowerCase() } : {}) }));
      await navigator.clipboard.writeText(`${svc} ${area} — ${note}`);
    } catch { /* clipboard needs a gesture; the sessionStorage seed still lands */
    }
    window.location.href = "/seo-tools/outline";
  };

  return (
    <div style={{ borderTop: "1px solid var(--color-border-soft)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ ...fieldLabel, marginBottom: 0 }}>
        <MapPin size={11} style={{ verticalAlign: "-1px" }} /> {t("locCreatePageHint" as never)}
      </span>
      {areas.map(area => (
        <div key={area} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, color: "var(--color-text-primary)", fontWeight: 600, minWidth: 90 }}>{area}</span>
          <input style={{ ...inputStyle, width: 170 }} value={service[area] ?? ""}
            placeholder={t("locServiceWord" as never)}
            onChange={e => setService(s => ({ ...s, [area]: e.target.value }))} />
          <button type="button" onClick={() => createPage(area)} disabled={!(service[area] ?? "").trim()}
            style={{ ...btnGhost, ...btnDisabled(!(service[area] ?? "").trim()) }}>
            {t("locCreatePage")}
          </button>
        </div>
      ))}
    </div>
  );
}
