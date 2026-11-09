// OpenGSC extension — Core Web Vitals collected in the page (wave-ext E1 owns this file).
// E0 lays the empty shape of CONTRACT §4.3 so content.js can already reference it.

var ExtVitals = {
  /** → Promise<Vitals>; E1 fills it with PerformanceObserver work (buffered LCP/paint/layout-
   *  shift, TTFB from navigation, transfer size). The stub resolves null fields immediately. */
  collect: function () {
    return Promise.resolve({
      ttfb: null, fcp: null, lcp: null, cls: null, inp: null,
      domNodes: 0, transferKb: null, source: "buffered",
    });
  },
};

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtVitals;
