// Server-side i18n for Telegram/Slack notifications (alerts + digests). The browser's
// LanguageProvider can't help here — schedulers run headless — so the UI saves the
// user's current language into alertSettings/digestSettings and the templates below
// render in that language. Same three locales as the app: en / ru / uk.

export type NotifyLang = "en" | "ru" | "uk";

export const normalizeLang = (v: unknown): NotifyLang =>
  v === "ru" || v === "uk" ? v : "en";

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
};

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
  },
};
