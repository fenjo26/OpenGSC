// Issue #36 — the report language layer. A client report renders in the language chosen
// per report (ClientReport.lang), independently of the operator's dashboard language.
//
// This mirrors notifyI18n.ts on purpose: the frozen snapshot must never depend on the
// browser locale files (sections.ts §SECTION_TITLES_EN explains why), so the strings the
// client sees live here, server-side, one block per language. The operator's own UI
// (the editor, the section picker) keeps going through t()/repSection_* as before.
//
// ReportLang is NotifyLang: the same eight languages everywhere — alerts, digests,
// reports — so nl added for reports is also available for notifications and vice versa.

import type { NotifyLang } from "@/lib/notifyI18n";
import type { ReportSectionId } from "./sections";

export type ReportLang = NotifyLang;

export const normalizeReportLang = (v: unknown): ReportLang => {
  const s = typeof v === "string" ? v : "";
  return ["en", "ru", "uk", "fr", "es", "de", "zh", "nl"].includes(s) ? (s as ReportLang) : "en";
};

/** The dropdown in the report editor — native names, stable order, en first. */
export const REPORT_LANG_OPTIONS: { value: ReportLang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
  { value: "uk", label: "Українська" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "de", label: "Deutsch" },
  { value: "zh", label: "中文" },
  { value: "nl", label: "Nederlands" },
];

/** BCP-47 tag for Intl formatting and the <html lang> attribute of the snapshot. */
export const REPORT_HTML_LANG: Record<ReportLang, string> = {
  en: "en", ru: "ru", uk: "uk", fr: "fr", es: "es", de: "de", zh: "zh", nl: "nl",
};

/** Integer formatter per language (nl/de group with "." — the client reads 1.234, not 1,234). */
const intFmt = (tag: string) => {
  const nf = new Intl.NumberFormat(tag);
  return (n: number): string => nf.format(Math.round(n));
};
export const REPORT_FMT_INT: Record<ReportLang, (n: number) => string> = {
  en: intFmt("en-US"), ru: intFmt("ru-RU"), uk: intFmt("uk-UA"), fr: intFmt("fr-FR"),
  es: intFmt("es-ES"), de: intFmt("de-DE"), zh: intFmt("zh-CN"), nl: intFmt("nl-NL"),
};

// ─── the template surface ─────────────────────────────────────────────────────
// Everything the client can read in the snapshot, the PDF and the e-mail. Plain keys
// for labels, functions where English interpolates — same convention as notifyI18n.

export interface ReportTpl {
  sectionTitles: Record<ReportSectionId, string>;
  // traffic
  clicks: string;
  impressions: string;
  ctr: string;
  avgPosition: string;
  vsPrev: (x: string) => string;
  dailyClicks: string;
  svgClickTitle: (date: string, n: string) => string;
  gscDates: (from: string, to: string) => string;
  // tables
  query: string;
  page: string;
  change: string;
  // positions
  top3: string;
  top10: string;
  keyword: string;
  positionCol: string;
  improved: string;
  declined: string;
  notCheckedYet: string;
  /** "Last found: {t}" badge under a rank row — the timestamp of the last successful check. */
  rankFoundAt: (t: string) => string;
  /** The same badge when the keyword has never had a successful check. */
  rankNeverFound: string;
  // local
  location: string;
  organic: string;
  mapPack: string;
  inPack: (n: number) => string;
  inPackSummary: (n: string) => string;
  noLocalKw: string;
  napStatus: string;
  // indexing
  indexed: string;
  notIndexed: string;
  notInspected: string;
  sitemapUrls: string;
  sinceDelta: (sign: string, n: string, date: string) => string;
  asOf: (date: string) => string;
  // audit
  healthScore: string;
  pagesCrawled: string;
  pagesWithIssues: string;
  issue: string;
  severity: string;
  pages: string;
  noIssues: string;
  cwvTitle: (n: string) => string;
  lcp: string;
  inp: string;
  cls: string;
  perf: string;
  lastAudit: (date: string) => string;
  // uptime
  uptime: string;
  incidents: string;
  started: string;
  cause: string;
  duration: string;
  ongoing: string;
  minutes: (n: number) => string;
  noIncidents: string;
  monitoredUrl: (url: string) => string;
  // backlinks
  newLinks: string;
  lostLinks: string;
  avgDrNew: (drLabel: string) => string;
  newLinkFrom: string;
  anchor: string;
  blSource: (provider: string) => string;
  // AI visibility
  mentionShare: string;
  citationShare: string;
  answersAnalysed: string;
  domain: string;
  citations: string;
  trackedQuestions: (n: string, days: number) => string;
  // reviews
  newReviews: string;
  avgRating: string;
  anonymous: string;
  ratingOf5: (r: string) => string;
  // summary / steps / document
  priorityLabel: string;
  noData: string;
  noNotes: string;
  dirWithPrev: (sign: string, pct: number, cur: string, prev: string) => string;
  dirOnly: (cur: string) => string;
  bestGrowth: (kw: string, delta: string) => string;
  prioIndexDrop: (n: string) => string;
  prioKeywordsLost: (n: string, kw: string, tail: string) => string;
  tailNow: (pos: number) => string;
  notFoundTail: string;
  prioAudit: (n: string, code: string) => string;
  prioBacklinks: (n: string, provider: string) => string;
  prioUptime: (n: string, date: string, cause: string) => string;
  stepRecover: (kw: string, loc: string, from: string, to: string) => string;
  trackedWord: string;
  notFound: string;
  stepInspect: (n: string) => string;
  stepFix: (code: string, n: string) => string;
  stepDoubleDown: (kw: string, n: string) => string;
  daysPeriod: (n: number) => string;
  madeWith: (linked: string) => string;
  generatedAt: (date: string) => string;
  logoAlt: string;
  // e-mail envelope (mail.ts)
  mailPeriod: (from: string, to: string) => string;
  openReport: string;
}

export const REPORT_L: Record<ReportLang, ReportTpl> = {
  en: {
    sectionTitles: { summary: "Summary", traffic: "Traffic", queries: "Top queries", pages: "Top pages", positions: "Positions", local_positions: "Local visibility", indexing: "Indexing", audit: "Site audit", uptime: "Uptime", backlinks: "Backlinks", ai_visibility: "AI visibility", reviews: "Reviews", work_done: "What we did", next_steps: "Next steps" },
    clicks: "Clicks", impressions: "Impressions", ctr: "CTR", avgPosition: "Avg position",
    vsPrev: x => `vs prev: ${x}`,
    dailyClicks: "Daily clicks",
    svgClickTitle: (date, n) => `${date}: ${n} clicks`,
    gscDates: (from, to) => `Google Search Console data: ${from} — ${to} (Search Console reports with a ~2-day delay).`,
    query: "Query", page: "Page", change: "Change",
    top3: "Top 3", top10: "Top 10", keyword: "Keyword", positionCol: "Position", improved: "Improved", declined: "Declined",
    notCheckedYet: "Rank tracker has not checked these keywords yet.",
    rankFoundAt: t => `Last found: ${t}`,
    rankNeverFound: "Not found yet",
    location: "Location", organic: "Organic", mapPack: "Map pack",
    inPack: n => `#${n} in pack`,
    inPackSummary: n => `${n} keyword(s) inside the map pack (places 1–3).`,
    noLocalKw: "No location-tracked keywords yet",
    napStatus: "Citation status (NAP)",
    indexed: "Indexed", notIndexed: "Not indexed", notInspected: "Not inspected", sitemapUrls: "Sitemap URLs",
    sinceDelta: (sign, n, date) => `${sign}${n} since ${date}`,
    asOf: date => `As of ${date}.`,
    healthScore: "Health score", pagesCrawled: "Pages crawled", pagesWithIssues: "Pages with issues",
    issue: "Issue", severity: "Severity", pages: "Pages",
    noIssues: "No issues recorded",
    cwvTitle: n => `Core Web Vitals (sample of ${n})`,
    lcp: "LCP, s", inp: "INP, ms", cls: "CLS", perf: "Perf.",
    lastAudit: date => `Last audit: ${date}.`,
    uptime: "Uptime", incidents: "Incidents", started: "Started", cause: "Cause", duration: "Duration",
    ongoing: "ongoing",
    minutes: n => `${n} min`,
    noIncidents: "No incidents in this period.",
    monitoredUrl: url => `Monitored URL: ${url}`,
    newLinks: "New links", lostLinks: "Lost links",
    avgDrNew: dr => `Avg ${dr} of new donors`,
    newLinkFrom: "New link from", anchor: "Anchor",
    blSource: p => `Source: ${p} link index. New = links the provider first saw during this period; lost = links it reported lost during this period. Figures from other link indexes will differ.`,
    mentionShare: "Mention share", citationShare: "Citation share", answersAnalysed: "Answers analysed",
    domain: "Domain", citations: "Citations",
    trackedQuestions: (n, d) => `${n} tracked question(s), last ${d} days.`,
    newReviews: "New reviews", avgRating: "Average rating",
    anonymous: "Anonymous",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Priority:",
    noData: "No data for this period",
    noNotes: "No notes for this period",
    dirWithPrev: (sign, pct, cur, prev) => `Clicks ${sign}${pct}% vs the previous period (${cur} vs ${prev}).`,
    dirOnly: cur => `${cur} clicks this period.`,
    bestGrowth: (kw, delta) => `Best growth — “${kw}” (${delta} clicks).`,
    prioIndexDrop: n => `${n} page(s) dropped out of the Google index during the period.`,
    prioKeywordsLost: (n, kw, tail) => `${n} tracked keyword(s) lost positions — “${kw}” ${tail}.`,
    tailNow: pos => `now #${pos}`,
    notFoundTail: "no longer found",
    prioAudit: (n, code) => `Audit: ${n} page(s) with “${code}”.`,
    prioBacklinks: (n, p) => `${n} backlink(s) lost in this period (per ${p}).`,
    prioUptime: (n, date, cause) => `Uptime: ${n} incident(s), latest ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `Recover “${kw}”${loc} — ${from} → ${to}.`,
    trackedWord: "tracked",
    notFound: "not found",
    stepInspect: n => `Inspect the ${n} page(s) Google reports as not indexed.`,
    stepFix: (code, n) => `Fix “${code}” on ${n} page(s).`,
    stepDoubleDown: (kw, n) => `Double down on “${kw}” (+${n} clicks).`,
    daysPeriod: n => `(${n} days)`,
    madeWith: linked => `Made with ${linked}`,
    generatedAt: date => `Generated ${date}`,
    logoAlt: "logo",
    mailPeriod: (from, to) => `Period: ${from} — ${to}`,
    openReport: "Open the report",
  },
  ru: {
    sectionTitles: { summary: "Сводка", traffic: "Трафик", queries: "Топ-запросы", pages: "Топ-страницы", positions: "Позиции", local_positions: "Локальная видимость", indexing: "Индексация", audit: "Аудит сайта", uptime: "Аптайм", backlinks: "Обратные ссылки", ai_visibility: "Видимость в AI", reviews: "Отзывы", work_done: "Что мы сделали", next_steps: "Следующие шаги" },
    clicks: "Клики", impressions: "Показы", ctr: "CTR", avgPosition: "Ср. позиция",
    vsPrev: x => `к пред.: ${x}`,
    dailyClicks: "Клики по дням",
    svgClickTitle: (date, n) => `${date}: ${n} кликов`,
    gscDates: (from, to) => `Данные Google Search Console: ${from} — ${to} (Search Console отчитывается с задержкой ~2 дня).`,
    query: "Запрос", page: "Страница", change: "Изменение",
    top3: "Топ-3", top10: "Топ-10", keyword: "Ключевое слово", positionCol: "Позиция", improved: "Выросли", declined: "Упали",
    notCheckedYet: "Трекер позиций ещё не проверял эти ключевые слова.",
    rankFoundAt: t => `Последнее найденное: ${t}`,
    rankNeverFound: "Ещё не найдено",
    location: "Локация", organic: "Органика", mapPack: "Map pack",
    inPack: n => `#${n} в pack`,
    inPackSummary: n => `${n} ключевых слов в map pack (места 1–3).`,
    noLocalKw: "Локальных ключевых слов пока нет",
    napStatus: "Статус цитирований (NAP)",
    indexed: "Проиндексировано", notIndexed: "Не индексируется", notInspected: "Не проверено", sitemapUrls: "URL в sitemap",
    sinceDelta: (sign, n, date) => `${sign}${n} с ${date}`,
    asOf: date => `На ${date}.`,
    healthScore: "Здоровье сайта", pagesCrawled: "Просканировано страниц", pagesWithIssues: "Страницы с проблемами",
    issue: "Проблема", severity: "Серьёзность", pages: "Страницы",
    noIssues: "Проблем не найдено",
    cwvTitle: n => `Core Web Vitals (выборка: ${n})`,
    lcp: "LCP, с", inp: "INP, мс", cls: "CLS", perf: "Скорость",
    lastAudit: date => `Последний аудит: ${date}.`,
    uptime: "Аптайм", incidents: "Инциденты", started: "Начало", cause: "Причина", duration: "Длительность",
    ongoing: "продолжается",
    minutes: n => `${n} мин`,
    noIncidents: "За период инцидентов не было.",
    monitoredUrl: url => `Отслеживаемый URL: ${url}`,
    newLinks: "Новые ссылки", lostLinks: "Потерянные ссылки",
    avgDrNew: dr => `Сред. ${dr} новых доноров`,
    newLinkFrom: "Новая ссылка с", anchor: "Анкор",
    blSource: p => `Источник: ссылочный индекс ${p}. Новые = ссылки, которые провайдер впервые увидел за период; потерянные = ссылки, о которых он сообщил как о потерянных за период. Цифры других индексов будут отличаться.`,
    mentionShare: "Доля упоминаний", citationShare: "Доля цитирований", answersAnalysed: "Проанализировано ответов",
    domain: "Домен", citations: "Цитирования",
    trackedQuestions: (n, d) => `${n} отслеживаемых вопросов, последние ${d} дн.`,
    newReviews: "Новые отзывы", avgRating: "Средняя оценка",
    anonymous: "Аноним",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Приоритет:",
    noData: "За период данных нет",
    noNotes: "Заметок за период нет",
    dirWithPrev: (sign, pct, cur, prev) => `Клики ${sign}${pct}% к предыдущему периоду (${cur} против ${prev}).`,
    dirOnly: cur => `${cur} кликов за период.`,
    bestGrowth: (kw, delta) => `Лучший рост — «${kw}» (${delta} кликов).`,
    prioIndexDrop: n => `${n} страниц выпало из индекса Google за период.`,
    prioKeywordsLost: (n, kw, tail) => `${n} отслеживаемых ключевых слов потеряли позиции — «${kw}» ${tail}.`,
    tailNow: pos => `теперь #${pos}`,
    notFoundTail: "больше не находится",
    prioAudit: (n, code) => `Аудит: ${n} страниц с проблемой «${code}».`,
    prioBacklinks: (n, p) => `${n} ссылок потеряно за период (по данным ${p}).`,
    prioUptime: (n, date, cause) => `Аптайм: ${n} инцидентов, последний ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `Верните «${kw}»${loc} — ${from} → ${to}.`,
    trackedWord: "была в трекинге",
    notFound: "не найдена",
    stepInspect: n => `Проверьте ${n} страниц, которые Google помечает как неиндексируемые.`,
    stepFix: (code, n) => `Исправьте «${code}» на ${n} страницах.`,
    stepDoubleDown: (kw, n) => `Наращивайте «${kw}» (+${n} кликов).`,
    daysPeriod: n => `(${n} дн.)`,
    madeWith: linked => `Создано с помощью ${linked}`,
    generatedAt: date => `Сгенерировано ${date}`,
    logoAlt: "логотип",
    mailPeriod: (from, to) => `Период: ${from} — ${to}`,
    openReport: "Открыть отчёт",
  },
  uk: {
    sectionTitles: { summary: "Підсумок", traffic: "Трафік", queries: "Топ-запити", pages: "Топ-сторінки", positions: "Позиції", local_positions: "Локальна видимість", indexing: "Індексація", audit: "Аудит сайту", uptime: "Аптайм", backlinks: "Зворотні посилання", ai_visibility: "AI-видимість", reviews: "Відгуки", work_done: "Що ми зробили", next_steps: "Наступні кроки" },
    clicks: "Кліки", impressions: "Покази", ctr: "CTR", avgPosition: "Сер. позиція",
    vsPrev: x => `до поп.: ${x}`,
    dailyClicks: "Кліки по днях",
    svgClickTitle: (date, n) => `${date}: ${n} кліків`,
    gscDates: (from, to) => `Дані Google Search Console: ${from} — ${to} (Search Console звітує із затримкою ~2 дні).`,
    query: "Запит", page: "Сторінка", change: "Зміна",
    top3: "Топ-3", top10: "Топ-10", keyword: "Ключове слово", positionCol: "Позиція", improved: "Виросли", declined: "Упали",
    notCheckedYet: "Трекер позицій ще не перевіряв ці ключові слова.",
    rankFoundAt: t => `Останнє знайдене: ${t}`,
    rankNeverFound: "Ще не знайдено",
    location: "Локація", organic: "Органіка", mapPack: "Map pack",
    inPack: n => `#${n} у pack`,
    inPackSummary: n => `${n} ключових слів у map pack (місця 1–3).`,
    noLocalKw: "Локальних ключових слів ще немає",
    napStatus: "Статус цитувань (NAP)",
    indexed: "Проіндексовано", notIndexed: "Не індексується", notInspected: "Не перевірено", sitemapUrls: "URL у sitemap",
    sinceDelta: (sign, n, date) => `${sign}${n} з ${date}`,
    asOf: date => `Станом на ${date}.`,
    healthScore: "Здоров'я сайту", pagesCrawled: "Проскановано сторінок", pagesWithIssues: "Сторінки з проблемами",
    issue: "Проблема", severity: "Серйозність", pages: "Сторінки",
    noIssues: "Проблем не знайдено",
    cwvTitle: n => `Core Web Vitals (вибірка: ${n})`,
    lcp: "LCP, с", inp: "INP, мс", cls: "CLS", perf: "Швидкість",
    lastAudit: date => `Останній аудит: ${date}.`,
    uptime: "Аптайм", incidents: "Інциденти", started: "Початок", cause: "Причина", duration: "Тривалість",
    ongoing: "триває",
    minutes: n => `${n} хв`,
    noIncidents: "За період інцидентів не було.",
    monitoredUrl: url => `Відстежуваний URL: ${url}`,
    newLinks: "Нові посилання", lostLinks: "Втрачені посилання",
    avgDrNew: dr => `Сер. ${dr} нових донорів`,
    newLinkFrom: "Нове посилання з", anchor: "Анкор",
    blSource: p => `Джерело: посилальний індекс ${p}. Нові = посилання, які провайдер уперше побачив за період; втрачені = посилання, про які він повідомив як втрачені за період. Цифри інших індексів відрізнятимуться.`,
    mentionShare: "Частка згадок", citationShare: "Частка цитувань", answersAnalysed: "Проаналізовано відповідей",
    domain: "Домен", citations: "Цитування",
    trackedQuestions: (n, d) => `${n} відстежуваних питань, останні ${d} дн.`,
    newReviews: "Нові відгуки", avgRating: "Середня оцінка",
    anonymous: "Анонім",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Пріоритет:",
    noData: "За період даних немає",
    noNotes: "Нотаток за період немає",
    dirWithPrev: (sign, pct, cur, prev) => `Кліки ${sign}${pct}% до попереднього періоду (${cur} проти ${prev}).`,
    dirOnly: cur => `${cur} кліків за період.`,
    bestGrowth: (kw, delta) => `Найкращий ріст — «${kw}» (${delta} кліків).`,
    prioIndexDrop: n => `${n} сторінок випало з індексу Google за період.`,
    prioKeywordsLost: (n, kw, tail) => `${n} відстежуваних ключових слів втратили позиції — «${kw}» ${tail}.`,
    tailNow: pos => `тепер #${pos}`,
    notFoundTail: "більше не знаходиться",
    prioAudit: (n, code) => `Аудит: ${n} сторінок із проблемою «${code}».`,
    prioBacklinks: (n, p) => `${n} посилань втрачено за період (за даними ${p}).`,
    prioUptime: (n, date, cause) => `Аптайм: ${n} інцидентів, останній ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `Поверніть «${kw}»${loc} — ${from} → ${to}.`,
    trackedWord: "була у трекингу",
    notFound: "не знайдена",
    stepInspect: n => `Перевірте ${n} сторінок, які Google позначає як неіндексовані.`,
    stepFix: (code, n) => `Виправте «${code}» на ${n} сторінках.`,
    stepDoubleDown: (kw, n) => `Нарощуйте «${kw}» (+${n} кліків).`,
    daysPeriod: n => `(${n} дн.)`,
    madeWith: linked => `Створено за допомогою ${linked}`,
    generatedAt: date => `Згенеровано ${date}`,
    logoAlt: "логотип",
    mailPeriod: (from, to) => `Період: ${from} — ${to}`,
    openReport: "Відкрити звіт",
  },
  fr: {
    sectionTitles: { summary: "Synthèse", traffic: "Trafic", queries: "Requêtes principales", pages: "Pages principales", positions: "Positions", local_positions: "Visibilité locale", indexing: "Indexation", audit: "Audit du site", uptime: "Disponibilité", backlinks: "Backlinks", ai_visibility: "Visibilité IA", reviews: "Avis", work_done: "Ce que nous avons fait", next_steps: "Prochaines étapes" },
    clicks: "Clics", impressions: "Impressions", ctr: "CTR", avgPosition: "Pos. moyenne",
    vsPrev: x => `vs préc. : ${x}`,
    dailyClicks: "Clics quotidiens",
    svgClickTitle: (date, n) => `${date} : ${n} clics`,
    gscDates: (from, to) => `Données Google Search Console : ${from} — ${to} (Search Console rapporte avec ~2 jours de retard).`,
    query: "Requête", page: "Page", change: "Évolution",
    top3: "Top 3", top10: "Top 10", keyword: "Mot-clé", positionCol: "Position", improved: "En progression", declined: "En baisse",
    notCheckedYet: "Le suivi de positions n'a pas encore vérifié ces mots-clés.",
    rankFoundAt: t => `Dernière position vue : ${t}`,
    rankNeverFound: "Pas encore trouvée",
    location: "Localisation", organic: "Organique", mapPack: "Map pack",
    inPack: n => `#${n} dans le pack`,
    inPackSummary: n => `${n} mot(s)-clé(s) dans le map pack (places 1–3).`,
    noLocalKw: "Aucun mot-clé suivi en local pour le moment",
    napStatus: "État des citations (NAP)",
    indexed: "Indexées", notIndexed: "Non indexées", notInspected: "Non inspectées", sitemapUrls: "URL du sitemap",
    sinceDelta: (sign, n, date) => `${sign}${n} depuis le ${date}`,
    asOf: date => `Au ${date}.`,
    healthScore: "Score de santé", pagesCrawled: "Pages explorées", pagesWithIssues: "Pages avec problèmes",
    issue: "Problème", severity: "Gravité", pages: "Pages",
    noIssues: "Aucun problème enregistré",
    cwvTitle: n => `Core Web Vitals (échantillon de ${n})`,
    lcp: "LCP, s", inp: "INP, ms", cls: "CLS", perf: "Perf.",
    lastAudit: date => `Dernier audit : ${date}.`,
    uptime: "Disponibilité", incidents: "Incidents", started: "Début", cause: "Cause", duration: "Durée",
    ongoing: "en cours",
    minutes: n => `${n} min`,
    noIncidents: "Aucun incident sur la période.",
    monitoredUrl: url => `URL surveillée : ${url}`,
    newLinks: "Nouveaux liens", lostLinks: "Liens perdus",
    avgDrNew: dr => `${dr} moyen des nouveaux donneurs`,
    newLinkFrom: "Nouveau lien de", anchor: "Ancre",
    blSource: p => `Source : index de liens ${p}. Nouveaux = liens que le fournisseur a vus pour la première fois sur la période ; perdus = liens qu'il a signalés perdus sur la période. Les chiffres d'autres index de liens seront différents.`,
    mentionShare: "Part de mentions", citationShare: "Part de citations", answersAnalysed: "Réponses analysées",
    domain: "Domaine", citations: "Citations",
    trackedQuestions: (n, d) => `${n} question(s) suivie(s), ${d} derniers jours.`,
    newReviews: "Nouveaux avis", avgRating: "Note moyenne",
    anonymous: "Anonyme",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Priorité :",
    noData: "Aucune donnée sur la période",
    noNotes: "Aucune note sur la période",
    dirWithPrev: (sign, pct, cur, prev) => `Clics ${sign}${pct}% vs période précédente (${cur} contre ${prev}).`,
    dirOnly: cur => `${cur} clics sur la période.`,
    bestGrowth: (kw, delta) => `Meilleure progression — « ${kw} » (${delta} clics).`,
    prioIndexDrop: n => `${n} page(s) sont sorties de l'index Google pendant la période.`,
    prioKeywordsLost: (n, kw, tail) => `${n} mot(s)-clé(s) suivi(s) ont perdu des positions — « ${kw} » ${tail}.`,
    tailNow: pos => `désormais #${pos}`,
    notFoundTail: "n'apparaît plus",
    prioAudit: (n, code) => `Audit : ${n} page(s) avec « ${code} ».`,
    prioBacklinks: (n, p) => `${n} backlink(s) perdu(s) sur la période (selon ${p}).`,
    prioUptime: (n, date, cause) => `Disponibilité : ${n} incident(s), dernier le ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `Récupérez « ${kw} »${loc} — ${from} → ${to}.`,
    trackedWord: "suivi",
    notFound: "introuvable",
    stepInspect: n => `Inspectez les ${n} page(s) que Google signale comme non indexées.`,
    stepFix: (code, n) => `Corrigez « ${code} » sur ${n} page(s).`,
    stepDoubleDown: (kw, n) => `Poursuivez sur « ${kw} » (+${n} clics).`,
    daysPeriod: n => `(${n} jours)`,
    madeWith: linked => `Créé avec ${linked}`,
    generatedAt: date => `Généré le ${date}`,
    logoAlt: "logo",
    mailPeriod: (from, to) => `Période : ${from} — ${to}`,
    openReport: "Ouvrir le rapport",
  },
  es: {
    sectionTitles: { summary: "Resumen", traffic: "Tráfico", queries: "Consultas principales", pages: "Páginas principales", positions: "Posiciones", local_positions: "Visibilidad local", indexing: "Indexación", audit: "Auditoría del sitio", uptime: "Disponibilidad", backlinks: "Backlinks", ai_visibility: "Visibilidad en IA", reviews: "Reseñas", work_done: "Lo que hicimos", next_steps: "Próximos pasos" },
    clicks: "Clics", impressions: "Impresiones", ctr: "CTR", avgPosition: "Pos. media",
    vsPrev: x => `vs ant.: ${x}`,
    dailyClicks: "Clics diarios",
    svgClickTitle: (date, n) => `${date}: ${n} clics`,
    gscDates: (from, to) => `Datos de Google Search Console: ${from} — ${to} (Search Console informa con ~2 días de retraso).`,
    query: "Consulta", page: "Página", change: "Cambio",
    top3: "Top 3", top10: "Top 10", keyword: "Palabra clave", positionCol: "Posición", improved: "Mejoradas", declined: "En caída",
    notCheckedYet: "El rastreador de posiciones aún no ha comprobado estas palabras clave.",
    rankFoundAt: t => `Última vez vista: ${t}`,
    rankNeverFound: "Aún no encontrada",
    location: "Ubicación", organic: "Orgánico", mapPack: "Map pack",
    inPack: n => `#${n} en el pack`,
    inPackSummary: n => `${n} palabra(s) clave dentro del map pack (puestos 1–3).`,
    noLocalKw: "Aún no hay palabras clave con seguimiento local",
    napStatus: "Estado de citas (NAP)",
    indexed: "Indexadas", notIndexed: "No indexadas", notInspected: "Sin inspeccionar", sitemapUrls: "URL del sitemap",
    sinceDelta: (sign, n, date) => `${sign}${n} desde el ${date}`,
    asOf: date => `A ${date}.`,
    healthScore: "Puntuación de salud", pagesCrawled: "Páginas rastreadas", pagesWithIssues: "Páginas con problemas",
    issue: "Problema", severity: "Gravedad", pages: "Páginas",
    noIssues: "No hay problemas registrados",
    cwvTitle: n => `Core Web Vitals (muestra de ${n})`,
    lcp: "LCP, s", inp: "INP, ms", cls: "CLS", perf: "Rendim.",
    lastAudit: date => `Última auditoría: ${date}.`,
    uptime: "Disponibilidad", incidents: "Incidentes", started: "Inicio", cause: "Causa", duration: "Duración",
    ongoing: "en curso",
    minutes: n => `${n} min`,
    noIncidents: "Sin incidentes en este período.",
    monitoredUrl: url => `URL supervisada: ${url}`,
    newLinks: "Enlaces nuevos", lostLinks: "Enlaces perdidos",
    avgDrNew: dr => `${dr} medio de los nuevos donantes`,
    newLinkFrom: "Nuevo enlace de", anchor: "Ancla",
    blSource: p => `Fuente: índice de enlaces de ${p}. Nuevos = enlaces que el proveedor vio por primera vez en este período; perdidos = enlaces que reportó como perdidos en este período. Las cifras de otros índices de enlaces diferirán.`,
    mentionShare: "Cuota de menciones", citationShare: "Cuota de citas", answersAnalysed: "Respuestas analizadas",
    domain: "Dominio", citations: "Citas",
    trackedQuestions: (n, d) => `${n} pregunta(s) con seguimiento, últimos ${d} días.`,
    newReviews: "Reseñas nuevas", avgRating: "Valoración media",
    anonymous: "Anónimo",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Prioridad:",
    noData: "Sin datos para este período",
    noNotes: "Sin notas para este período",
    dirWithPrev: (sign, pct, cur, prev) => `Clics ${sign}${pct}% frente al período anterior (${cur} frente a ${prev}).`,
    dirOnly: cur => `${cur} clics en este período.`,
    bestGrowth: (kw, delta) => `Mayor crecimiento — «${kw}» (${delta} clics).`,
    prioIndexDrop: n => `${n} página(s) salieron del índice de Google durante el período.`,
    prioKeywordsLost: (n, kw, tail) => `${n} palabra(s) clave con seguimiento perdieron posiciones — «${kw}» ${tail}.`,
    tailNow: pos => `ahora #${pos}`,
    notFoundTail: "ya no aparece",
    prioAudit: (n, code) => `Auditoría: ${n} página(s) con «${code}».`,
    prioBacklinks: (n, p) => `${n} backlink(s) perdido(s) en este período (según ${p}).`,
    prioUptime: (n, date, cause) => `Disponibilidad: ${n} incidente(s), el más reciente ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `Recupera «${kw}»${loc} — ${from} → ${to}.`,
    trackedWord: "con seguimiento",
    notFound: "no encontrada",
    stepInspect: n => `Inspecciona las ${n} página(s) que Google reporta como no indexadas.`,
    stepFix: (code, n) => `Corrige «${code}» en ${n} página(s).`,
    stepDoubleDown: (kw, n) => `Refuerza «${kw}» (+${n} clics).`,
    daysPeriod: n => `(${n} días)`,
    madeWith: linked => `Hecho con ${linked}`,
    generatedAt: date => `Generado el ${date}`,
    logoAlt: "logo",
    mailPeriod: (from, to) => `Período: ${from} — ${to}`,
    openReport: "Abrir el informe",
  },
  de: {
    sectionTitles: { summary: "Zusammenfassung", traffic: "Traffic", queries: "Top-Suchanfragen", pages: "Top-Seiten", positions: "Positionen", local_positions: "Lokale Sichtbarkeit", indexing: "Indexierung", audit: "Website-Audit", uptime: "Erreichbarkeit", backlinks: "Backlinks", ai_visibility: "KI-Sichtbarkeit", reviews: "Bewertungen", work_done: "Was wir getan haben", next_steps: "Nächste Schritte" },
    clicks: "Klicks", impressions: "Impressionen", ctr: "CTR", avgPosition: "Durchschn. Position",
    vsPrev: x => `vs Vorige(r): ${x}`,
    dailyClicks: "Tägliche Klicks",
    svgClickTitle: (date, n) => `${date}: ${n} Klicks`,
    gscDates: (from, to) => `Google-Search-Console-Daten: ${from} — ${to} (die Search Console meldet mit ~2 Tagen Verzögerung).`,
    query: "Suchanfrage", page: "Seite", change: "Veränderung",
    top3: "Top 3", top10: "Top 10", keyword: "Keyword", positionCol: "Position", improved: "Gestiegen", declined: "Gefallen",
    notCheckedYet: "Der Rank-Tracker hat diese Keywords noch nicht geprüft.",
    rankFoundAt: t => `Zuletzt gefunden: ${t}`,
    rankNeverFound: "Noch nicht gefunden",
    location: "Standort", organic: "Organisch", mapPack: "Map Pack",
    inPack: n => `#${n} im Pack`,
    inPackSummary: n => `${n} Keyword(s) im Map Pack (Plätze 1–3).`,
    noLocalKw: "Noch keine lokal getrackten Keywords",
    napStatus: "Zitierungsstatus (NAP)",
    indexed: "Indexiert", notIndexed: "Nicht indexiert", notInspected: "Nicht geprüft", sitemapUrls: "Sitemap-URLs",
    sinceDelta: (sign, n, date) => `${sign}${n} seit ${date}`,
    asOf: date => `Stand ${date}.`,
    healthScore: "Health-Score", pagesCrawled: "Gecrawlte Seiten", pagesWithIssues: "Seiten mit Problemen",
    issue: "Problem", severity: "Schweregrad", pages: "Seiten",
    noIssues: "Keine Probleme erfasst",
    cwvTitle: n => `Core Web Vitals (Stichprobe von ${n})`,
    lcp: "LCP, s", inp: "INP, ms", cls: "CLS", perf: "Perf.",
    lastAudit: date => `Letztes Audit: ${date}.`,
    uptime: "Erreichbarkeit", incidents: "Vorfälle", started: "Beginn", cause: "Ursache", duration: "Dauer",
    ongoing: "anhaltend",
    minutes: n => `${n} Min.`,
    noIncidents: "Keine Vorfälle in diesem Zeitraum.",
    monitoredUrl: url => `Überwachte URL: ${url}`,
    newLinks: "Neue Links", lostLinks: "Verlorene Links",
    avgDrNew: dr => `Durchschn. ${dr} neuer Spender`,
    newLinkFrom: "Neuer Link von", anchor: "Ankertext",
    blSource: p => `Quelle: ${p}-Linkindex. Neu = Links, die der Anbieter in diesem Zeitraum erstmals gesehen hat; verloren = Links, die er in diesem Zeitraum als verloren gemeldet hat. Die Zahlen anderer Linkindizes weichen ab.`,
    mentionShare: "Erwähnungsanteil", citationShare: "Zitierungsanteil", answersAnalysed: "Analysierte Antworten",
    domain: "Domain", citations: "Zitierungen",
    trackedQuestions: (n, d) => `${n} beobachtete Frage(n), letzte ${d} Tage.`,
    newReviews: "Neue Bewertungen", avgRating: "Durchschnittliche Bewertung",
    anonymous: "Anonym",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Priorität:",
    noData: "Keine Daten für diesen Zeitraum",
    noNotes: "Keine Notizen für diesen Zeitraum",
    dirWithPrev: (sign, pct, cur, prev) => `Klicks ${sign}${pct}% gegenüber dem vorherigen Zeitraum (${cur} vs. ${prev}).`,
    dirOnly: cur => `${cur} Klicks in diesem Zeitraum.`,
    bestGrowth: (kw, delta) => `Bestes Wachstum — „${kw}“ (${delta} Klicks).`,
    prioIndexDrop: n => `${n} Seite(n) sind im Zeitraum aus dem Google-Index gefallen.`,
    prioKeywordsLost: (n, kw, tail) => `${n} beobachtete Keyword(s) haben Positionen verloren — „${kw}“ ${tail}.`,
    tailNow: pos => `jetzt #${pos}`,
    notFoundTail: "nicht mehr gefunden",
    prioAudit: (n, code) => `Audit: ${n} Seite(n) mit „${code}“.`,
    prioBacklinks: (n, p) => `${n} Backlink(s) in diesem Zeitraum verloren (laut ${p}).`,
    prioUptime: (n, date, cause) => `Erreichbarkeit: ${n} Vorfall/Vorfälle, zuletzt ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `„${kw}“${loc} zurückholen — ${from} → ${to}.`,
    trackedWord: "beobachtet",
    notFound: "nicht gefunden",
    stepInspect: n => `Untersuche die ${n} Seite(n), die Google als nicht indexiert meldet.`,
    stepFix: (code, n) => `Behebe „${code}“ auf ${n} Seite(n).`,
    stepDoubleDown: (kw, n) => `„${kw}“ ausbauen (+${n} Klicks).`,
    daysPeriod: n => `(${n} Tage)`,
    madeWith: linked => `Erstellt mit ${linked}`,
    generatedAt: date => `Generiert am ${date}`,
    logoAlt: "Logo",
    mailPeriod: (from, to) => `Zeitraum: ${from} — ${to}`,
    openReport: "Bericht öffnen",
  },
  zh: {
    sectionTitles: { summary: "摘要", traffic: "流量", queries: "热门查询", pages: "热门页面", positions: "排名", local_positions: "本地可见性", indexing: "索引", audit: "网站审计", uptime: "可用性", backlinks: "外链", ai_visibility: "AI 可见性", reviews: "评价", work_done: "我们做了什么", next_steps: "下一步" },
    clicks: "点击", impressions: "展示", ctr: "CTR", avgPosition: "平均排名",
    vsPrev: x => `较上期：${x}`,
    dailyClicks: "每日点击",
    svgClickTitle: (date, n) => `${date}：${n} 次点击`,
    gscDates: (from, to) => `Google Search Console 数据：${from} — ${to}（Search Console 约有 2 天延迟）。`,
    query: "查询", page: "页面", change: "变化",
    top3: "前 3", top10: "前 10", keyword: "关键词", positionCol: "排名", improved: "上升", declined: "下降",
    notCheckedYet: "排名追踪尚未检查这些关键词。",
    rankFoundAt: t => `最后查到：${t}`,
    rankNeverFound: "尚未查到",
    location: "位置", organic: "自然结果", mapPack: "地图包",
    inPack: n => `地图包第 ${n} 位`,
    inPackSummary: n => `${n} 个关键词进入地图包（第 1–3 位）。`,
    noLocalKw: "尚无本地追踪的关键词",
    napStatus: "引用状态（NAP）",
    indexed: "已收录", notIndexed: "未收录", notInspected: "未检查", sitemapUrls: "Sitemap URL 数",
    sinceDelta: (sign, n, date) => `自 ${date} 起 ${sign}${n}`,
    asOf: date => `截至 ${date}。`,
    healthScore: "健康评分", pagesCrawled: "已抓取页面", pagesWithIssues: "有问题的页面",
    issue: "问题", severity: "严重程度", pages: "页面",
    noIssues: "未记录到问题",
    cwvTitle: n => `Core Web Vitals（样本 ${n} 个）`,
    lcp: "LCP（秒）", inp: "INP（毫秒）", cls: "CLS", perf: "性能",
    lastAudit: date => `上次审计：${date}。`,
    uptime: "可用性", incidents: "故障", started: "开始", cause: "原因", duration: "持续",
    ongoing: "进行中",
    minutes: n => `${n} 分钟`,
    noIncidents: "本期无故障。",
    monitoredUrl: url => `监控 URL：${url}`,
    newLinks: "新增链接", lostLinks: "丢失链接",
    avgDrNew: dr => `新链接来源平均 ${dr}`,
    newLinkFrom: "新链接来自", anchor: "锚文本",
    blSource: p => `来源：${p} 链接索引。新增 = 供应商本期首次看到的链接；丢失 = 供应商本期报告为丢失的链接。其他链接索引的数字会有差异。`,
    mentionShare: "提及份额", citationShare: "引用份额", answersAnalysed: "分析的回答数",
    domain: "域名", citations: "引用次数",
    trackedQuestions: (n, d) => `${n} 个追踪问题，近 ${d} 天。`,
    newReviews: "新评价", avgRating: "平均评分",
    anonymous: "匿名",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "优先事项：",
    noData: "本期无数据",
    noNotes: "本期无备注",
    dirWithPrev: (sign, pct, cur, prev) => `点击量较上期 ${sign}${pct}%（${cur} 对 ${prev}）。`,
    dirOnly: cur => `本期 ${cur} 次点击。`,
    bestGrowth: (kw, delta) => `增长最佳 ——「${kw}」（+${delta} 次点击）。`,
    prioIndexDrop: n => `${n} 个页面在本期退出了 Google 索引。`,
    prioKeywordsLost: (n, kw, tail) => `${n} 个追踪关键词排名下滑 ——「${kw}」${tail}。`,
    tailNow: pos => `现为第 ${pos} 位`,
    notFoundTail: "已找不到",
    prioAudit: (n, code) => `审计：${n} 个页面存在「${code}」。`,
    prioBacklinks: (n, p) => `本期丢失 ${n} 条外链（按 ${p} 数据）。`,
    prioUptime: (n, date, cause) => `可用性：${n} 次故障，最近一次 ${date}（${cause}）。`,
    stepRecover: (kw, loc, from, to) => `恢复「${kw}」${loc} —— ${from} → ${to}。`,
    trackedWord: "曾追踪",
    notFound: "未找到",
    stepInspect: n => `检查 Google 报告为未收录的 ${n} 个页面。`,
    stepFix: (code, n) => `在 ${n} 个页面上修复「${code}」。`,
    stepDoubleDown: (kw, n) => `继续加码「${kw}」（+${n} 次点击）。`,
    daysPeriod: n => `（${n} 天）`,
    madeWith: linked => `由 ${linked} 制作`,
    generatedAt: date => `生成于 ${date}`,
    logoAlt: "logo",
    mailPeriod: (from, to) => `周期：${from} — ${to}`,
    openReport: "打开报告",
  },
  nl: {
    sectionTitles: { summary: "Samenvatting", traffic: "Verkeer", queries: "Topzoekwoorden", pages: "Toppagina's", positions: "Posities", local_positions: "Lokale zichtbaarheid", indexing: "Indexering", audit: "Site-audit", uptime: "Uptime", backlinks: "Backlinks", ai_visibility: "AI-zichtbaarheid", reviews: "Reviews", work_done: "Wat we hebben gedaan", next_steps: "Vervolgstappen" },
    clicks: "Klikken", impressions: "Vertoningen", ctr: "CTR", avgPosition: "Gem. positie",
    vsPrev: x => `vs vorige: ${x}`,
    dailyClicks: "Dagelijkse klikken",
    svgClickTitle: (date, n) => `${date}: ${n} klikken`,
    gscDates: (from, to) => `Google Search Console-gegevens: ${from} — ${to} (Search Console rapporteert met ~2 dagen vertraging).`,
    query: "Zoekwoord", page: "Pagina", change: "Verandering",
    top3: "Top 3", top10: "Top 10", keyword: "Zoekwoord", positionCol: "Positie", improved: "Gestegen", declined: "Gedaald",
    notCheckedYet: "De ranktracker heeft deze zoekwoorden nog niet gecontroleerd.",
    rankFoundAt: t => `Laatst gevonden: ${t}`,
    rankNeverFound: "Nog niet gevonden",
    location: "Locatie", organic: "Organisch", mapPack: "Map pack",
    inPack: n => `#${n} in pack`,
    inPackSummary: n => `${n} zoekwoord(en) in de map pack (plaatsen 1–3).`,
    noLocalKw: "Nog geen lokaal gevolgde zoekwoorden",
    napStatus: "Citatiestatus (NAP)",
    indexed: "Geïndexeerd", notIndexed: "Niet geïndexeerd", notInspected: "Niet geïnspecteerd", sitemapUrls: "Sitemap-URL's",
    sinceDelta: (sign, n, date) => `${sign}${n} sinds ${date}`,
    asOf: date => `Per ${date}.`,
    healthScore: "Gezondheidsscore", pagesCrawled: "Gecrawlde pagina's", pagesWithIssues: "Pagina's met problemen",
    issue: "Probleem", severity: "Ernst", pages: "Pagina's",
    noIssues: "Geen problemen geregistreerd",
    cwvTitle: n => `Core Web Vitals (steekproef van ${n})`,
    lcp: "LCP, s", inp: "INP, ms", cls: "CLS", perf: "Perf.",
    lastAudit: date => `Laatste audit: ${date}.`,
    uptime: "Uptime", incidents: "Incidenten", started: "Gestart", cause: "Oorzaak", duration: "Duur",
    ongoing: "loopt nog",
    minutes: n => `${n} min`,
    noIncidents: "Geen incidenten in deze periode.",
    monitoredUrl: url => `Bewaakte URL: ${url}`,
    newLinks: "Nieuwe links", lostLinks: "Verloren links",
    avgDrNew: dr => `Gem. ${dr} van nieuwe donoren`,
    newLinkFrom: "Nieuwe link van", anchor: "Ankertekst",
    blSource: p => `Bron: linkindex van ${p}. Nieuw = links die de provider voor het eerst in deze periode zag; verloren = links die de provider in deze periode als verloren rapporteerde. Cijfers uit andere linkindexen wijken af.`,
    mentionShare: "Aandeel vermeldingen", citationShare: "Aandeel citaten", answersAnalysed: "Geanalyseerde antwoorden",
    domain: "Domein", citations: "Citaten",
    trackedQuestions: (n, d) => `${n} gevolgde vraag/vragen, laatste ${d} dagen.`,
    newReviews: "Nieuwe reviews", avgRating: "Gemiddelde beoordeling",
    anonymous: "Anoniem",
    ratingOf5: r => `${r} / 5`,
    priorityLabel: "Prioriteit:",
    noData: "Geen gegevens voor deze periode",
    noNotes: "Geen notities voor deze periode",
    dirWithPrev: (sign, pct, cur, prev) => `Klikken ${sign}${pct}% t.o.v. de vorige periode (${cur} vs ${prev}).`,
    dirOnly: cur => `${cur} klikken deze periode.`,
    bestGrowth: (kw, delta) => `Beste groei — “${kw}” (${delta} klikken).`,
    prioIndexDrop: n => `${n} pagina(’s) zijn in deze periode uit de Google-index gevallen.`,
    prioKeywordsLost: (n, kw, tail) => `${n} gevolgde zoekwoord(en) verloren posities — “${kw}” ${tail}.`,
    tailNow: pos => `nu #${pos}`,
    notFoundTail: "wordt niet meer gevonden",
    prioAudit: (n, code) => `Audit: ${n} pagina(’s) met “${code}”.`,
    prioBacklinks: (n, p) => `${n} backlink(s) verloren in deze periode (volgens ${p}).`,
    prioUptime: (n, date, cause) => `Uptime: ${n} incident(en), laatste ${date} (${cause}).`,
    stepRecover: (kw, loc, from, to) => `Herstel “${kw}”${loc} — ${from} → ${to}.`,
    trackedWord: "werd gevolgd",
    notFound: "niet gevonden",
    stepInspect: n => `Onderzoek de ${n} pagina(’s) die Google als niet-geïndexeerd rapporteert.`,
    stepFix: (code, n) => `Los “${code}” op op ${n} pagina(’s).`,
    stepDoubleDown: (kw, n) => `Zet door op “${kw}” (+${n} klikken).`,
    daysPeriod: n => `(${n} dagen)`,
    madeWith: linked => `Gemaakt met ${linked}`,
    generatedAt: date => `Gegenereerd op ${date}`,
    logoAlt: "logo",
    mailPeriod: (from, to) => `Periode: ${from} — ${to}`,
    openReport: "Rapport openen",
  },
};
