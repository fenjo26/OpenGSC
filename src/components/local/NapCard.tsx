"use client";

// Local → NAP check (N4, brief §2). Runs the live check (free, pages fetched by this server),
// then renders page × field with the three verdicts. The report is deliberately not stored —
// it is a snapshot of the site as it is right now, and a stale verdict is worse than none.

import { useState } from "react";
import { Loader2, SearchCheck } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { NapCheckReport } from "@/lib/local/types";
import { btnPrimary, btnDisabled, statusPill, tdStyle, thStyle, sendJson } from "./shared";

const FIELD_ICON = { name: "🏷", phone: "☎", address: "📍" } as const;

export default function NapCard({ siteId, hasProfile }: { siteId: string; hasProfile: boolean }) {
  const { t } = useLanguage();
  const [report, setReport] = useState<NapCheckReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true); setError(""); setReport(null);
    const { ok, data } = await sendJson("/api/local/nap", "POST", { siteId });
    setBusy(false);
    if (!ok) {
      setError(data.notMigrated ? t("locNotMigrated" as never) : data.error === "profile_required"
        ? t("locNapNeedsProfile" as never)
        : String(data.error ?? "nap_check_failed"));
      return;
    }
    setReport(data.report as NapCheckReport);
  }

  const verdict = (status: "match" | "differs" | "missing") =>
    status === "match"
      ? <span style={statusPill(t("locNap_match"), "good")}>{t("locNap_match")}</span>
      : status === "differs"
        ? <span style={statusPill(t("locNap_differs"), "warn")}>{t("locNap_differs")}</span>
        : <span style={statusPill(t("locNap_missing"), "mute")}>{t("locNap_missing")}</span>;

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={run} disabled={!hasProfile || busy}
          style={{ ...btnPrimary, ...btnDisabled(!hasProfile || busy) }}
          title={!hasProfile ? t("locNapNeedsProfile" as never) : undefined}>
          {busy ? <Loader2 size={14} className="spin" /> : <SearchCheck size={14} />} {t("locNapRun")}
        </button>
        <span className="metric-cost">{t("locFreeNet" as never)}</span>
        {report && (
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {report.counts.match} {t("locNap_match").toLowerCase()} · {report.counts.differs} {t("locNap_differs").toLowerCase()} · {report.counts.missing} {t("locNap_missing").toLowerCase()} · {report.counts.unreachable} {t("locNapUnreachable" as never).toLowerCase()}
          </span>
        )}
      </div>

      {error && <div style={{ fontSize: 12.5, color: "var(--color-danger)" }}>⚠ {error}</div>}

      {report && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t("locNapPage" as never)}</th>
                <th style={thStyle}>{t("locNapField" as never)}</th>
                <th style={{ ...thStyle, textAlign: "right" }}>—</th>
              </tr>
            </thead>
            <tbody>
              {report.pages.flatMap(page => {
                const head = (
                  <tr key={page.url}>
                    <td style={tdStyle} colSpan={2} title={page.url}>
                      <strong style={{ color: "var(--color-text-primary)" }}>{new URL(page.url).pathname || "/"}</strong>
                      {page.error && (
                        <span style={{ ...statusPill(t("locNapUnreachable" as never), "bad"), marginLeft: 8 }} title={page.error}>
                          {t("locNapUnreachable" as never)}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", color: "var(--color-text-tertiary)", fontSize: 11 }}>
                      {new URL(page.url).hostname}
                    </td>
                  </tr>
                );
                if (page.error) return [head];
                const rows = page.diffs.map(d => (
                  <tr key={`${page.url}-${d.field}`}>
                    <td style={{ ...tdStyle, paddingLeft: 28 }}>{FIELD_ICON[d.field]} {d.field}</td>
                    <td style={tdStyle} title={`${t("locNapExpected" as never)}: ${d.expected}`}>{d.found || "—"}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{verdict(d.status)}</td>
                  </tr>
                ));
                return [head, ...rows];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
