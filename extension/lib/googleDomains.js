// OpenGSC extension — the Google web-search domains (wave-ext E0).
//
// Source: https://www.google.com/supported_domains (fetched once, embedded — the options page
// never loads it). Each entry is the full search host ("www." + the .google.<tld> line of that
// page), sorted. The overlay only ever registers on domains the user explicitly enabled AND
// granted, but the settings UI can offer the whole list.

var GOOGLE_SEARCH_HOSTS = [
  "www.google.ad", "www.google.ae", "www.google.al", "www.google.am", "www.google.as", "www.google.at",
  "www.google.az", "www.google.ba", "www.google.be", "www.google.bf", "www.google.bg", "www.google.bi",
  "www.google.bj", "www.google.bs", "www.google.bt", "www.google.by", "www.google.ca", "www.google.cat",
  "www.google.cd", "www.google.cf", "www.google.cg", "www.google.ch", "www.google.ci", "www.google.cl",
  "www.google.cm", "www.google.cn", "www.google.co.ao", "www.google.co.bw", "www.google.co.ck", "www.google.co.cr",
  "www.google.co.id", "www.google.co.il", "www.google.co.in", "www.google.co.jp", "www.google.co.ke", "www.google.co.kr",
  "www.google.co.ls", "www.google.co.ma", "www.google.co.mz", "www.google.co.nz", "www.google.co.th", "www.google.co.tz",
  "www.google.co.ug", "www.google.co.uk", "www.google.co.uz", "www.google.co.ve", "www.google.co.vi", "www.google.co.za",
  "www.google.co.zm", "www.google.co.zw", "www.google.com", "www.google.com.af", "www.google.com.ag", "www.google.com.ar",
  "www.google.com.au", "www.google.com.bd", "www.google.com.bh", "www.google.com.bn", "www.google.com.bo", "www.google.com.br",
  "www.google.com.bz", "www.google.com.co", "www.google.com.cu", "www.google.com.cy", "www.google.com.do", "www.google.com.ec",
  "www.google.com.eg", "www.google.com.et", "www.google.com.fj", "www.google.com.gh", "www.google.com.gi", "www.google.com.gt",
  "www.google.com.hk", "www.google.com.jm", "www.google.com.kh", "www.google.com.kw", "www.google.com.lb", "www.google.com.ly",
  "www.google.com.mm", "www.google.com.mt", "www.google.com.mx", "www.google.com.my", "www.google.com.na", "www.google.com.ng",
  "www.google.com.ni", "www.google.com.np", "www.google.com.om", "www.google.com.pa", "www.google.com.pe", "www.google.com.pg",
  "www.google.com.ph", "www.google.com.pk", "www.google.com.pr", "www.google.com.py", "www.google.com.qa", "www.google.com.sa",
  "www.google.com.sb", "www.google.com.sg", "www.google.com.sl", "www.google.com.sv", "www.google.com.tj", "www.google.com.tr",
  "www.google.com.tw", "www.google.com.ua", "www.google.com.uy", "www.google.com.vc", "www.google.com.vn", "www.google.cv",
  "www.google.cz", "www.google.de", "www.google.dj", "www.google.dk", "www.google.dm", "www.google.dz",
  "www.google.ee", "www.google.es", "www.google.fi", "www.google.fm", "www.google.fr", "www.google.ga",
  "www.google.ge", "www.google.gg", "www.google.gl", "www.google.gm", "www.google.gr", "www.google.gy",
  "www.google.hn", "www.google.hr", "www.google.ht", "www.google.hu", "www.google.ie", "www.google.im",
  "www.google.iq", "www.google.is", "www.google.it", "www.google.je", "www.google.jo", "www.google.kg",
  "www.google.ki", "www.google.kz", "www.google.la", "www.google.li", "www.google.lk", "www.google.lt",
  "www.google.lu", "www.google.lv", "www.google.md", "www.google.me", "www.google.mg", "www.google.mk",
  "www.google.ml", "www.google.mn", "www.google.mu", "www.google.mv", "www.google.mw", "www.google.ne",
  "www.google.nl", "www.google.no", "www.google.nr", "www.google.nu", "www.google.pl", "www.google.pn",
  "www.google.ps", "www.google.pt", "www.google.ro", "www.google.rs", "www.google.ru", "www.google.rw",
  "www.google.sc", "www.google.se", "www.google.sh", "www.google.si", "www.google.sk", "www.google.sm",
  "www.google.sn", "www.google.so", "www.google.sr", "www.google.st", "www.google.td", "www.google.tg",
  "www.google.tl", "www.google.tm", "www.google.tn", "www.google.to", "www.google.tt", "www.google.vu",
  "www.google.ws",
];

/** The hosts suggested for a UI language: google.com plus the language's country domain when
 *  the mapping is obvious; unknown languages get ["www.google.com"] only. */
var GOOGLE_SUGGESTED = {
  el: "www.google.gr", ru: "www.google.ru", uk: "www.google.com.ua", be: "www.google.by",
  fr: "www.google.fr", es: "www.google.es", de: "www.google.de", it: "www.google.it",
  pt: "www.google.pt", nl: "www.google.nl", pl: "www.google.pl", tr: "www.google.com.tr",
  sv: "www.google.se", da: "www.google.dk", fi: "www.google.fi", no: "www.google.no",
  cs: "www.google.cz", sk: "www.google.sk", ro: "www.google.ro", hu: "www.google.hu",
  bg: "www.google.bg", sr: "www.google.rs", hr: "www.google.hr", sl: "www.google.si",
  el_gr: "www.google.gr",
};

function suggestedHosts(uiLang) {
  var lang = String(uiLang || "").replace(/_/g, "-").split("-")[0].toLowerCase();
  var out = ["www.google.com"];
  var extra = GOOGLE_SUGGESTED[lang];
  if (extra && out.indexOf(extra) === -1) out.push(extra);
  return out;
}

/** Other engines the overlay understands (lib/serpParse.js: BING, YANDEX). */
var OTHER_SEARCH_HOSTS = [
  "www.bing.com",
  "yandex.ru", "ya.ru", "yandex.com", "yandex.by", "yandex.kz", "yandex.uz", "yandex.com.tr",
];
/** Everything the options list offers: other engines first, then every Google domain. */
var ALL_SEARCH_HOSTS = OTHER_SEARCH_HOSTS.concat(GOOGLE_SEARCH_HOSTS);

// Node/test interop (classic script everywhere else).
var GoogleDomains = {
  GOOGLE_SEARCH_HOSTS: GOOGLE_SEARCH_HOSTS,
  OTHER_SEARCH_HOSTS: OTHER_SEARCH_HOSTS,
  ALL_SEARCH_HOSTS: ALL_SEARCH_HOSTS,
  suggestedHosts: suggestedHosts,
};
if (typeof module !== "undefined" && module.exports) module.exports = GoogleDomains;
