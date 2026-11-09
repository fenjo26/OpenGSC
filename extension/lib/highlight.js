// OpenGSC extension — on-page problem highlighting (wave-ext E1 owns this file).
// E0 lays the no-op shape: apply/clear must always exist because panel tabs call them.

var ExtHighlight = {
  /** Highlight problem elements inside ONE shadow host appended to body — never a class or an
   *  attribute on the page's own elements. E1 implements it; the stub is a silent no-op. */
  apply: function (_spec) { return null; },
  /** Remove the host and its listeners; repeatable. */
  clear: function () { return null; },
};

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtHighlight;
