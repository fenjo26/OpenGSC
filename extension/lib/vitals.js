// OpenGSC extension — Core Web Vitals collected in the page (wave-ext E1).
//
// Runs inside the audited page (part of PANEL_INJECT), reads the PerformanceObserver buffered
// entries only — no new traffic, no server calls. This is LAB data from the user's own browser
// load, not CrUX; the panel says so (pageLabNote).
//
// LCP: the last buffered largest-contentful-paint entry.
// FCP: the first-contentful-paint paint entry.
// TTFB: navigation responseStart − startTime (minus activationStart when the doc was
//       prerendered), per the web-vitals library's definition.
// CLS: layout-shift entries without hadRecentInput, summed per session window (5 s window,
//       1 s gap, take the max — the web-vitals session-window algorithm). 0 is a real "no
//       shifts" value; null means the browser reported no layout-shift support at all.
// INP: needs interaction — never measured here, always null (the panel explains).
// transferKb: transferSize of navigation + resources; null (not 0) when everything reports 0
//             (cross-origin resources without Timing-Allow-Origin).

var ExtVitals = (function () {
  "use strict";

  var SESSION_WINDOW_MS = 5000;
  var SESSION_GAP_MS = 1000;

  function observed(view, type, cb) {
    return new Promise(function (resolve) {
      var obs;
      try {
        obs = new view.PerformanceObserver(function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) cb(entries[i]);
        });
        obs.observe({ type: type, buffered: true });
      } catch {
        resolve(); // unsupported entry type on this browser — that metric stays null
        return;
      }
      view.setTimeout(function () {
        try { obs.disconnect(); } catch { /* */ }
        resolve();
      }, 0);
    });
  }

  function collect() {
    var view = globalThis;

    var lcp = null;
    var fcp = null;
    var seenShiftSupport = false;
    var clsValue = 0;     // the max session value seen
    var clsCur = 0;       // value of the session in progress
    var clsFirstTs = 0;   // first shift of the session in progress
    var clsPrevTs = 0;    // previous shift

    function clsStep(entry) {
      seenShiftSupport = true;
      if (entry.hadRecentInput) return;
      if (clsFirstTs && entry.startTime - clsPrevTs > SESSION_GAP_MS &&
          entry.startTime - clsFirstTs > SESSION_WINDOW_MS) {
        clsValue = Math.max(clsValue, clsCur);
        clsCur = 0;
        clsFirstTs = entry.startTime;
      }
      if (!clsFirstTs) clsFirstTs = entry.startTime;
      clsPrevTs = entry.startTime;
      clsCur += entry.value;
    }

    return Promise.all([
      observed(view, "largest-contentful-paint", function (e) { lcp = e.startTime; }),
      observed(view, "paint", function (e) { if (e.name === "first-contentful-paint") fcp = e.startTime; }),
      observed(view, "layout-shift", clsStep),
    ]).then(function () {
      clsValue = Math.max(clsValue, clsCur);

      if (!view.performance) {
        return { ttfb: null, fcp: fcp, lcp: lcp, cls: seenShiftSupport ? clsValue : null, inp: null, domNodes: 0, transferKb: null, source: "buffered" };
      }

      var ttfb = null;
      try {
        var nav = view.performance.getEntriesByType("navigation")[0];
        if (nav) {
          ttfb = nav.responseStart - nav.startTime;
          if (nav.activationStart > 0) ttfb -= nav.activationStart;
        }
      } catch { /* */ }

      var bytes = 0;
      var seenBytes = false;
      try {
        var navs = view.performance.getEntriesByType("navigation");
        var res = view.performance.getEntriesByType("resource");
        for (var i = 0; i < navs.length + res.length; i++) {
          var e = i < navs.length ? navs[i] : res[i - navs.length];
          if (e && typeof e.transferSize === "number") {
            seenBytes = true;
            bytes += e.transferSize;
          }
        }
      } catch { /* */ }

      var domNodes = 0;
      try { domNodes = document.getElementsByTagName("*").length; } catch { /* */ }

      return {
        ttfb: typeof ttfb === "number" && ttfb >= 0 ? Math.round(ttfb) : null,
        fcp: fcp != null ? Math.round(fcp) : null,
        lcp: lcp != null ? Math.round(lcp) : null,
        cls: seenShiftSupport ? Math.round(clsValue * 1000) / 1000 : null,
        inp: null,
        domNodes: domNodes,
        transferKb: seenBytes ? Math.round(bytes / 1024) : null,
        source: "buffered",
      };
    });
  }

  return { collect: collect };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtVitals;
