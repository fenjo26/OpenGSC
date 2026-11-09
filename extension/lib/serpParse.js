// OpenGSC extension — Google SERP parsing (wave-ext E4). Two layers on purpose:
//   pure — locale/resultUrl/isOrganicHost/dedupe, unit-tested in src/lib/ext/serpParse.test.ts;
//   DOM  — parse(document), thin and defensive: Google's markup changes without notice, so
//          every selector is a LIST with fallbacks and a failed parse is null + one debug
//          line, never a broken page. Other extensions (Keywords Everywhere, MozBar) inject
//          their own blocks into the same results — the anchor-must-contain-the-heading rule
//          keeps their links out of our organic set.

var SerpParse = (function () {
  "use strict";

  // MUST equal CAPTURE_FEATURES in src/lib/ext/types.ts — E4's test asserts the two stay equal.
  var FEATURES = ["ai_overview", "paa", "local_pack", "top_stories", "video", "images", "shopping", "knowledge_panel", "sitelinks"];

  // DOM selectors, each with fallbacks; Google's obfuscated classes rotate, structural
  // selectors (id, roles) outlive them. Extended in place when a layout changes.
  var SELECTORS = {
    containers: ["#rso", "#search"],
    organic: [
      "#rso a[href] h3",
      "#search a[href] h3",
      '#rso a[href] [role="heading"]',
      '#search a[href] [role="heading"]',
    ],
    ads: ["#tads", "#tadsb", "[data-text-ad]", "#taw"],
    snippet: ["[data-sncf]", ".VwiC3b", 'div[style*="-webkit-line-clamp"]'],
    features: {
      ai_overview: ["#m-x-content", "[data-attrid='AIOverview']", ".LGOjhe"],
      paa: ["[jscontroller='dYDtYe'][data-initq]", "div.related-question-pair", "[data-rl] 'Похожие вопросы'"],
      local_pack: ["[data-attrid='local:one line summary']", ".VkpGBb"],
      top_stories: ["[data-attrid='kc:/local:one line summary']", "div[data-ved] > g-img + span", "#rs_i_0"],
      video: ["video-voyager", "[data-attrid='kc:/local:unified launcher']"],
      images: ["[data-attrid='images universal']", "g-section-with-header g-img"],
      shopping: ["[data-attrid='shopping']", "sh-bubble"],
      knowledge_panel: ["[data-attrid='kc:/local:one line summary']", ".kp-wholepage"],
      sitelinks: [".OSrXXb", "[role='list'] .Ct3Y8c"],
    },
  };

  /** ccTLD of a google search host: www.google.gr → "gr", www.google.co.uk → "gb",
   *  www.google.com → "" (global, no country signal — never guessed). */
  function hostCountry(engineHost) {
    var m = String(engineHost || "").toLowerCase().match(/^(?:www\.)?google\.(.+)$/);
    if (!m) return "";
    var tld = m[1];
    if (tld === "com" || tld === "") return "";
    if (tld === "co.uk" || tld === "uk") return "gb";
    if (tld.indexOf(".") !== -1) return tld.split(".").pop(); // com.ua → ua, com.sa → sa
    return tld;
  }

  function locale(pageUrl, htmlLang) {
    var out = { engineHost: "", country: "", lang: "", page: 1, startPos: 1, query: "", device: "desktop" };
    try {
      var u = new URL(String(pageUrl || ""), "https://www.google.com/");
      out.engineHost = u.host.toLowerCase();
      out.query = String(u.searchParams.get("q") || "").trim().replace(/\s+/g, " ").toLowerCase();
      out.lang = String(u.searchParams.get("hl") || "").toLowerCase().slice(0, 2) || String(htmlLang || "").toLowerCase().slice(0, 2);
      var gl = String(u.searchParams.get("gl") || "").toLowerCase();
      out.country = /^[a-z]{2}$/.test(gl) ? gl : hostCountry(out.engineHost);
      var start = parseInt(String(u.searchParams.get("start") || ""), 10);
      if (Number.isFinite(start) && start > 0) {
        out.page = Math.floor(start / 10) + 1;
        out.startPos = start + 1;
      }
    } catch {
      /* keep the defaults — the server then narrows nothing */
    }
    return out;
  }

  /** /url?q=…, /url?url=…, /redirect?q=… → the real URL; google-internal and junk → null. */
  function resultUrl(rawHref, pageOrigin) {
    var href = String(rawHref || "");
    if (!href) return null;
    var abs = href;
    try {
      abs = new URL(href, pageOrigin || "https://www.google.com/").href;
    } catch {
      return null;
    }
    var u;
    try { u = new URL(abs); } catch { return null; }
    u.hash = "";
    if (/^(javascript|mailto|tel):/i.test(u.protocol)) return null;

    // Google wrappers: /url?q=, /url?url=, /redirect?q=
    var host = u.host.toLowerCase();
    if (/(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host)) {
      if (u.pathname === "/url" || u.pathname === "/redirect") {
        var inner = u.searchParams.get("q") || u.searchParams.get("url") || u.searchParams.get("urlq");
        if (!inner || !/^https?:\/\//i.test(inner)) return null; // relative junk is not a result
        try {
          var real = new URL(inner, u.origin);
          if (!/^https?:$/.test(real.protocol)) return null;
          return stripGoogleJunk(real);
        } catch {
          return null;
        }
      }
      if (host.indexOf("webcache.") === 0 || host.indexOf("translate.") === 0) return null;
      return null; // any other google link is navigation, not an organic result
    }
    return stripGoogleJunk(u);
  }

  function stripGoogleJunk(u) {
    var out = new URL(u.href);
    // google's own click wrappers already unwrapped; keep the URL clean of our own params
    return out.href;
  }

  /** False for google hosts (search/webcache/translate/accounts…). youtube.com IS organic. */
  function isOrganicHost(host) {
    var h = String(host || "").toLowerCase().replace(/^www\./, "");
    if (!h) return false;
    if (/^google\./.test(h) || /\.google\.[a-z.]+$/.test(h)) return false;
    if (/googleusercontent\.com$/.test(h)) return false;
    if (/^(accounts|support|policies|play)\.google\./.test(h)) return false;
    return true;
  }

  /** The same URL twice (sitelinks produce duplicates): the first position wins. */
  function dedupe(rows) {
    var seen = {};
    var out = [];
    (rows || []).forEach(function (r) {
      if (!r || !r.url) return;
      if (seen[r.url]) return;
      seen[r.url] = 1;
      out.push(r);
    });
    return out;
  }

  /**
   * Reconstruct a URL from a result's <cite> breadcrumb ("https://site.gr › a › b"). Some
   * Google sessions serve organic hrefs as /goto?url=<encrypted blob> — undecodable without
   * Google's JS — and the breadcrumb is the only place the real target survives. The host is
   * exact; the path is the visible segments (Google truncates long ones with …, so this is a
   * host-grade reconstruction, which is what the overlay and captures actually consume).
   */
  function citeUrl(citeText) {
    var parts = String(citeText || "")
      .replace(/\s+/g, " ")
      .replace(/^https?:\/\//i, "")
      .split(/›|\//)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (!parts.length) return null;
    var hostPart = parts[0].replace(/^www\./i, "");
    // a host carries at least one dot and no spaces; "…" means the breadcrumb was truncated
    if (!/\./.test(hostPart) || /\s/.test(hostPart) || hostPart.indexOf("…") !== -1 || hostPart.indexOf("...") !== -1) return null;
    var path = parts.slice(1).filter(function (p) { return p.indexOf("…") === -1 && p.indexOf("...") === -1; })
      .map(function (p) { return p.replace(/[?#].*$/, ""); })
      .map(encodeURIComponentSafe)
      .join("/");
    return "https://" + hostPart.toLowerCase() + (path ? "/" + path : "");
  }

  function encodeURIComponentSafe(s) {
    try { return encodeURIComponent(s); } catch { return s; }
  }

  // ─── DOM layer ─────────────────────────────────────────────────────────────────

  function inAd(el, adNodes) {
    for (var i = 0; i < adNodes.length; i++) {
      if (adNodes[i].contains(el)) return true;
    }
    return false;
  }

  function parse(doc) {
    doc = doc || document;
    var container = null;
    for (var c = 0; c < SELECTORS.containers.length && !container; c++) {
      container = doc.querySelector(SELECTORS.containers[c]);
    }
    if (!container) return null;

    var adNodes = [];
    SELECTORS.ads.forEach(function (sel) {
      doc.querySelectorAll(sel).forEach(function (n) { adNodes.push(n); });
    });

    // organic anchors: the heading must live INSIDE the link — that is what excludes blocks
    // other extensions inject between results (their links carry no h3 of Google's own).
    var anchors = [];
    for (var s = 0; s < SELECTORS.organic.length; s++) {
      var found = container.querySelectorAll(SELECTORS.organic[s]);
      if (found.length) {
        found.forEach(function (h) { anchors.push(h.closest("a")); });
        break;
      }
    }
    anchors = anchors.filter(Boolean);

    var meta = locale(doc.location ? doc.location.href : "", doc.documentElement ? doc.documentElement.getAttribute("lang") : "");
    try {
      var width = doc.defaultView ? doc.defaultView.innerWidth : 1000;
      var mobileMarkup = !!doc.querySelector('[data-ved] .Crs1Ad, meta[name="viewport"][content*="width=device-width"]') && width < 700;
      meta.device = width < 700 && mobileMarkup ? "mobile" : "desktop";
    } catch { /* desktop */ }

    var rows = [];
    var pos = meta.startPos;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (inAd(a, adNodes)) continue;
      var heading = a.querySelector("h3") || a.querySelector('[role="heading"]');
      if (!heading) continue;
      var title = String(heading.textContent || "").trim().slice(0, 200);

      // the result block: the anchor's clickable container (Google nests a inside a wrapper)
      var block = a.closest("div[data-hveid], div.g, div.MjjYud") || a;

      var url = resultUrl(a.href, doc.location ? doc.location.origin : "");
      if (!url) {
        // /goto?url=<encrypted> sessions: the <cite> breadcrumb is the real target
        var cites = block.querySelectorAll("cite");
        for (var ci = 0; ci < cites.length && !url; ci++) {
          var candidate = citeUrl(cites[ci].textContent || "");
          if (candidate) {
            try {
              if (isOrganicHost(new URL(candidate).host)) url = candidate;
            } catch { /* not a usable breadcrumb */ }
          }
        }
      }
      if (!url) continue;
      var host = "";
      try { host = new URL(url).host.toLowerCase(); } catch { continue; }
      if (!isOrganicHost(host)) continue;

      // snippet: first non-empty of the fallback selectors within the block
      var snippet = "";
      for (var sn = 0; sn < SELECTORS.snippet.length && !snippet; sn++) {
        var nodes = block.querySelectorAll(SELECTORS.snippet[sn]);
        for (var nn = 0; nn < nodes.length; nn++) {
          var t = String(nodes[nn].textContent || "").trim();
          if (t && t !== title) { snippet = t.slice(0, 300); break; }
        }
      }

      rows.push({
        position: pos++,
        url: url,
        host: host,
        title: title,
        snippet: snippet,
        node: block,
      });
    }

    rows = dedupe(rows);
    if (!rows.length) return null;

    var features = [];
    Object.keys(SELECTORS.features).forEach(function (f) {
      if (FEATURES.indexOf(f) === -1) return;
      for (var k = 0; k < SELECTORS.features[f].length; k++) {
        var sel = SELECTORS.features[f][k];
        if (sel.indexOf("'") !== -1) continue; // textual variants handled below
        try {
          if (container.querySelector(sel) || doc.querySelector(sel)) { features.push(f); return; }
        } catch { /* invalid selector on this Chrome — try the next */ }
      }
    });
    // sitelinks also show as extra links under the first result
    if (features.indexOf("sitelinks") === -1 && container.querySelector('.OSrXXb, [role="list"] table')) features.push("sitelinks");

    return { meta: meta, results: rows, features: features };
  }

  return {
    FEATURES: FEATURES,
    SELECTORS: SELECTORS,
    locale: locale,
    resultUrl: resultUrl,
    citeUrl: citeUrl,
    isOrganicHost: isOrganicHost,
    dedupe: dedupe,
    parse: parse,
  };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = SerpParse;
