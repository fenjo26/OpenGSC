"use client";

import { useEffect, useState, useRef } from "react";
import { Search, Globe, ChevronRight, Activity, RefreshCw, AlertCircle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface LogEntry {
  id: string;
  domainId: string;
  timestamp: string;
  url: string;
  ip: string;
  userAgent: string;
  botType: string;
  statusCode: number;
  referer: string | null;
  domain: {
    domain: string;
  };
}

interface DomainOpt {
  id: string;
  domain: string;
}

export default function IndexerLogsPage() {
  const { t } = useLanguage();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [domains, setDomains] = useState<DomainOpt[]>([]);
  const [domainId, setDomainId] = useState("");
  const [botType, setBotType] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

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

  const fetchLogs = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    else setFetchingMore(true);
    try {
      let url = `/api/indexer/logs?page=${page}&limit=${limit}`;
      if (domainId) url += `&domainId=${domainId}`;
      if (botType) url += `&botType=${botType}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setLogs(data);
          setTotalCount(data.length);
        } else {
          setLogs(data.logs || []);
          setTotalPages(data.totalPages || 1);
          setTotalCount(data.total || 0);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setFetchingMore(false);
    }
  };

  useEffect(() => {
    fetchDomains();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [domainId, botType]);

  useEffect(() => {
    fetchLogs(true);
  }, [domainId, botType, page, limit]);

  // Live Mode polling
  useEffect(() => {
    if (liveMode) {
      timerRef.current = setInterval(() => {
        fetchLogs(false);
      }, 3500);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [liveMode, domainId, botType]);

  const getStatusColor = (code: number) => {
    if (code === 200) return { bg: "rgba(52,199,89,0.1)", color: "#34C759" };
    if (code === 304) return { bg: "rgba(142,142,147,0.15)", color: "#a1a1a6" };
    if (code === 302 || code === 301) return { bg: "rgba(191,90,242,0.12)", color: "#bf5af2" };
    return { bg: "rgba(255,69,58,0.1)", color: "#FF453A" };
  };

  const getBotLabel = (type: string, ua?: string) => {
    if (type === "google") return { label: "Googlebot", color: "#2997ff" };
    if (type === "bing") return { label: "Bingbot", color: "#ff9f0a" };
    if (type === "yandex") return { label: "YandexBot", color: "#ff453a" };
    if (type === "mailru") return { label: "MailruBot", color: "#8e8e93" };

    // AI Bots detection from User-Agent
    const u = (ua || "").toLowerCase();
    if (u.includes("claudebot") || u.includes("anthropic")) return { label: "ClaudeBot (AI)", color: "#af52de" };
    if (u.includes("deepseek")) return { label: "DeepSeek (AI)", color: "#5856d6" };
    if (u.includes("gptbot") || u.includes("chatgpt")) return { label: "GPTBot (AI)", color: "#30d158" };
    if (u.includes("perplexity")) return { label: "Perplexity (AI)", color: "#64d2ff" };
    if (u.includes("bytespider")) return { label: "ByteSpider (AI)", color: "#ff3b30" };
    if (u.includes("ccbot")) return { label: "CCBot (CommonCrawl)", color: "#ffd60a" };

    if (type === "redirect") return { label: "Redirect", color: "#34c759" };
    return { label: "Other Bot", color: "#a1a1a6" };
  };

  const getRelativeTime = (isoString: string) => {
    const d = new Date(isoString);
    const diffMs = Date.now() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);

    if (diffSec < 15) return t("logsRelativeJustNow");
    if (diffSec < 60) return `${diffSec}${t("logsRelativeSecAgo")}`;
    if (diffMin < 60) return `${diffMin}${t("logsRelativeMinAgo")}`;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
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
          {t("indexerTabLogs")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}>
          {t("indexerTabDescLogs")}
        </p>
      </div>

      {/* Control panel */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "16px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px"
      }}>
        {/* Filters */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px" }}>
          {/* Domain Filter */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("logsDomainLabel")}</span>
            <select
              value={domainId}
              onChange={e => setDomainId(e.target.value)}
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "6px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none"
              }}
            >
              <option value="">{t("logsAllDomains")}</option>
              {domains.map(d => (
                <option key={d.id} value={d.id}>{d.domain}</option>
              ))}
            </select>
          </div>

          {/* Bot Filter */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("logsBotLabel")}</span>
            <select
              value={botType}
              onChange={e => setBotType(e.target.value)}
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "6px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none"
              }}
            >
              <option value="">{t("logsAllTraffic")}</option>
              <option value="google">Googlebot</option>
              <option value="bing">Bingbot</option>
              <option value="yandex">YandexBot</option>
              <option value="mailru">MailruBot</option>
              <option value="redirect">{t("logsRedirectsFilter")}</option>
              <option value="other">{t("logsOtherBotsFilter")}</option>
            </select>
          </div>
        </div>

        {/* Live feed switcher */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {fetchingMore && (
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "6px" }}>
              <RefreshCw size={12} className="spin" />
              {t("logsUpdating")}
            </span>
          )}

          <div
            onClick={() => setLiveMode(l => !l)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
              padding: "6px 12px",
              borderRadius: "8px",
              background: liveMode ? "rgba(52,199,89,0.12)" : "rgba(255,255,255,0.04)",
              border: liveMode ? "1px solid rgba(52,199,89,0.3)" : "1px solid var(--color-border)",
              transition: "all 0.15s"
            }}
          >
            <Activity size={14} color={liveMode ? "#34C759" : "var(--color-text-secondary)"} className={liveMode ? "animate-pulse" : ""} />
            <span style={{ fontSize: "12px", fontWeight: 600, color: liveMode ? "#34C759" : "var(--color-text-secondary)" }}>
              {liveMode ? t("logsLiveActive") : t("logsLiveEnable")}
            </span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: "16px",
        padding: "8px 0",
        overflow: "hidden"
      }}>
        {loading ? (
          <div style={{ padding: "40px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", color: "var(--color-text-secondary)" }}>
            <RefreshCw size={20} className="spin" />
            <span>{t("idxLogsLoading")}</span>
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--color-text-secondary)", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
            <AlertCircle size={24} />
            <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{t("indexerNoLogsTitle")}</span>
            <span style={{ fontSize: "12px" }}>{t("indexerNoLogsDesc")}</span>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)", height: "36px" }}>
                  <th style={{ padding: "0 16px" }}>Time</th>
                  <th style={{ padding: "0 16px" }}>Domain</th>
                  <th style={{ padding: "0 16px" }}>Crawled URL Path</th>
                  <th style={{ padding: "0 16px" }}>IP Address</th>
                  <th style={{ padding: "0 16px" }}>Bot / Agent</th>
                  <th style={{ padding: "0 16px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const status = getStatusColor(log.statusCode);
                  const bot = getBotLabel(log.botType, log.userAgent);
                  const path = log.url.replace(/^https?:\/\/[^/]+/, "");
                  
                  return (
                    <tr
                      key={log.id}
                      style={{
                        borderBottom: "1px solid var(--color-border-soft)",
                        height: "44px",
                        transition: "background 0.15s"
                      }}
                      onMouseOver={e => e.currentTarget.style.background = "var(--color-card-hover)"}
                      onMouseOut={e => e.currentTarget.style.background = "transparent"}
                    >
                      <td style={{ padding: "0 16px", color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
                        {getRelativeTime(log.timestamp)}
                      </td>
                      <td style={{ padding: "0 16px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                        {log.domain.domain}
                      </td>
                      <td style={{ padding: "0 16px", fontFamily: "monospace", color: "var(--color-text-secondary)", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {path}
                      </td>
                      <td style={{ padding: "0 16px", color: "var(--color-text-secondary)" }}>
                        {log.ip}
                      </td>
                      <td style={{ padding: "0 16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          <span style={{ fontSize: "11px", fontWeight: 700, color: bot.color }}>
                            {bot.label}
                          </span>
                          <span
                            title={log.userAgent}
                            style={{
                              fontSize: "10px",
                              color: "var(--color-text-tertiary)",
                              maxWidth: "220px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontFamily: "monospace"
                            }}
                          >
                            {log.userAgent || "Unknown UA"}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: "0 16px" }}>
                        <span style={{
                          padding: "3px 8px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: status.bg,
                          color: status.color,
                        }}>
                          {log.statusCode}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Bar */}
        {totalCount > 0 && (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderTop: "1px solid var(--color-border)",
            fontSize: "12px",
            color: "var(--color-text-secondary)"
          }}>
            <div>
              Total <strong>{totalCount}</strong> logs · Page <strong>{page}</strong> of <strong>{totalPages}</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <select
                value={limit}
                onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
                style={{
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "6px",
                  padding: "4px 8px",
                  fontSize: "12px",
                  color: "var(--color-text-primary)",
                  outline: "none"
                }}
              >
                <option value={25}>25 per page</option>
                <option value={50}>50 per page</option>
                <option value={100}>100 per page</option>
              </select>

              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "6px",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    color: "var(--color-text-primary)",
                    fontSize: "12px",
                    cursor: page <= 1 ? "not-allowed" : "pointer",
                    opacity: page <= 1 ? 0.5 : 1
                  }}
                >
                  ← Prev
                </button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "6px",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    color: "var(--color-text-primary)",
                    fontSize: "12px",
                    cursor: page >= totalPages ? "not-allowed" : "pointer",
                    opacity: page >= totalPages ? 0.5 : 1
                  }}
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
