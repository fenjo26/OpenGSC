"use client";

import { useEffect, useState } from "react";
import { Plus, Globe, Settings, Trash2, Copy, Check, Eye, EyeOff, AlertCircle, RefreshCw, Code } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import DomainHealthChip from "@/components/DomainHealthChip";

interface IndexerDomain {
  id: string;
  domain: string;
  status: string;
  createdAt: string;
  apiKey: string;
  template: string;
  moneyUrl: string | null;
  allowedBots: string;
  pagesCount: number;
  subdomainsCount: number;
}

export default function IndexerDomainsPage() {
  const { t } = useLanguage();
  const [domains, setDomains] = useState<IndexerDomain[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Form state
  const [newDomain, setNewDomain] = useState("");
  const [moneyUrl, setMoneyUrl] = useState("");
  const [template, setTemplate] = useState("ecommerce");
  const [allowedBots, setAllowedBots] = useState({ google: true, bing: true, yandex: true, mailru: true, ai: true, aiTraining: false });
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // UI state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [isLarge, setIsLarge] = useState(false);

  const fetchDomains = async () => {
    try {
      const res = await fetch("/api/indexer/domains");
      if (res.ok) {
        const d = await res.json();
        setDomains(d);
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
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain) {
      setErrorMsg("Domain name is required.");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    // Format allowed bots string (tokens the doorway script enforces).
    // "cfg" marks a record configured with the new checkboxes, so the script generator
    // treats an absent "ai" token as an intentional OFF rather than a legacy default.
    const botsArray = ["cfg"];
    if (allowedBots.google) botsArray.push("google");
    if (allowedBots.bing) botsArray.push("bing");
    if (allowedBots.yandex) botsArray.push("yandex");
    if (allowedBots.mailru) botsArray.push("mailru");
    if (allowedBots.ai) botsArray.push("ai");
    if (allowedBots.aiTraining) botsArray.push("ai-training");

    try {
      const res = await fetch("/api/indexer/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: newDomain,
          template,
          moneyUrl: moneyUrl || null,
          allowedBots: botsArray.join(","),
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setNewDomain("");
        setMoneyUrl("");
        fetchDomains();
      } else {
        setErrorMsg(data.error || "Failed to add domain.");
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this domain? This will delete all its crawl logs and queue items.")) return;
    try {
      const res = await fetch(`/api/indexer/domains?id=${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchDomains();
      }
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const toggleShowKey = (id: string) => {
    setShowKeys(prev => ({ ...prev, [id]: !prev[id] }));
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
          {t("indexerTabDomains")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}>
          {t("indexerTabDescDomains")}
        </p>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: isLarge ? "1fr 1.3fr" : "1fr",
        gap: "24px",
        alignItems: "start",
      }}>
        {/* Add Domain Form */}
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
          Add New Domain to Farm
        </h3>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>
          Configure a new doorway network or add an expired domain to direct crawl power.
        </p>

        {errorMsg && (
          <div style={{
            padding: "10px 14px",
            borderRadius: "8px",
            fontSize: "12px",
            background: "rgba(255,69,58,0.08)",
            border: "1px solid rgba(255,69,58,0.2)",
            color: "var(--color-accent-red)",
            display: "flex",
            alignItems: "center",
            gap: "8px"
          }}>
            <AlertCircle size={14} />
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Domain name */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              Domain Name (e.g. shopping-deals.net)
            </label>
            <input
              type="text"
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              placeholder="my-doorway-domain.com"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none"
              }}
            />
          </div>

          {/* Money redirect URL */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              Redirect Target URL — куда уходят живые посетители
            </label>
            <input
              type="text"
              value={moneyUrl}
              onChange={e => setMoneyUrl(e.target.value)}
              placeholder="https://www.amazon.com"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none"
              }}
            />
            <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
              Крупный нейтральный сайт по теме домена, НЕ ваш мани-сайт. Свои страницы для индексации добавляйте во вкладке «Очередь».
            </span>
          </div>

          {/* Template Selection */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              Doorway Template
            </label>
            <select
              value={template}
              onChange={e => setTemplate(e.target.value)}
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "8px 12px",
                fontSize: "13px",
                color: "var(--color-text-primary)",
                outline: "none"
              }}
            >
              <option value="ecommerce">Ecommerce (product & shop categories)</option>
              <option value="directory">Directory (reviews & listings)</option>
              <option value="blog">Blog (endless news & articles)</option>
              <option value="portfolio">Portfolio (landing page stack)</option>
            </select>
          </div>

          {/* Allowed Bots */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}>
              Allowed Crawlers
            </label>
            <div style={{ display: "flex", gap: "14px 16px", marginTop: "4px", flexWrap: "wrap" }}>
              {[
                { key: "google", label: "Googlebot", accent: "var(--color-accent-blue)" },
                { key: "bing", label: "Bingbot", accent: "var(--color-accent-blue)" },
                { key: "yandex", label: "YandexBot", accent: "var(--color-accent-blue)" },
                { key: "mailru", label: "Mail.ru", accent: "var(--color-accent-blue)" },
                { key: "ai", label: "AI Answer (GEO)", accent: "var(--color-accent-purple)" },
                { key: "aiTraining", label: "AI Training", accent: "var(--color-accent-purple)" },
              ].map(bot => (
                <label key={bot.key} title={bot.key === "ai" ? "Serve doorway to AI answer/search crawlers (ChatGPT, Perplexity, Claude…) — drives GEO traffic" : bot.key === "aiTraining" ? "Feed AI training-only crawlers (GPTBot, CCBot…). Off = they get 403." : undefined} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={allowedBots[bot.key as keyof typeof allowedBots]}
                    onChange={e => setAllowedBots(prev => ({ ...prev, [bot.key]: e.target.checked }))}
                    style={{ accentColor: bot.accent }}
                  />
                  {bot.label}
                </label>
              ))}
            </div>
            <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>
              AI Answer = трафик из ИИ-поиска (рекомендую). AI Training по умолчанию выкл — тренировочные боты получают 403.
            </span>
          </div>

          <button
            type="submit"
            disabled={submitting}
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
              opacity: submitting ? 0.7 : 1,
              transition: "background 0.15s",
              marginTop: "6px"
            }}
            onMouseOver={e => { if (!submitting) e.currentTarget.style.background = "var(--color-accent-blue-dark)"; }}
            onMouseOut={e => { if (!submitting) e.currentTarget.style.background = "var(--color-accent-blue)"; }}
          >
            {submitting ? (
              <>
                <RefreshCw size={14} className="spin" />
                {t("idxDomainAdding")}
              </>
            ) : (
              <>
                <Plus size={14} />
                Add Domain
              </>
            )}
          </button>
        </form>
      </div>

      {/* Domains list */}
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
          Active Domains ({domains.length})
        </h3>

        {loading ? (
          <div style={{ padding: "40px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", color: "var(--color-text-secondary)" }}>
            <RefreshCw size={18} className="spin" />
            <span>{t("idxDomainsLoading")}</span>
          </div>
        ) : domains.length === 0 ? (
          <div style={{
            padding: "48px 16px",
            textAlign: "center",
            color: "var(--color-text-secondary)",
            fontSize: "13px",
            border: "1px dashed var(--color-border)",
            borderRadius: "12px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px"
          }}>
            <Globe size={24} color="var(--color-text-tertiary)" />
            No domains added yet.
            <span style={{ fontSize: "11px" }}>Configure your first doorway domain on the left to start collecting crawls.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {domains.map(dom => {
              const showKey = showKeys[dom.id] || false;
              
              return (
                <div
                  key={dom.id}
                  style={{
                    border: "1px solid var(--color-border)",
                    borderRadius: "12px",
                    padding: "16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    background: "rgba(255,255,255,0.01)"
                  }}
                >
                  {/* Top Bar */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div style={{
                        width: "32px",
                        height: "32px",
                        borderRadius: "50%",
                        background: "rgba(41,151,255,0.1)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "14px",
                        fontWeight: 700,
                        color: "var(--color-accent-blue)"
                      }}>
                        {dom.domain[0].toUpperCase()}
                      </div>
                      <div>
                        <h4 style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
                          {dom.domain}
                        </h4>
                        <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--color-text-secondary)", flexWrap: "wrap" }}>
                          Template: {dom.template.toUpperCase()}
                          {/* A dropped domain with no live link profile is worth nothing, and
                              that is cheaper to learn here than after a network points at it. */}
                          <DomainHealthChip domain={dom.domain} compact />
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(dom.id)}
                      style={{
                        padding: "6px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--color-text-tertiary)",
                        borderRadius: "6px",
                        transition: "all 0.15s"
                      }}
                      onMouseOver={e => { e.currentTarget.style.color = "var(--color-accent-red)"; e.currentTarget.style.background = "rgba(255,69,58,0.06)"; }}
                      onMouseOut={e => { e.currentTarget.style.color = "var(--color-text-tertiary)"; e.currentTarget.style.background = "transparent"; }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>

                  {/* API Key Box */}
                  <div style={{
                    background: "var(--color-bg)",
                    borderRadius: "8px",
                    padding: "8px 12px",
                    border: "1px solid var(--color-border-soft)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "10px"
                  }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", fontWeight: 700, letterSpacing: "0.05em" }}>
                        SCRIPT API KEY
                      </span>
                      <code style={{ fontSize: "11px", color: "var(--color-text-primary)", fontFamily: "monospace" }}>
                        {showKey ? dom.apiKey : "••••••••••••••••••••••••••••••••"}
                      </code>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <button
                        onClick={() => toggleShowKey(dom.id)}
                        style={{ background: "transparent", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px" }}
                      >
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button
                        onClick={() => handleCopy(dom.apiKey)}
                        style={{ background: "transparent", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px" }}
                      >
                        {copiedKey === dom.apiKey ? <Check size={14} color="#34C759" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* Metrics & Redirect info */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
                    <div>
                      Pages generated: <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{dom.pagesCount}</span>
                    </div>
                    <div>
                      Subdomains: <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{dom.subdomainsCount}</span>
                    </div>
                    {dom.moneyUrl && (
                      <div style={{ gridColumn: "1 / span 2" }}>
                        Cloaking target: <span style={{ fontWeight: 600, color: "var(--color-accent-green)" }}>{dom.moneyUrl}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
