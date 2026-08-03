"use client";

import { useEffect, useState } from "react";
import { Plus, ListChecks, Trash2, Globe, AlertCircle, RefreshCw, Search, CheckCheck } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface QueueItem {
  id: string;
  url: string;
  status: string;
  createdAt: string;
  domain: {
    domain: string;
  };
}

interface DomainOpt {
  id: string;
  domain: string;
}

export default function IndexerQueuePage() {
  const { t } = useLanguage();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [crawledCount, setCrawledCount] = useState(0);
  const PAGE_SIZE = 15;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [domains, setDomains] = useState<DomainOpt[]>([]);
  const [domainId, setDomainId] = useState("all");
  const [urlsInput, setUrlsInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isLarge, setIsLarge] = useState(false);
  // IndexNow key — same storage convention as the per-site SEO panel (shared global key).
  const [indexNowKey, setIndexNowKey] = useState("");

  const fetchDomains = async () => {
    try {
      const res = await fetch("/api/indexer/domains");
      if (res.ok) {
        const d = await res.json();
        setDomains(d);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchQueue = async (p = page) => {
    try {
      const res = await fetch(`/api/indexer/queue?page=${p}&pageSize=${PAGE_SIZE}`);
      if (res.ok) {
        const d = await res.json();
        // Support both the paginated shape and (defensively) a raw array
        const items = Array.isArray(d) ? d : (d.items ?? []);
        setQueue(items);
        setTotal(Array.isArray(d) ? items.length : (d.total ?? 0));
        setCrawledCount(Array.isArray(d) ? 0 : (d.crawled ?? 0));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDomains();
    setIsLarge(window.innerWidth > 960);
    try { setIndexNowKey(localStorage.getItem("seoKey_indexnow") || ""); } catch {}
  }, []);

  // Refetch whenever the page changes (and on first mount)
  useEffect(() => {
    fetchQueue(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlsInput.trim()) {
      setStatusMsg({ type: "error", text: t("indexerQueueEnterUrl") });
      return;
    }

    setSubmitting(true);
    setStatusMsg(null);

    try {
      const res = await fetch("/api/indexer/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domainId,
          urls: urlsInput,
          indexNowKey: indexNowKey.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        const domainInfo = domainId === "all"
          ? ` → distributed across ${data.domainsUsed} doorway domains`
          : "";
        const sitemapInfo = data.totalUrls && data.totalUrls !== data.count
          ? ` (${data.totalUrls} total, ${data.totalUrls - data.count} duplicates skipped)`
          : "";
        // IndexNow result (Bing/Yandex) — independent of the doorway network
        let inInfo = "";
        if (data.indexNow) {
          const { submitted, hosts, errors } = data.indexNow;
          inInfo = submitted > 0
            ? ` · IndexNow: отправлено ${submitted} URL (${hosts} сайт(ов)) → Bing/Yandex`
            : "";
          if (errors?.length) inInfo += ` · ошибки IndexNow: ${errors.slice(0, 2).join("; ")}`;
        }
        setStatusMsg({ type: "success", text: `✓ Queued ${data.count} URLs${sitemapInfo}${domainInfo}${inInfo}` });
        setUrlsInput("");
        setPage(1); fetchQueue(1);
      } else {
        setStatusMsg({ type: "error", text: data.error || "Failed to add URLs." });
      }
    } catch (err: any) {
      setStatusMsg({ type: "error", text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    if (!confirm("Очистить всю очередь? Будут удалены все URL, включая ещё не показанные ботам.")) return;
    try {
      const res = await fetch("/api/indexer/queue", { method: "DELETE" });
      if (res.ok) {
        setStatusMsg({ type: "success", text: "Очередь очищена." });
        setPage(1); fetchQueue(1);
      }
    } catch (e: any) {
      setStatusMsg({ type: "error", text: e.message });
    }
  };

  // Remove only URLs already shown to crawlers, keeping pending ones in the rotation
  const handleClearCrawled = async () => {
    if (!confirm(`Удалить ${crawledCount} URL со статусом CRAWLED? Ожидающие (PENDING) останутся в очереди.`)) return;
    try {
      const res = await fetch("/api/indexer/queue?status=crawled", { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatusMsg({ type: "success", text: `Удалено ${d.deleted ?? crawledCount} CRAWLED URL.` });
        setPage(1); fetchQueue(1);
      } else {
        setStatusMsg({ type: "error", text: d.error || "Не удалось удалить." });
      }
    } catch (e: any) {
      setStatusMsg({ type: "error", text: e.message });
    }
  };

  // Google "site:" lookup — quickest way to eyeball whether a URL made it into the index
  const siteSearchUrl = (url: string) => {
    const clean = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://www.google.com/search?q=site:${encodeURIComponent(clean)}`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Description Banner */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "4px"
      }}>
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
          {t("indexerTabQueue")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}>
          {t("indexerTabDescQueue")}
        </p>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: isLarge ? "minmax(0, 1fr) minmax(0, 1.3fr)" : "1fr",
        gap: "24px",
        alignItems: "start",
      }}>
        {/* Bulk Submission Form */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px"
      }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
          {t("indexerQueueTitle")}
        </h3>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>
          {t("indexerQueueDesc")}
        </p>

        {statusMsg && (
          <div style={{
            padding: "10px 14px",
            borderRadius: "8px",
            fontSize: "12px",
            background: statusMsg.type === "success" ? "rgba(52,199,89,0.08)" : "rgba(255,69,58,0.08)",
            border: statusMsg.type === "success" ? "1px solid rgba(52,199,89,0.2)" : "1px solid rgba(255,69,58,0.2)",
            color: statusMsg.type === "success" ? "var(--color-accent-green)" : "var(--color-accent-red)",
            display: "flex",
            alignItems: "center",
            gap: "8px"
          }}>
            <AlertCircle size={14} />
            {statusMsg.text}
          </div>
        )}

        <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Select Domain */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              {t("indexerQueueDistMode")}
            </label>
            <select
              value={domainId}
              onChange={e => setDomainId(e.target.value)}
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none",
                width: "100%"
              }}
            >
              <option value="all">{t("indexerQueueAllDomains")}</option>
              {domains.map(d => (
                <option key={d.id} value={d.id}>{d.domain}</option>
              ))}
            </select>
          </div>

          {/* URLs input */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              {t("indexerQueueUrlsLabel")}
            </label>
            <textarea
              value={urlsInput}
              onChange={e => setUrlsInput(e.target.value)}
              placeholder={"https://my-site.com/page-1\nhttps://my-site.com/page-2\nhttps://my-site.com/sitemap.xml"}
              rows={8}
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none",
                fontFamily: "monospace",
                resize: "vertical"
              }}
            />
            <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
              {t("indexerQueueSitemapHint")}
            </span>
          </div>

          {/* IndexNow — direct submission to Bing/Yandex, independent of the doorway network */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              Ключ IndexNow (Bing / Yandex) — необязательно
            </label>
            <input
              type="text"
              value={indexNowKey}
              onChange={e => {
                setIndexNowKey(e.target.value);
                try { localStorage.setItem("seoKey_indexnow", e.target.value.trim()); } catch {}
              }}
              placeholder="a1b2c3d4e5f6..."
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none",
                fontFamily: "monospace"
              }}
            />
            <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
              Если указан — URL сразу уходят в Bing и Yandex напрямую, не дожидаясь ботов на дорвеях.
              Требуется один раз положить файл <code>{(indexNowKey.trim() || "ВАШ_КЛЮЧ")}.txt</code> с этим же ключом внутри
              в корень каждого мани-сайта (<code>https://ваш-сайт/{(indexNowKey.trim() || "ВАШ_КЛЮЧ")}.txt</code>).
              Ключ — любая строка 8–128 символов (латиница и цифры).
            </span>
          </div>

          <button
            type="submit"
            disabled={submitting || domains.length === 0}
            style={{
              padding: "10px",
              borderRadius: "8px",
              background: "var(--color-accent-blue)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              opacity: (submitting || domains.length === 0) ? 0.7 : 1,
              transition: "background 0.15s",
              marginTop: "4px"
            }}
            onMouseOver={e => { if (!submitting && domains.length > 0) e.currentTarget.style.background = "var(--color-accent-blue-dark)"; }}
            onMouseOut={e => { if (!submitting && domains.length > 0) e.currentTarget.style.background = "var(--color-accent-blue)"; }}
          >
            {submitting ? (
              <>
                <RefreshCw size={14} className="spin" />
                {t("indexerQueueProcessing")}
              </>
            ) : (
              <>
                <Plus size={14} />
                {t("indexerQueueAddBtn")}
              </>
            )}
          </button>
        </form>
      </div>

      {/* Queue list table */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "16px"
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <ListChecks size={16} color="var(--color-accent-blue)" />
            <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
              Crawl Queue
            </h3>
            {total > 0 && (
              <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", fontWeight: 500 }}>
                {total} URL · {crawledCount} crawled
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {crawledCount > 0 && (
            <button
              onClick={handleClearCrawled}
              title="Удалить только уже показанные ботам URL (PENDING останутся)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                background: "transparent",
                border: "1px solid rgba(52,199,89,0.25)",
                borderRadius: "6px",
                color: "var(--color-accent-green)",
                fontSize: "12px",
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "all 0.15s"
              }}
              onMouseOver={e => { e.currentTarget.style.background = "rgba(52,199,89,0.07)"; }}
              onMouseOut={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <CheckCheck size={12} />
              Очистить CRAWLED ({crawledCount})
            </button>
          )}
          {total > 0 && (
            <button
              onClick={handleClear}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                background: "transparent",
                border: "1px solid rgba(255,69,58,0.2)",
                borderRadius: "6px",
                color: "var(--color-accent-red)",
                fontSize: "12px",
                cursor: "pointer",
                transition: "all 0.15s"
              }}
              onMouseOver={e => { e.currentTarget.style.background = "rgba(255,69,58,0.06)"; }}
              onMouseOut={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <Trash2 size={12} />
              Clear Queue
            </button>
          )}
          </div>
        </div>

        {loading ? (
          <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "12px", padding: "40px 0", color: "var(--color-text-secondary)" }}>
            <RefreshCw size={18} className="spin" />
            <span>{t("idxQueueLoading")}</span>
          </div>
        ) : queue.length === 0 ? (
          <div style={{
            flex: "1 1 auto",
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--color-text-secondary)",
            fontSize: "13px",
            border: "1px dashed var(--color-border)",
            borderRadius: "12px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px"
          }}>
            <Globe size={24} color="var(--color-text-tertiary)" />
            Queue is currently empty.
            <span style={{ fontSize: "11px" }}>Newly added doorway URLs waiting to be fetched by Googlebot will appear here.</span>
          </div>
        ) : (
          // Height is bounded by PAGE_SIZE rows + the pagination footer, so no fixed maxHeight
          // and no infinite growth — the card is exactly as tall as one page of results.
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
              <thead>
                <tr style={{ color: "var(--color-text-secondary)", height: "36px" }}>
                  {[
                    // Renamed from "Domain"/"URL Path". Both columns are domains, and the old
                    // labels gave no hint which was which: the first is the doorway that will
                    // host the link, the second is the site the link points at. With several
                    // sites queued at once, the second was the one you needed and the one that
                    // had its host stripped off.
                    { label: "Doorway", w: undefined as string | undefined, align: "left" as const },
                    { label: "Target URL", w: undefined, align: "left" as const },
                    { label: "Status", w: "100px", align: "left" as const },
                    { label: "Индекс", w: "56px", align: "center" as const },
                  ].map(h => (
                    <th
                      key={h.label}
                      style={{
                        padding: "0 8px",
                        width: h.w,
                        textAlign: h.align,
                        // keep headers visible while scrolling the now full-height list
                        position: "sticky",
                        top: 0,
                        zIndex: 1,
                        background: "var(--color-card)",
                        borderBottom: "1px solid var(--color-border)",
                      }}
                    >
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queue.map(item => {
                  // Host and path shown separately rather than the path alone. The queue mixes
                  // URLs from every site an operator has submitted, and a bare "/category/x"
                  // does not say whose page it is.
                  const host = item.url.replace(/^https?:\/\//, "").split("/")[0];
                  const path = item.url.replace(/^https?:\/\/[^/]+/, "");
                  const isCrawled = item.status.toLowerCase() === "crawled";
                  return (
                    <tr key={item.id} style={{ borderBottom: "1px solid var(--color-border-soft)", height: "38px" }}>
                      <td style={{ padding: "0 8px", fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>
                        {item.domain.domain}
                      </td>
                      <td
                        title={item.url}
                        style={{ padding: "0 8px", fontFamily: "monospace", maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {/* Host carries the weight, path is context — the reverse of how a URL
                            usually reads, because here the question is "which site" first. */}
                        <span style={{ color: "var(--color-text-primary)", fontWeight: 600 }}>{host}</span>
                        <span style={{ color: "var(--color-text-tertiary)" }}>{path || "/"}</span>
                      </td>
                      <td style={{ padding: "0 8px" }}>
                        <span style={{
                          padding: "2px 6px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          backgroundColor: isCrawled ? "rgba(52,199,89,0.12)" : "rgba(255,159,10,0.1)",
                          color: isCrawled ? "var(--color-accent-green)" : "var(--color-accent-orange)",
                        }}>
                          {item.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: "0 8px", textAlign: "center" }}>
                        <a
                          href={siteSearchUrl(item.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Проверить в Google: site:${item.url.replace(/^https?:\/\//, "")}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "4px",
                            borderRadius: "6px",
                            color: "var(--color-text-tertiary)",
                            transition: "all 0.15s"
                          }}
                          onMouseOver={e => { e.currentTarget.style.color = "var(--color-accent-blue)"; e.currentTarget.style.background = "rgba(41,151,255,0.08)"; }}
                          onMouseOut={e => { e.currentTarget.style.color = "var(--color-text-tertiary)"; e.currentTarget.style.background = "transparent"; }}
                        >
                          <Search size={13} />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: "12px",
            borderTop: "1px solid var(--color-border)",
            fontSize: "12px",
            color: "var(--color-text-secondary)"
          }}>
            <span>
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} из {total}
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{
                  padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-border)",
                  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "11px",
                  cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.5 : 1
                }}
              >
                ← Назад
              </button>
              <span style={{ padding: "4px 6px", color: "var(--color-text-tertiary)" }}>
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                style={{
                  padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-border)",
                  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "11px",
                  cursor: page >= totalPages ? "not-allowed" : "pointer", opacity: page >= totalPages ? 0.5 : 1
                }}
              >
                Вперёд →
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
