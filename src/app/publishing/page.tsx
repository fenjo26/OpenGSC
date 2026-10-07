"use client";

// /publishing — self-publishing home (P1: WordPress). Site selector on top (the /local page's
// pattern; choice remembered per browser), then connections and the posts table. The header
// carries the AI badge for the respin task — PATH_TASKS["/publishing"] in lib/seo/aiTasks.ts —
// so the model about to spend is named before the switch is ever flipped.

import { useCallback, useEffect, useState } from "react";
import { Newspaper } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import AiModelBadge from "@/components/AiModelBadge";
import PublishingConnections from "@/components/publishing/PublishingConnections";
import PublishingPosts from "@/components/publishing/PublishingPosts";
import AnchorPanel from "@/components/publishing/AnchorPanel";
import { PUBLISHING_SITE_KEY } from "@/components/publishing/PublishDialog";

export default function PublishingPage() {
  const { t } = useLanguage();
  const [sites, setSites] = useState<{ id: string; url: string }[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [postsKey, setPostsKey] = useState(0);

  const loadSites = useCallback(async () => {
    try {
      const d = await fetch("/api/publishing/connections").then(r => r.json());
      const list = (d?.sites ?? []) as { id: string; url: string }[];
      setSites(list);
      const saved = localStorage.getItem(PUBLISHING_SITE_KEY);
      if (saved && list.some(s => s.id === saved)) setSiteId(saved);
      else if (list.length === 1) setSiteId(list[0].id);
    } catch { setSites([]); }
  }, []);

  // One-tick deferral keeps every setState inside the async callback (the repo's effect rule).
  useEffect(() => {
    const id = setTimeout(() => { void loadSites(); }, 0);
    return () => clearTimeout(id);
  }, [loadSites]);

  const chooseSite = (id: string) => {
    setSiteId(id);
    if (id) localStorage.setItem(PUBLISHING_SITE_KEY, id);
  };

  const siteLabel = (url: string) => url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/+$/, "");

  return (
    <div style={{ padding: "28px var(--page-padding) 60px", maxWidth: "var(--page-max-width)", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: 38, height: 38, borderRadius: "10px",
            background: "rgba(41,151,255,0.12)", border: "1px solid rgba(41,151,255,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Newspaper size={20} color="var(--color-accent-blue)" />
          </div>
          <div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("publishTitle")}</h1>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "2px 0 0" }}>{t("publishDesc")}</p>
          </div>
        </div>
        <AiModelBadge pathname="/publishing" />
      </div>

      <div style={{ margin: "20px 0 18px", maxWidth: "420px" }}>
        <select className="tool-input" value={siteId} onChange={e => chooseSite(e.target.value)}>
          <option value="">{sites === null ? "…" : "—"}</option>
          {(sites ?? []).map(s => <option key={s.id} value={s.id}>{siteLabel(s.url)}</option>)}
        </select>
      </div>

      {siteId && (
        <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          <PublishingConnections siteId={siteId} onChanged={() => setPostsKey(k => k + 1)} />
          <PublishingPosts key={postsKey} siteId={siteId} />
          {/* Anchor distribution across this site's published network posts — the same
              aggregation the publish review runs pre-send, here as the accumulated view. */}
          <AnchorPanel key={`anchors-${postsKey}`} siteId={siteId} />
        </div>
      )}
    </div>
  );
}
