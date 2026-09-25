// Server-side i18n for Telegram/Slack notifications (alerts + digests). The browser's
// LanguageProvider can't help here — schedulers run headless — so the UI saves the
// user's current language into alertSettings/digestSettings and the templates below
// render in that language. Same locales as the app: en / ru / uk / fr / es / de / zh.

import type { UptimeCause } from "@/lib/uptime/types";

export type NotifyLang = "en" | "ru" | "uk" | "fr" | "es" | "de" | "zh";

export const normalizeLang = (v: unknown): NotifyLang =>
  v === "ru" || v === "uk" || v === "fr" || v === "es" || v === "de" || v === "zh" ? v : "en";

type Tpl = {
  // alerts
  rankDropTitle: (kw: string) => string;
  rankDropMsg: (site: string, kw: string, country: string, drop: number, from: number | null, to: number | null) => string;
  trafficDropTitle: (site: string) => string;
  trafficDropMsg: (site: string, pct: number, from: number, to: number) => string;
  sslTitle: (site: string) => string;
  sslMsg: (site: string, days: number) => string;
  auditTitle: (site: string) => string;
  auditMsg: (site: string, score: number, bad: number, total: number) => string;
  lostLinkTitle: (site: string) => string;
  lostLinkMsg: (site: string, count: number, domains: string, minDr: number) => string;
  // digest
  digestTitleAll: string;
  digestTitleTag: (tag: string) => string;
  digestWindow: (days: number, date: string) => string;
  digestRange: (from: string, to: string) => string;
  digestPrevRange: (from: string, to: string) => string;
  digestMore: (n: number) => string;
  digestNoSitesTag: (tag: string) => string;
  digestNoSites: string;
  totalClicks: (cur: number, delta: string) => string;
  moreSites: (n: number) => string;
  winners: string;
  losers: string;
  rankMoves: string;
  aiSummary: string;
  unitClicks: string;
  unitImpr: string;
  allTime: string;
  portfolio: (n: number, up: number, down: number) => string;
  clicksLine: (cur: string, delta: string, impr: string, imprDelta: string) => string;
  topGainers: string;
  topLosers: string;
  strikingHdr: (n: number) => string;
  strikingRow: (kw: string, site: string, pos: string, impr: string) => string;
  attentionHdr: string;
  attentionDrop: (site: string, pct: number) => string;
  engineHdr: (name: string) => string;
  engineTotals: (clicks: string, impr: string) => string;
  engineTopSite: (name: string, clicks: string, impr: string) => string;
  // backlinks digest + alerts
  dglSectionTitle: string;
  dglNew: string;
  dglLost: string;
  dglNet: string;
  dglFavoriteLost: (links: string) => string;
  dglFavoriteDowngraded: (links: string) => string;
  dglRelDowngrade: (n: number) => string;
  dglTopLossDomains: (list: string) => string;
  dglAnomaly: string;
  dglAnomalyHint: (n: number, x: string) => string;
  dglBaselineBuilding: string;
  dglNoFullExport: string;
  dglNoChange: string;
  dglWhatLost: string;
  dglWhatDowngraded: string;
  dglWhatTargetChanged: string;
  alertBacklinkLossTitle: (site: string) => string;
  alertBacklinkLossBody: (n: number, x: string) => string;
  alertFavoriteLinkTitle: (site: string) => string;
  alertFavoriteLinkBody: (url: string, what: string) => string;
  balanceLowTitle: (provider: string) => string;
  balanceLowMsg: (provider: string, left: string, pct: number | null) => string;
  providerDownTitle: (provider: string) => string;
  providerDownMsg: (provider: string, failures: number) => string;
  // drops watch: a watched domain became free
  dropsWatchTitle: (n: number) => string;
  dropsWatchRow: (domain: string, dr: string, refs: string) => string;
  // serp monitor: a run shook the SERP harder than the project's own baseline
  serpmonStormTitle: (project: string) => string;
  serpmonStormScore: (score: string, share: string) => string;
  serpmonStormKeywords: (list: string) => string;
  serpmonStormHosts: (list: string) => string;
  serpmonTestPrefix: string;
  // wave-oct (CONTRACT.md §8): uptime monitor, index losses, brand mentions, channel tests.
  // `dur` arguments are pre-formatted by formatDuration below ("12 min", "2 ч 5 мин").
  uptimeDownTitle: (site: string) => string;
  uptimeDownMsg: (site: string, url: string, cause: string, since: string) => string;
  uptimeStillDownMsg: (site: string, dur: string) => string;
  uptimeUpTitle: (site: string) => string;
  uptimeUpMsg: (site: string, dur: string) => string;
  uptimeDegradedMsg: (site: string, ms: number) => string;
  uptimeCause: (code: UptimeCause, http: number | null) => string;
  indexLossTitle: (site: string) => string;
  indexLossMsg: (site: string, n: number, lines: string) => string;
  mentionsNotifyTitle: (site: string) => string;
  mentionsNotifyMsg: (site: string, n: number, lines: string) => string;
  notifyTestMsg: (channel: string) => string;
};

// Downtime formatting for push messages: the two most significant non-zero units of
// d/h/min/s, so "12 мин" fits where "12 minutes 0 seconds" would wrap.
const DUR_UNITS: Record<NotifyLang, { d: string; h: string; min: string; s: string }> = {
  en: { d: "d",   h: "h",   min: "min", s: "s" },
  ru: { d: "д",   h: "ч",   min: "мин", s: "с" },
  uk: { d: "д",   h: "год", min: "хв",  s: "с" },
  fr: { d: "j",   h: "h",   min: "min", s: "s" },
  es: { d: "d",   h: "h",   min: "min", s: "s" },
  de: { d: "d",   h: "h",   min: "min", s: "s" },
  zh: { d: "天",  h: "小时", min: "分钟", s: "秒" },
};

export function formatDuration(ms: number, lang: NotifyLang): string {
  const u = DUR_UNITS[lang];
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts: { n: number; unit: string }[] = [];
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const min = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d) parts.push({ n: d, unit: u.d });
  if (h) parts.push({ n: h, unit: u.h });
  if (min) parts.push({ n: min, unit: u.min });
  if (s) parts.push({ n: s, unit: u.s });
  const top = parts.slice(0, 2);
  if (!top.length) return `0 ${u.s}`;
  return top.map(p => `${p.n} ${p.unit}`).join(" ");
}

export const NOTIFY_L: Record<NotifyLang, Tpl> = {
  en: {
    rankDropTitle: kw => `📉 Rank drop: ${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — "${kw}" (${country}) fell ${drop} positions: ${from} → ${to}.`,
    trafficDropTitle: site => `🔻 Traffic drop: ${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — clicks down ${pct}% week-over-week: ${from} → ${to}.`,
    sslTitle: site => `🔒 SSL expiring: ${site}`,
    sslMsg: (site, days) => `*${site}* — SSL certificate expires in ${days} day(s). Renew it (certbot renew / check auto-renewal).`,
    lostLinkTitle: site => `🔗 Lost backlinks: ${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — ${count} referring domain(s) with DR ≥ ${minDr} disappeared: ${domains}.`,
    auditTitle: site => `🩺 Low audit score: ${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — site audit health score is ${score}/100 (${bad}/${total} pages with issues). Check the Audit tab.`,
    digestTitleAll: "📊 OpenGSC digest — all sites",
    digestTitleTag: tag => `📊 OpenGSC digest — tag "${tag}"`,
    digestWindow: (days, date) => `_Last ${days} days vs previous ${days} days · ${date}_`,
    digestRange: (from, to) => `_Period: ${from} — ${to}_`,
    digestPrevRange: (from, to) => `_vs ${from} — ${to}_`,
    digestMore: n => `…and ${n} more`,
    digestNoSitesTag: tag => `No sites carry the tag "${tag}".`,
    digestNoSites: "No sites connected yet.",
    totalClicks: (cur, delta) => `*Total clicks:* ${cur} (${delta} vs prev)`,
    moreSites: n => `…and ${n} more sites`,
    winners: "*🏆 Winner queries:*",
    losers: "*⚠️ Loser queries:*",
    rankMoves: "*📍 Rank movements:*",
    aiSummary: "🤖 *AI summary:*",
    unitClicks: "clicks",
    unitImpr: "impressions",
    allTime: "all time",
    portfolio: (n, up, down) => `*Portfolio:* ${n} sites · 🟢 ${up} up · 🔴 ${down} down`,
    clicksLine: (cur, delta, impr, imprDelta) => `*Clicks:* ${cur} (${delta}) · *Impressions:* ${impr} (${imprDelta})`,
    topGainers: "*📈 Biggest gainers (sites):*",
    topLosers: "*📉 Biggest drops (sites):*",
    strikingHdr: n => `*🎯 Striking distance (pos 4–20): ${n} keywords*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · pos ${pos} · ${impr} impr`,
    attentionHdr: "*🚨 Needs attention:*",
    attentionDrop: (site, pct) => `  ${site} — traffic down ${pct}%`,
    engineHdr: name => `*🔎 ${name} (live):*`,
    engineTotals: (clicks, impr) => `  ${clicks} clicks · ${impr} impressions`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} clicks · ${impr} impr`,
    dglSectionTitle: "*🔗 Links:*",
    dglNew: "new links",
    dglLost: "lost links",
    dglNet: "net change",
    dglFavoriteLost: links => `  ⭐ Favourite links lost: ${links}`,
    dglFavoriteDowngraded: links => `  ⭐ Favourite links downgraded to nofollow: ${links}`,
    dglRelDowngrade: n => `  ${n} links became nofollow / sponsored / ugc`,
    dglTopLossDomains: list => `  Most losses by donor domain: ${list}`,
    dglAnomaly: "  🚨 Unusual link loss",
    dglAnomalyHint: (n, x) => `  ${n} links lost — ${x}× the usual rate for this period.`,
    dglBaselineBuilding: "  Not enough history yet to judge link losses — collecting a baseline.",
    dglNoFullExport: "  No complete backlink export yet, so losses are not reported.",
    dglNoChange: "  No link changes this period.",
    dglWhatLost: "the link is gone",
    dglWhatDowngraded: "downgraded to nofollow / sponsored / ugc",
    dglWhatTargetChanged: "now points somewhere else",
    alertBacklinkLossTitle: site => `🔗 Unusual backlink loss on ${site}`,
    alertBacklinkLossBody: (n, x) => `${n} backlinks lost since the last check — ${x}× the usual rate.`,
    alertFavoriteLinkTitle: site => `⭐ A favourite link changed on ${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 Low balance: ${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}*: ${left} left (${pct}% of the limit).` : `*${provider}*: ${left} left.`,
    providerDownTitle: provider => `🚨 Provider down: ${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* failed ${n}× in the last hour.`,
    dropsWatchTitle: (n) => `\u{1F3AF} Watched domain${n > 1 ? "s" : ""} freed (${n}):`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}, refdomains ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} SERP storm: ${p}`,
    serpmonStormScore: (score, share) => `Storm score ${score} \u00B7 ${share} of keywords above their usual churn`,
    serpmonStormKeywords: list => `Most shaken keywords: ${list}`,
    serpmonStormHosts: list => `Most entries and exits: ${list}`,
    serpmonTestPrefix: "\u{1F9EA} TEST \u2014 fabricated data, not a real storm:",
    uptimeDownTitle: site => `\u{1F534} ${site} is down`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* is not responding.\nURL: ${url}\nReason: ${cause}\nSince: ${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* is still down (${dur}).`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} is back`,
    uptimeUpMsg: (site, dur) => `*${site}* is responding again. Downtime: ${dur}.`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* is slow: ${ms} ms.`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "timeout";
        case "dns": return "DNS error";
        case "tls": return "SSL/TLS error";
        case "connect": return "connection refused";
        case "http_status": return http != null ? `HTTP ${http}` : "error";
        case "keyword_missing": return "expected text not found";
        case "redirect_loop": return "redirect loop";
        case "blocked_target": return "address not allowed";
        default: return "error";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site}: pages left Google's index`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} page(s) with traffic are no longer indexed:\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} New mentions of ${site}`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 ${n} new mention(s):\n${lines}`,
    notifyTestMsg: channel => `\u2705 OpenGSC test message via ${channel}.`,
  },
  ru: {
    rankDropTitle: kw => `📉 Падение позиции: ${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — «${kw}» (${country}) упал на ${drop} позиций: ${from} → ${to}.`,
    trafficDropTitle: site => `🔻 Просадка трафика: ${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — клики упали на ${pct}% неделя к неделе: ${from} → ${to}.`,
    sslTitle: site => `🔒 Истекает SSL: ${site}`,
    sslMsg: (site, days) => `*${site}* — SSL-сертификат истекает через ${days} дн. Продлите его (certbot renew / проверьте автопродление).`,
    lostLinkTitle: site => `🔗 Потеряны ссылки: ${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — пропало ссылающихся доменов с DR ≥ ${minDr}: ${count} (${domains}).`,
    auditTitle: site => `🩺 Низкий балл аудита: ${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — health score аудита ${score}/100 (${bad}/${total} страниц с проблемами). Загляните во вкладку Аудит.`,
    digestTitleAll: "📊 Дайджест OpenGSC — все сайты",
    digestTitleTag: tag => `📊 Дайджест OpenGSC — тег «${tag}»`,
    digestWindow: (days, date) => `_Последние ${days} дн. vs предыдущие ${days} дн. · ${date}_`,
    digestRange: (from, to) => `_Период: ${from} — ${to}_`,
    digestPrevRange: (from, to) => `_в сравнении с ${from} — ${to}_`,
    digestMore: n => `…ещё ${n}`,
    digestNoSitesTag: tag => `Нет сайтов с тегом «${tag}».`,
    digestNoSites: "Сайты ещё не подключены.",
    totalClicks: (cur, delta) => `*Всего кликов:* ${cur} (${delta} к пред. периоду)`,
    moreSites: n => `…и ещё ${n} сайтов`,
    winners: "*🏆 Выросшие запросы:*",
    losers: "*⚠️ Упавшие запросы:*",
    rankMoves: "*📍 Движения позиций:*",
    aiSummary: "🤖 *AI-выжимка:*",
    unitClicks: "кликов",
    unitImpr: "показов",
    allTime: "всё время",
    portfolio: (n, up, down) => `*Портфель:* ${n} сайтов · 🟢 ${up} вверх · 🔴 ${down} вниз`,
    clicksLine: (cur, delta, impr, imprDelta) => `*Клики:* ${cur} (${delta}) · *Показы:* ${impr} (${imprDelta})`,
    topGainers: "*📈 Сильнее всего выросли (сайты):*",
    topLosers: "*📉 Сильнее всего просели (сайты):*",
    strikingHdr: n => `*🎯 На пороге топ-10 (поз. 4–20): ${n} запросов*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · поз ${pos} · ${impr} показов`,
    attentionHdr: "*🚨 Требуют внимания:*",
    attentionDrop: (site, pct) => `  ${site} — трафик упал на ${pct}%`,
    engineHdr: name => `*🔎 ${name} (живые данные):*`,
    engineTotals: (clicks, impr) => `  ${clicks} кликов · ${impr} показов`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} кликов · ${impr} показов`,
    dglSectionTitle: "*🔗 Ссылки:*",
    dglNew: "новых",
    dglLost: "потеряно",
    dglNet: "итого",
    dglFavoriteLost: links => `  ⭐ Потеряны избранные ссылки: ${links}`,
    dglFavoriteDowngraded: links => `  ⭐ Избранные ссылки стали nofollow: ${links}`,
    dglRelDowngrade: n => `  ссылок стали nofollow / sponsored / ugc: ${n}`,
    dglTopLossDomains: list => `  Больше всего потерь у доноров: ${list}`,
    dglAnomaly: "  🚨 Необычная потеря ссылок",
    dglAnomalyHint: (n, x) => `  Потеряно ссылок: ${n} — это ${x}× от обычного за такой период.`,
    dglBaselineBuilding: "  Истории пока мало, судить о потерях рано — набираем базовую линию.",
    dglNoFullExport: "  Полной выгрузки ссылок ещё не было, поэтому потери не считаем.",
    dglNoChange: "  Изменений по ссылкам за период нет.",
    dglWhatLost: "ссылка пропала",
    dglWhatDowngraded: "стала nofollow / sponsored / ugc",
    dglWhatTargetChanged: "теперь ведёт на другую страницу",
    alertBacklinkLossTitle: site => `🔗 Необычная потеря ссылок: ${site}`,
    alertBacklinkLossBody: (n, x) => `С прошлой проверки потеряно ссылок: ${n} — это ${x}× от обычного.`,
    alertFavoriteLinkTitle: site => `⭐ Изменилась избранная ссылка: ${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 Низкий баланс: ${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}*: осталось ${left} (${pct}% от лимита).` : `*${provider}*: осталось ${left}.`,
    providerDownTitle: provider => `🚨 Провайдер лежит: ${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* — ${n} ошибок за последний час.`,
    dropsWatchTitle: (n) => `\u{1F3AF} Домены со списка наблюдения освободились (${n}):`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}, реферальных доменов ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} SERP-шторм: ${p}`,
    serpmonStormScore: (score, share) => `Сила шторма ${score} \u00B7 ${share} запросов выше обычной тряски`,
    serpmonStormKeywords: list => `Сильнее всего трясло: ${list}`,
    serpmonStormHosts: list => `Больше всего входов и выходов: ${list}`,
    serpmonTestPrefix: "\u{1F9EA} ТЕСТ \u2014 выдуманные данные, не настоящий шторм:",
    uptimeDownTitle: site => `\u{1F534} ${site} недоступен`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* не отвечает.\nURL: ${url}\nПричина: ${cause}\nС: ${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* всё ещё недоступен (${dur}).`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} снова работает`,
    uptimeUpMsg: (site, dur) => `*${site}* снова отвечает. Простой: ${dur}.`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* отвечает медленно: ${ms} мс.`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "таймаут";
        case "dns": return "ошибка DNS";
        case "tls": return "ошибка SSL/TLS";
        case "connect": return "соединение отклонено";
        case "http_status": return http != null ? `HTTP ${http}` : "ошибка";
        case "keyword_missing": return "нет ожидаемого текста";
        case "redirect_loop": return "цикл редиректов";
        case "blocked_target": return "адрес запрещён";
        default: return "ошибка";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site}: страницы выпали из индекса Google`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} стр. с трафиком больше не в индексе:\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} Новые упоминания ${site}`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 новых упоминаний: ${n}\n${lines}`,
    notifyTestMsg: channel => `\u2705 Тестовое сообщение OpenGSC через ${channel}.`,
  },
  uk: {
    rankDropTitle: kw => `📉 Падіння позиції: ${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — «${kw}» (${country}) впав на ${drop} позицій: ${from} → ${to}.`,
    trafficDropTitle: site => `🔻 Просідання трафіку: ${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — кліки впали на ${pct}% тиждень до тижня: ${from} → ${to}.`,
    sslTitle: site => `🔒 Спливає SSL: ${site}`,
    sslMsg: (site, days) => `*${site}* — SSL-сертифікат спливає через ${days} дн. Подовжте його (certbot renew / перевірте автоподовження).`,
    lostLinkTitle: site => `🔗 Втрачено посилання: ${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — зникло доменів з DR ≥ ${minDr}: ${count} (${domains}).`,
    auditTitle: site => `🩺 Низький бал аудиту: ${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — health score аудиту ${score}/100 (${bad}/${total} сторінок із проблемами). Перегляньте вкладку Аудит.`,
    digestTitleAll: "📊 Дайджест OpenGSC — всі сайти",
    digestTitleTag: tag => `📊 Дайджест OpenGSC — тег «${tag}»`,
    digestWindow: (days, date) => `_Останні ${days} дн. vs попередні ${days} дн. · ${date}_`,
    digestRange: (from, to) => `_Період: ${from} — ${to}_`,
    digestPrevRange: (from, to) => `_у порівнянні з ${from} — ${to}_`,
    digestMore: n => `…ще ${n}`,
    digestNoSitesTag: tag => `Немає сайтів із тегом «${tag}».`,
    digestNoSites: "Сайти ще не підключені.",
    totalClicks: (cur, delta) => `*Всього кліків:* ${cur} (${delta} до попер. періоду)`,
    moreSites: n => `…і ще ${n} сайтів`,
    winners: "*🏆 Запити, що виросли:*",
    losers: "*⚠️ Запити, що впали:*",
    rankMoves: "*📍 Рухи позицій:*",
    aiSummary: "🤖 *AI-вижимка:*",
    unitClicks: "кліків",
    unitImpr: "показів",
    allTime: "весь час",
    portfolio: (n, up, down) => `*Портфель:* ${n} сайтів · 🟢 ${up} вгору · 🔴 ${down} вниз`,
    clicksLine: (cur, delta, impr, imprDelta) => `*Кліки:* ${cur} (${delta}) · *Покази:* ${impr} (${imprDelta})`,
    topGainers: "*📈 Найбільше зросли (сайти):*",
    topLosers: "*📉 Найбільше просіли (сайти):*",
    strikingHdr: n => `*🎯 На порозі топ-10 (поз. 4–20): ${n} запитів*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · поз ${pos} · ${impr} показів`,
    attentionHdr: "*🚨 Потребують уваги:*",
    attentionDrop: (site, pct) => `  ${site} — трафік впав на ${pct}%`,
    engineHdr: name => `*🔎 ${name} (живі дані):*`,
    engineTotals: (clicks, impr) => `  ${clicks} кліків · ${impr} показів`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} кліків · ${impr} показів`,
    dglSectionTitle: "*🔗 Посилання:*",
    dglNew: "нових",
    dglLost: "втрачено",
    dglNet: "разом",
    dglFavoriteLost: links => `  ⭐ Втрачено обрані посилання: ${links}`,
    dglFavoriteDowngraded: links => `  ⭐ Обрані посилання стали nofollow: ${links}`,
    dglRelDowngrade: n => `  посилань стали nofollow / sponsored / ugc: ${n}`,
    dglTopLossDomains: list => `  Найбільше втрат у донорів: ${list}`,
    dglAnomaly: "  🚨 Незвична втрата посилань",
    dglAnomalyHint: (n, x) => `  Втрачено посилань: ${n} — це ${x}× від звичайного за такий період.`,
    dglBaselineBuilding: "  Історії ще мало, судити про втрати зарано — збираємо базову лінію.",
    dglNoFullExport: "  Повного вивантаження посилань ще не було, тому втрати не рахуємо.",
    dglNoChange: "  Змін за посиланнями за період немає.",
    dglWhatLost: "посилання зникло",
    dglWhatDowngraded: "стало nofollow / sponsored / ugc",
    dglWhatTargetChanged: "тепер веде на іншу сторінку",
    alertBacklinkLossTitle: site => `🔗 Незвична втрата посилань: ${site}`,
    alertBacklinkLossBody: (n, x) => `З минулої перевірки втрачено посилань: ${n} — це ${x}× від звичайного.`,
    alertFavoriteLinkTitle: site => `⭐ Змінилося обране посилання: ${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 Низький баланс: ${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}*: залишилось ${left} (${pct}% від ліміту).` : `*${provider}*: залишилось ${left}.`,
    providerDownTitle: provider => `🚨 Провайдер лежить: ${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* — ${n} помилок за останню годину.`,
    dropsWatchTitle: (n) => `\u{1F3AF} Домени зі списку спостереження звільнилися (${n}):`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}, реферальних доменів ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} SERP-шторм: ${p}`,
    serpmonStormScore: (score, share) => `Сила шторму ${score} \u00B7 ${share} запитів вище звичайної тряски`,
    serpmonStormKeywords: list => `Найсильніше трусило: ${list}`,
    serpmonStormHosts: list => `Найбільше входів і виходів: ${list}`,
    serpmonTestPrefix: "\u{1F9EA} ТЕСТ \u2014 вигадані дані, не справжній шторм:",
    uptimeDownTitle: site => `\u{1F534} ${site} недоступний`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* не відповідає.\nURL: ${url}\nПричина: ${cause}\nЗ: ${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* досі недоступний (${dur}).`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} знову працює`,
    uptimeUpMsg: (site, dur) => `*${site}* знову відповідає. Простій: ${dur}.`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* відповідає повільно: ${ms} мс.`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "таймаут";
        case "dns": return "помилка DNS";
        case "tls": return "помилка SSL/TLS";
        case "connect": return "з'єднання відхилено";
        case "http_status": return http != null ? `HTTP ${http}` : "помилка";
        case "keyword_missing": return "немає очікуваного тексту";
        case "redirect_loop": return "цикл редиректів";
        case "blocked_target": return "адресу заборонено";
        default: return "помилка";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site}: сторінки випали з індексу Google`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} стор. з трафіком більше не в індексі:\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} Нові згадки ${site}`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 нових згадок: ${n}\n${lines}`,
    notifyTestMsg: channel => `\u2705 Тестове повідомлення OpenGSC через ${channel}.`,
  },
  fr: {
    rankDropTitle: kw => `📉 Chute de position : ${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — « ${kw} » (${country}) a chuté de ${drop} positions : ${from} → ${to}.`,
    trafficDropTitle: site => `🔻 Chute de trafic : ${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — clics en baisse de ${pct} % d'une semaine à l'autre : ${from} → ${to}.`,
    sslTitle: site => `🔒 SSL expirant : ${site}`,
    sslMsg: (site, days) => `*${site}* — le certificat SSL expire dans ${days} jour(s). Renouvelez-le (certbot renew / vérifiez le renouvellement auto).`,
    lostLinkTitle: site => `🔗 Backlinks perdus : ${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — ${count} domaine(s) référent(s) avec DR ≥ ${minDr} ont disparu : ${domains}.`,
    auditTitle: site => `🩺 Score d'audit bas : ${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — le score de santé de l'audit est de ${score}/100 (${bad}/${total} pages avec des problèmes). Voir l'onglet Audit.`,
    digestTitleAll: "📊 Résumé OpenGSC — tous les sites",
    digestTitleTag: tag => `📊 Résumé OpenGSC — étiquette « ${tag} »`,
    digestWindow: (days, date) => `_Les ${days} derniers jours vs les ${days} jours précédents · ${date}_`,
    digestRange: (from, to) => `_Période : ${from} — ${to}_`,
    digestPrevRange: (from, to) => `_vs ${from} — ${to}_`,
    digestMore: n => `…et ${n} de plus`,
    digestNoSitesTag: tag => `Aucun site ne porte l'étiquette « ${tag} ».`,
    digestNoSites: "Aucun site connecté pour le moment.",
    totalClicks: (cur, delta) => `*Total des clics :* ${cur} (${delta} vs préc.)`,
    moreSites: n => `…et ${n} sites de plus`,
    winners: "*🏆 Requêtes gagnantes :*",
    losers: "*⚠️ Requêtes en perte :*",
    rankMoves: "*📍 Mouvements de position :*",
    aiSummary: "🤖 *Synthèse IA :*",
    unitClicks: "clics",
    unitImpr: "impressions",
    allTime: "depuis toujours",
    portfolio: (n, up, down) => `*Portefeuille :* ${n} sites · 🟢 ${up} en hausse · 🔴 ${down} en baisse`,
    clicksLine: (cur, delta, impr, imprDelta) => `*Clics :* ${cur} (${delta}) · *Impressions :* ${impr} (${imprDelta})`,
    topGainers: "*📈 Plus fortes progressions (sites) :*",
    topLosers: "*📉 Plus fortes baisses (sites) :*",
    strikingHdr: n => `*🎯 Distance frappante (pos. 4–20) : ${n} mots-clés*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · pos ${pos} · ${impr} impr`,
    attentionHdr: "*🚨 À surveiller :*",
    attentionDrop: (site, pct) => `  ${site} — trafic en baisse de ${pct} %`,
    engineHdr: name => `*🔎 ${name} (en direct) :*`,
    engineTotals: (clicks, impr) => `  ${clicks} clics · ${impr} impressions`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} clics · ${impr} impr`,
    dglSectionTitle: "*🔗 Liens :*",
    dglNew: "nouveaux liens",
    dglLost: "liens perdus",
    dglNet: "variation nette",
    dglFavoriteLost: links => `  ⭐ Liens favoris perdus : ${links}`,
    dglFavoriteDowngraded: links => `  ⭐ Liens favoris passés en nofollow : ${links}`,
    dglRelDowngrade: n => `  ${n} liens sont passés en nofollow / sponsored / ugc`,
    dglTopLossDomains: list => `  Plus de pertes par domaine référent : ${list}`,
    dglAnomaly: "  🚨 Perte de liens inhabituelle",
    dglAnomalyHint: (n, x) => `  ${n} liens perdus — ${x}× le rythme habituel pour cette période.`,
    dglBaselineBuilding: "  Pas encore assez d'historique pour juger les pertes — constitution d'une référence.",
    dglNoFullExport: "  Aucun export complet des backlinks pour l'instant, les pertes ne sont donc pas rapportées.",
    dglNoChange: "  Aucun changement de liens sur cette période.",
    dglWhatLost: "le lien a disparu",
    dglWhatDowngraded: "passé en nofollow / sponsored / ugc",
    dglWhatTargetChanged: "pointe maintenant ailleurs",
    alertBacklinkLossTitle: site => `🔗 Perte de backlinks inhabituelle sur ${site}`,
    alertBacklinkLossBody: (n, x) => `${n} backlinks perdus depuis la dernière vérification — ${x}× le rythme habituel.`,
    alertFavoriteLinkTitle: site => `⭐ Un lien favori a changé sur ${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 Solde bas : ${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}* : ${left} restants (${pct}% de la limite).` : `*${provider}* : ${left} restants.`,
    providerDownTitle: provider => `🚨 Fournisseur en panne : ${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* a échoué ${n}× dans la dernière heure.`,
    dropsWatchTitle: (n) => `\u{1F3AF} Domaine${n > 1 ? "s" : ""} surveillé${n > 1 ? "s" : ""} libéré${n > 1 ? "s" : ""} (${n}) :`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}, domaines référents ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} Tempête SERP : ${p}`,
    serpmonStormScore: (score, share) => `Score de tempête ${score} \u00B7 ${share} des mots-clés au-dessus de leur agitation habituelle`,
    serpmonStormKeywords: list => `Mots-clés les plus secoués : ${list}`,
    serpmonStormHosts: list => `Plus d'entrées et de sorties : ${list}`,
    serpmonTestPrefix: "\u{1F9EA} TEST \u2014 données fictives, pas une vraie tempête :",
    uptimeDownTitle: site => `\u{1F534} ${site} est inaccessible`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* ne répond pas.\nURL : ${url}\nCause : ${cause}\nDepuis : ${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* est toujours inaccessible (${dur}).`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} est de retour`,
    uptimeUpMsg: (site, dur) => `*${site}* répond à nouveau. Indisponibilité : ${dur}.`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* est lent : ${ms} ms.`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "délai dépassé";
        case "dns": return "erreur DNS";
        case "tls": return "erreur SSL/TLS";
        case "connect": return "connexion refusée";
        case "http_status": return http != null ? `HTTP ${http}` : "erreur";
        case "keyword_missing": return "texte attendu introuvable";
        case "redirect_loop": return "boucle de redirection";
        case "blocked_target": return "adresse non autorisée";
        default: return "erreur";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site} : des pages ont quitté l'index de Google`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} page(s) avec du trafic ne sont plus indexées :\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} Nouvelles mentions de ${site}`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 ${n} nouvelle(s) mention(s) :\n${lines}`,
    notifyTestMsg: channel => `\u2705 Message de test OpenGSC via ${channel}.`,
  },
  es: {
    rankDropTitle: kw => `📉 Caída de posición: ${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — «${kw}» (${country}) cayó ${drop} posiciones: ${from} → ${to}.`,
    trafficDropTitle: site => `🔻 Caída de tráfico: ${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — los clics bajaron un ${pct} % semana contra semana: ${from} → ${to}.`,
    sslTitle: site => `🔒 SSL a punto de expirar: ${site}`,
    sslMsg: (site, days) => `*${site}* — el certificado SSL expira en ${days} día(s). Renuévalo (certbot renew / revisa la renovación automática).`,
    lostLinkTitle: site => `🔗 Backlinks perdidos: ${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — ${count} dominio(s) referente(s) con DR ≥ ${minDr} desaparecieron: ${domains}.`,
    auditTitle: site => `🩺 Puntaje de auditoría bajo: ${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — el puntaje de salud de la auditoría es ${score}/100 (${bad}/${total} páginas con problemas). Revisa la pestaña Auditoría.`,
    digestTitleAll: "📊 Resumen de OpenGSC — todos los sitios",
    digestTitleTag: tag => `📊 Resumen de OpenGSC — etiqueta «${tag}»`,
    digestWindow: (days, date) => `_Últimos ${days} días vs ${days} días anteriores · ${date}_`,
    digestRange: (from, to) => `_Periodo: ${from} — ${to}_`,
    digestPrevRange: (from, to) => `_vs ${from} — ${to}_`,
    digestMore: n => `…y ${n} más`,
    digestNoSitesTag: tag => `Ningún sitio lleva la etiqueta «${tag}».`,
    digestNoSites: "Aún no hay sitios conectados.",
    totalClicks: (cur, delta) => `*Clics totales:* ${cur} (${delta} vs prev.)`,
    moreSites: n => `…y ${n} sitios más`,
    winners: "*🏆 Consultas ganadoras:*",
    losers: "*⚠️ Consultas en pérdida:*",
    rankMoves: "*📍 Movimientos de posición:*",
    aiSummary: "🤖 *Resumen IA:*",
    unitClicks: "clics",
    unitImpr: "impresiones",
    allTime: "todo el tiempo",
    portfolio: (n, up, down) => `*Cartera:* ${n} sitios · 🟢 ${up} suben · 🔴 ${down} bajan`,
    clicksLine: (cur, delta, impr, imprDelta) => `*Clics:* ${cur} (${delta}) · *Impresiones:* ${impr} (${imprDelta})`,
    topGainers: "*📈 Mayores subidas (sitios):*",
    topLosers: "*📉 Mayores caídas (sitios):*",
    strikingHdr: n => `*🎯 Distancia de golpe (pos. 4–20): ${n} palabras clave*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · pos ${pos} · ${impr} impr`,
    attentionHdr: "*🚨 Requiere atención:*",
    attentionDrop: (site, pct) => `  ${site} — tráfico bajó un ${pct} %`,
    engineHdr: name => `*🔎 ${name} (en vivo):*`,
    engineTotals: (clicks, impr) => `  ${clicks} clics · ${impr} impresiones`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} clics · ${impr} impr`,
    dglSectionTitle: "*🔗 Enlaces:*",
    dglNew: "enlaces nuevos",
    dglLost: "enlaces perdidos",
    dglNet: "cambio neto",
    dglFavoriteLost: links => `  ⭐ Enlaces favoritos perdidos: ${links}`,
    dglFavoriteDowngraded: links => `  ⭐ Enlaces favoritos degradados a nofollow: ${links}`,
    dglRelDowngrade: n => `  ${n} enlaces pasaron a nofollow / sponsored / ugc`,
    dglTopLossDomains: list => `  Más pérdidas por dominio referente: ${list}`,
    dglAnomaly: "  🚨 Pérdida de enlaces inusual",
    dglAnomalyHint: (n, x) => `  ${n} enlaces perdidos — ${x}× el ritmo habitual para este periodo.`,
    dglBaselineBuilding: "  Aún no hay historial suficiente para juzgar las pérdidas — se está formando una línea base.",
    dglNoFullExport: "  Todavía no hay una exportación completa de backlinks, así que no se reportan pérdidas.",
    dglNoChange: "  Sin cambios de enlaces en este periodo.",
    dglWhatLost: "el enlace desapareció",
    dglWhatDowngraded: "pasó a nofollow / sponsored / ugc",
    dglWhatTargetChanged: "ahora apunta a otra página",
    alertBacklinkLossTitle: site => `🔗 Pérdida inusual de backlinks en ${site}`,
    alertBacklinkLossBody: (n, x) => `${n} backlinks perdidos desde la última revisión — ${x}× el ritmo habitual.`,
    alertFavoriteLinkTitle: site => `⭐ Cambió un enlace favorito en ${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 Saldo bajo: ${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}*: quedan ${left} (${pct}% del límite).` : `*${provider}*: quedan ${left}.`,
    providerDownTitle: provider => `🚨 Proveedor caído: ${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* falló ${n}× en la última hora.`,
    dropsWatchTitle: (n) => `\u{1F3AF} Dominio${n > 1 ? "s" : ""} vigilado${n > 1 ? "s" : ""} libre${n > 1 ? "s" : ""} (${n}):`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}, dominios de referencia ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} Tormenta SERP: ${p}`,
    serpmonStormScore: (score, share) => `Puntaje de tormenta ${score} \u00B7 ${share} de las consultas por encima de su agitación habitual`,
    serpmonStormKeywords: list => `Consultas más agitadas: ${list}`,
    serpmonStormHosts: list => `Más entradas y salidas: ${list}`,
    serpmonTestPrefix: "\u{1F9EA} PRUEBA \u2014 datos inventados, no es una tormenta real:",
    uptimeDownTitle: site => `\u{1F534} ${site} está caído`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* no responde.\nURL: ${url}\nMotivo: ${cause}\nDesde: ${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* sigue caído (${dur}).`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} vuelve a funcionar`,
    uptimeUpMsg: (site, dur) => `*${site}* vuelve a responder. Caída: ${dur}.`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* responde lento: ${ms} ms.`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "tiempo de espera agotado";
        case "dns": return "error de DNS";
        case "tls": return "error de SSL/TLS";
        case "connect": return "conexión rechazada";
        case "http_status": return http != null ? `HTTP ${http}` : "error";
        case "keyword_missing": return "no se encontró el texto esperado";
        case "redirect_loop": return "bucle de redirecciones";
        case "blocked_target": return "dirección no permitida";
        default: return "error";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site}: páginas salieron del índice de Google`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} página(s) con tráfico ya no están indexadas:\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} Nuevas menciones de ${site}`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 ${n} mención(es) nueva(s):\n${lines}`,
    notifyTestMsg: channel => `\u2705 Mensaje de prueba de OpenGSC vía ${channel}.`,
  },
  de: {
    rankDropTitle: kw => `📉 Positionsverlust: ${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — „${kw}" (${country}) fiel um ${drop} Positionen: ${from} → ${to}.`,
    trafficDropTitle: site => `🔻 Traffic-Einbruch: ${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — Klicks Woche-gegen-Woche um ${pct} % gefallen: ${from} → ${to}.`,
    sslTitle: site => `🔒 SSL läuft ab: ${site}`,
    sslMsg: (site, days) => `*${site}* — das SSL-Zertifikat läuft in ${days} Tag(en) ab. Erneuere es (certbot renew / Auto-Erneuerung prüfen).`,
    lostLinkTitle: site => `🔗 Verlorene Backlinks: ${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — ${count} verweisende Domain(s) mit DR ≥ ${minDr} sind verschwunden: ${domains}.`,
    auditTitle: site => `🩺 Niedrige Audit-Punktzahl: ${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — der Health-Score des Audits liegt bei ${score}/100 (${bad}/${total} Seiten mit Problemen). Siehe den Audit-Tab.`,
    digestTitleAll: "📊 OpenGSC-Übersicht — alle Websites",
    digestTitleTag: tag => `📊 OpenGSC-Übersicht — Tag „${tag}"`,
    digestWindow: (days, date) => `_Letzte ${days} Tage vs. vorherige ${days} Tage · ${date}_`,
    digestRange: (from, to) => `_Zeitraum: ${from} — ${to}_`,
    digestPrevRange: (from, to) => `_vs ${from} — ${to}_`,
    digestMore: n => `…und ${n} weitere`,
    digestNoSitesTag: tag => `Keine Website trägt den Tag „${tag}".`,
    digestNoSites: "Noch keine Websites verbunden.",
    totalClicks: (cur, delta) => `*Klicks gesamt:* ${cur} (${delta} vs. Vorperiode)`,
    moreSites: n => `…und ${n} weitere Websites`,
    winners: "*🏆 Gewinner-Queries:*",
    losers: "*⚠️ Verlierer-Queries:*",
    rankMoves: "*📍 Positionsveränderungen:*",
    aiSummary: "🤖 *KI-Zusammenfassung:*",
    unitClicks: "Klicks",
    unitImpr: "Impressionen",
    allTime: "gesamt",
    portfolio: (n, up, down) => `*Portfolio:* ${n} Websites · 🟢 ${up} aufwärts · 🔴 ${down} abwärts`,
    clicksLine: (cur, delta, impr, imprDelta) => `*Klicks:* ${cur} (${delta}) · *Impressionen:* ${impr} (${imprDelta})`,
    topGainers: "*📈 Größte Gewinner (Websites):*",
    topLosers: "*📉 Größte Verlierer (Websites):*",
    strikingHdr: n => `*🎯 Knapp davor (Pos. 4–20): ${n} Keywords*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · Pos ${pos} · ${impr} Impressionen`,
    attentionHdr: "*🚨 Erfordert Aufmerksamkeit:*",
    attentionDrop: (site, pct) => `  ${site} — Traffic um ${pct} % gefallen`,
    engineHdr: name => `*🔎 ${name} (live):*`,
    engineTotals: (clicks, impr) => `  ${clicks} Klicks · ${impr} Impressionen`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} Klicks · ${impr} Impressionen`,
    dglSectionTitle: "*🔗 Links:*",
    dglNew: "neue Links",
    dglLost: "verlorene Links",
    dglNet: "Nettoänderung",
    dglFavoriteLost: links => `  ⭐ Verlorene Favoriten-Links: ${links}`,
    dglFavoriteDowngraded: links => `  ⭐ Favoriten-Links auf nofollow herabgestuft: ${links}`,
    dglRelDowngrade: n => `  ${n} Links wurden nofollow / sponsored / ugc`,
    dglTopLossDomains: list => `  Die meisten Verluste nach verweisender Domain: ${list}`,
    dglAnomaly: "  🚨 Ungewöhnlicher Linkverlust",
    dglAnomalyHint: (n, x) => `  ${n} Links verloren — ${x}× so viel wie üblich in diesem Zeitraum.`,
    dglBaselineBuilding: "  Noch zu wenig Historie, um Linkverluste zu beurteilen — die Basislinie wird erst gesammelt.",
    dglNoFullExport: "  Noch kein vollständiger Backlink-Export, deshalb werden Verluste nicht gemeldet.",
    dglNoChange: "  Keine Linkänderungen in diesem Zeitraum.",
    dglWhatLost: "der Link ist weg",
    dglWhatDowngraded: "auf nofollow / sponsored / ugc herabgestuft",
    dglWhatTargetChanged: "zeigt jetzt woandershin",
    alertBacklinkLossTitle: site => `🔗 Ungewöhnlicher Backlink-Verlust bei ${site}`,
    alertBacklinkLossBody: (n, x) => `${n} Backlinks seit der letzten Prüfung verloren — ${x}× so viel wie üblich.`,
    alertFavoriteLinkTitle: site => `⭐ Ein Favoriten-Link hat sich geändert bei ${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 Niedriges Guthaben: ${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}*: ${left} übrig (${pct}% des Limits).` : `*${provider}*: ${left} übrig.`,
    providerDownTitle: provider => `🚨 Anbieter ausgefallen: ${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* ist in der letzten Stunde ${n}× fehlgeschlagen.`,
    dropsWatchTitle: (n) => `\u{1F3AF} \u00DCberwachte Domain${n > 1 ? "s" : ""} freigeworden (${n}):`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}, verweisende Domains ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} SERP-Sturm: ${p}`,
    serpmonStormScore: (score, share) => `Sturm-Score ${score} \u00B7 ${share} der Keywords über ihrer üblichen Unruhe`,
    serpmonStormKeywords: list => `Stärkst erschütterte Keywords: ${list}`,
    serpmonStormHosts: list => `Meiste Ein- und Austritte: ${list}`,
    serpmonTestPrefix: "\u{1F9EA} TEST \u2014 erfundene Daten, kein echter Sturm:",
    uptimeDownTitle: site => `\u{1F534} ${site} ist nicht erreichbar`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* antwortet nicht.\nURL: ${url}\nGrund: ${cause}\nSeit: ${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* ist immer noch nicht erreichbar (${dur}).`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} ist wieder da`,
    uptimeUpMsg: (site, dur) => `*${site}* antwortet wieder. Ausfall: ${dur}.`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* ist langsam: ${ms} ms.`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "Zeitüberschreitung";
        case "dns": return "DNS-Fehler";
        case "tls": return "SSL/TLS-Fehler";
        case "connect": return "Verbindung abgelehnt";
        case "http_status": return http != null ? `HTTP ${http}` : "Fehler";
        case "keyword_missing": return "erwarteter Text nicht gefunden";
        case "redirect_loop": return "Redirect-Schleife";
        case "blocked_target": return "Adresse nicht erlaubt";
        default: return "Fehler";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site}: Seiten haben Googles Index verlassen`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} Seite(n) mit Traffic sind nicht mehr indexiert:\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} Neue Erwähnungen von ${site}`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 ${n} neue Erwähnung(en):\n${lines}`,
    notifyTestMsg: channel => `\u2705 OpenGSC-Testnachricht über ${channel}.`,
  },
  zh: {
    rankDropTitle: kw => `📉 排名下降：${kw}`,
    rankDropMsg: (site, kw, country, drop, from, to) => `*${site}* — 「${kw}」（${country}）下降了 ${drop} 个名次：${from} → ${to}。`,
    trafficDropTitle: site => `🔻 流量下跌：${site}`,
    trafficDropMsg: (site, pct, from, to) => `*${site}* — 点击量周环比下降 ${pct}%：${from} → ${to}。`,
    sslTitle: site => `🔒 SSL 即将到期：${site}`,
    sslMsg: (site, days) => `*${site}* — SSL 证书将在 ${days} 天后到期。请续期（certbot renew / 检查自动续期）。`,
    lostLinkTitle: site => `🔗 外链丢失：${site}`,
    lostLinkMsg: (site, count, domains, minDr) => `*${site}* — 消失了 ${count} 个 DR ≥ ${minDr} 的引荐域名：${domains}。`,
    auditTitle: site => `🩺 审计分数偏低：${site}`,
    auditMsg: (site, score, bad, total) => `*${site}* — 站点审计健康分为 ${score}/100（${bad}/${total} 个页面存在问题）。请查看「审计」标签页。`,
    digestTitleAll: "📊 OpenGSC 摘要 —— 全部站点",
    digestTitleTag: tag => `📊 OpenGSC 摘要 —— 标签「${tag}」`,
    digestWindow: (days, date) => `_最近 ${days} 天 vs 前 ${days} 天 · ${date}_`,
    digestRange: (from, to) => `_周期：${from} — ${to}_`,
    digestPrevRange: (from, to) => `_对比 ${from} — ${to}_`,
    digestMore: n => `…还有 ${n} 条`,
    digestNoSitesTag: tag => `没有站点带有「${tag}」标签。`,
    digestNoSites: "尚未连接任何站点。",
    totalClicks: (cur, delta) => `*总点击量：* ${cur}（${delta} 对比上一周期）`,
    moreSites: n => `…还有 ${n} 个站点`,
    winners: "*🏆 上涨关键词：*",
    losers: "*⚠️ 下跌关键词：*",
    rankMoves: "*📍 排名变动：*",
    aiSummary: "🤖 *AI 摘要：*",
    unitClicks: "点击",
    unitImpr: "展示",
    allTime: "全部时间",
    portfolio: (n, up, down) => `*投资组合：* ${n} 个站点 · 🟢 ${up} 上涨 · 🔴 ${down} 下跌`,
    clicksLine: (cur, delta, impr, imprDelta) => `*点击量：* ${cur}（${delta}） · *展示量：* ${impr}（${imprDelta}）`,
    topGainers: "*📈 涨幅最大（站点）：*",
    topLosers: "*📉 跌幅最大（站点）：*",
    strikingHdr: n => `*🎯 近距关键词（第 4–20 位）：${n} 个关键词*`,
    strikingRow: (kw, site, pos, impr) => `  ${kw} — ${site} · 第 ${pos} 位 · ${impr} 展示`,
    attentionHdr: "*🚨 需要关注：*",
    attentionDrop: (site, pct) => `  ${site} — 流量下跌 ${pct}%`,
    engineHdr: name => `*🔎 ${name}（实时）：*`,
    engineTotals: (clicks, impr) => `  ${clicks} 点击 · ${impr} 展示`,
    engineTopSite: (name, clicks, impr) => `  ${name} — ${clicks} 点击 · ${impr} 展示`,
    dglSectionTitle: "*🔗 外链：*",
    dglNew: "新增外链",
    dglLost: "丢失外链",
    dglNet: "净变化",
    dglFavoriteLost: links => `  ⭐ 丢失的重点外链：${links}`,
    dglFavoriteDowngraded: links => `  ⭐ 降为 nofollow 的重点外链：${links}`,
    dglRelDowngrade: n => `  ${n} 条外链变为 nofollow / sponsored / ugc`,
    dglTopLossDomains: list => `  丢失最多的来源域名：${list}`,
    dglAnomaly: "  🚨 外链异常丢失",
    dglAnomalyHint: (n, x) => `  丢失 ${n} 条外链 — 是该周期常规速率的 ${x}×。`,
    dglBaselineBuilding: "  历史数据还不够，暂时无法判断外链丢失 — 正在积累基准线。",
    dglNoFullExport: "  尚未完成完整的外链导出，因此不上报丢失。",
    dglNoChange: "  本周期外链无变化。",
    dglWhatLost: "链接已消失",
    dglWhatDowngraded: "降为 nofollow / sponsored / ugc",
    dglWhatTargetChanged: "现在指向其他页面",
    alertBacklinkLossTitle: site => `🔗 外链异常丢失：${site}`,
    alertBacklinkLossBody: (n, x) => `自上次检查以来丢失 ${n} 条外链 — 是常规速率的 ${x}×。`,
    alertFavoriteLinkTitle: site => `⭐ 重点外链发生变化：${site}`,
    alertFavoriteLinkBody: (url, what) => `${url} — ${what}`,
    balanceLowTitle: provider => `💸 余额不足：${provider}`,
    balanceLowMsg: (provider, left, pct) => pct != null ? `*${provider}*：剩余 ${left}（限额的 ${pct}%）。` : `*${provider}*：剩余 ${left}。`,
    providerDownTitle: provider => `🚨 服务商故障：${provider}`,
    providerDownMsg: (provider, n) => `*${provider}* 最近一小时失败 ${n} 次。`,
    dropsWatchTitle: (n) => `\u{1F3AF} \u76D1\u63A7\u7684\u57DF\u540D\u5DF2\u91CA\u653E\uFF08${n}\uFF09\uFF1A`,
    dropsWatchRow: (d, dr, refs) => `\u{1F7E2} ${d} \u2014 DR ${dr}\uFF0C\u53C2\u8003\u57DF ${refs}`,
    serpmonStormTitle: p => `\u{1F32A} SERP 风暴：${p}`,
    serpmonStormScore: (score, share) => `风暴强度 ${score} \u00B7 ${share} 的关键词波动高于平常`,
    serpmonStormKeywords: list => `波动最大的关键词：${list}`,
    serpmonStormHosts: list => `进入和退出最多：${list}`,
    serpmonTestPrefix: "\u{1F9EA} 测试 \u2014 模拟数据，并非真实风暴：",
    uptimeDownTitle: site => `\u{1F534} ${site} 已宕机`,
    uptimeDownMsg: (site, url, cause, since) => `*${site}* 无响应。\nURL：${url}\n原因：${cause}\n开始于：${since}`,
    uptimeStillDownMsg: (site, dur) => `*${site}* 仍然宕机（${dur}）。`,
    uptimeUpTitle: site => `\u{1F7E2} ${site} 已恢复`,
    uptimeUpMsg: (site, dur) => `*${site}* 已恢复响应。宕机时长：${dur}。`,
    uptimeDegradedMsg: (site, ms) => `\u{1F7E1} *${site}* 响应缓慢：${ms} 毫秒。`,
    uptimeCause: (code, http) => {
      switch (code) {
        case "timeout": return "超时";
        case "dns": return "DNS 错误";
        case "tls": return "SSL/TLS 错误";
        case "connect": return "连接被拒绝";
        case "http_status": return http != null ? `HTTP ${http}` : "错误";
        case "keyword_missing": return "未找到预期文本";
        case "redirect_loop": return "重定向循环";
        case "blocked_target": return "地址被禁止";
        default: return "错误";
      }
    },
    indexLossTitle: site => `\u{1F4C9} ${site}：页面掉出了 Google 索引`,
    indexLossMsg: (site, n, lines) => `*${site}* \u2014 ${n} 个有流量的页面不再被索引：\n${lines}`,
    mentionsNotifyTitle: site => `\u{1F4F0} ${site} 的新提及`,
    mentionsNotifyMsg: (site, n, lines) => `*${site}* \u2014 新提及 ${n} 条：\n${lines}`,
    notifyTestMsg: channel => `\u2705 OpenGSC 通过 ${channel} 发送的测试消息。`,
  },
};
