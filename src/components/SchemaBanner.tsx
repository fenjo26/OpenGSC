"use client";

// "Some tables are missing" banner. Mounted app-wide next to UpdateBanner.
//
// Written after a real hour lost to this: the Competitors screen showed its normal empty state
// ("find competitors, then pull one's keywords") on a database that had never been migrated, so
// pulling keywords appeared to do nothing at all. Every route in that layer catches a missing
// table and returns an empty result on purpose — the alternative is a crashed dashboard — but
// the cost of that choice is that "not migrated" and "no data yet" look identical.
//
// This is the one place that tells them apart, and it names the command instead of describing
// the problem.

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function SchemaBanner() {
  const { t } = useLanguage();
  const [missing, setMissing] = useState<string[]>([]);
  const [features, setFeatures] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/system/schema")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (cancelled || !d || d.ok) return;
        setMissing(d.missing ?? []);
        setFeatures(d.features ?? []);
      })
      .catch(() => { /* silent — a banner that cannot load is not worth an error of its own */ });

    // Dismissal is keyed to the set of missing tables, so migrating some of them (or a later
    // release adding new ones) brings the bar back rather than hiding a different problem.
    try {
      const d = sessionStorage.getItem("schema_dismissed");
      if (d) setDismissed(true);
    } catch { /* private mode */ }

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!missing.length) return;
    try {
      const seen = sessionStorage.getItem("schema_dismissed");
      if (seen && seen !== missing.join(",")) setDismissed(false);
    } catch { /* private mode */ }
  }, [missing]);

  if (!missing.length || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem("schema_dismissed", missing.join(",")); } catch { /* private mode */ }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
      padding: "10px 16px",
      background: "var(--color-card)",
      borderBottom: "1px solid var(--color-warning)",
      fontSize: "13px",
    }}>
      <AlertTriangle size={16} style={{ color: "var(--color-warning)", flexShrink: 0 }} />
      <span style={{ color: "var(--color-text-primary)" }}>
        {t("schemaMissing").replace("{n}", String(missing.length))}
      </span>
      {features.length > 0 && (
        <span style={{ color: "var(--color-text-secondary)" }}>
          {t("schemaAffects").replace("{features}", features.join(", "))}
        </span>
      )}
      <code style={{
        fontFamily: "monospace", fontSize: "12px",
        background: "var(--color-bg)", border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm)", padding: "3px 8px",
        color: "var(--color-text-primary)",
      }}>
        npx prisma db push
      </code>
      <span style={{ color: "var(--color-text-tertiary)", fontSize: "12px" }} title={missing.join(", ")}>
        {t("schemaNoDataLoss")}
      </span>
      <button onClick={dismiss} aria-label="dismiss"
        style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "4px" }}>
        <X size={14} />
      </button>
    </div>
  );
}
