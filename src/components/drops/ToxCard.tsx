"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type ToxSnapshotEvent = {
  ts: string;
  status: number | null;
  title: string;
  signals: { code: string; detail: string }[];
};

type ToxCardData = {
  verdict: string | null;
  note: string | null;
  at: string | null;
  source: "free" | "ai";
  snapshots: ToxSnapshotEvent[];
};

function fmtTs(ts: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(ts);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ts;
}

/**
 * The expanded history card under a catalogue row: the verdict, the note, and — the whole
 * point of the card — the snapshots the classifier actually saw, each with the signals that
 * fired in it. A verdict without its reasons hides exactly where calibration goes wrong.
 */
export default function ToxCard({ domain }: { domain: string }) {
  const { t } = useLanguage();
  const tr = (k: string) => t(k as never) as string;
  const [data, setData] = useState<ToxCardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/drops/toxicity?domain=${encodeURIComponent(domain)}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(b => { if (!cancelled) setData(b as ToxCardData); })
      .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [domain]);

  if (err) {
    return <div style={{ fontSize: 12.5, color: "#ff6b62" }}>
      {tr("dropsToxCardErr").replace("{err}", err)}
    </div>;
  }
  if (!data) {
    return <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--color-text-secondary)" }}>
      <Loader2 size={14} className="spin" />{tr("dropsToxCardLoading")}
    </div>;
  }

  return <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", color: "var(--color-text-secondary)" }}>
      {data.verdict
        ? <b>{tr("dropsToxCardVerdict")}: {data.verdict}</b>
        : <span style={{ color: "var(--color-text-tertiary)" }}>{tr("dropsToxCardNone")}</span>}
      <span style={{ color: "var(--color-text-tertiary)" }}>
        {data.source === "free" ? tr("dropsToxCardSourceFree") : tr("dropsToxCardSourceAi")}
        {data.at ? ` · ${new Date(data.at).toLocaleDateString()}` : ""}
      </span>
    </div>
    {data.note && <div style={{ color: "var(--color-text-secondary)", wordBreak: "break-word" }}>{data.note}</div>}
    {data.snapshots.length === 0 && <div style={{ color: "var(--color-text-tertiary)" }}>
      {tr("dropsToxCardNoSnapshots")}
    </div>}
    {data.snapshots.map(s => <div key={s.ts} style={{
      display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px", borderRadius: 8,
      border: "1px solid var(--color-border)", background: "var(--color-card)",
    }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <b style={{ color: "var(--color-text-primary)" }}>{fmtTs(s.ts)}</b>
        {s.status != null && <span style={{ color: "var(--color-text-tertiary)" }}>HTTP {s.status}</span>}
        <span style={{ wordBreak: "break-word" }}>{s.title || "—"}</span>
      </div>
      {s.signals.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {s.signals.map((sig, i) => <span key={i} style={{ fontSize: 11.5, color: "var(--color-accent-orange, #ff9f0a)" }}>
          {tr(`dropsToxSignal_${sig.code}`)}{sig.detail ? ` — ${sig.detail}` : ""}
        </span>)}
      </div>}
    </div>)}
  </div>;
}
