// OpenGSC extension — Google SERP parsing (wave-ext E4 owns this file). Two layers: the pure
// helpers below are unit-tested (src/lib/ext/serpParse.test.ts), the DOM parse stays thin and
// defensive — Google's markup changes, so every selector has fallbacks and a failed parse is
// silence (one console.debug), never a broken page. E0 lays the shape.

var SerpParse = {
  /** pure — locale/page/query facts from the SERP URL + <html lang>. */
  locale: function (_pageUrl, _htmlLang) {
    return { engineHost: "", country: "", lang: "", page: 1, startPos: 1, query: "", device: "desktop" };
  },

  /** pure — /url?q=… → the real URL; google.*, webcache, translate, junk → null. */
  resultUrl: function (_rawHref, _pageOrigin) { return null; },

  /** pure — false for google.* hosts, youtube redirectors, accounts.google… */
  isOrganicHost: function (_host) { return false; },

  /** pure — the same URL twice (sitelinks): the first position wins. */
  dedupe: function (rows) { return rows || []; },

  /** DOM — the organic results + SERP features. No match → null (and one console.debug line
   *  from the overlay, not from here). E4 implements. */
  parse: function (_doc) { return null; },

  /** The SERP features looked for — MUST equal CAPTURE_FEATURES in src/lib/ext/types.ts
   *  (E4's test asserts the two stay identical). */
  FEATURES: ["ai_overview", "paa", "local_pack", "top_stories", "video", "images", "shopping", "knowledge_panel", "sitelinks"],
};

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = SerpParse;
