// OpenGSC extension — CSV/JSON export from the panel (wave-ext E1 owns this file).
// E0 lays the no-op shape used by sidepanel.html's script order.

var ExtExport = {
  /** Download `content` as a file via Blob + <a download> inside the panel. E1 implements the
   *  naming (<host>_<what>_<date>.csv) and the BOM; the stub does nothing. */
  download: function (_filename, _content, _mime) { return null; },
};

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtExport;
