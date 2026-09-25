// OpenGSC extension — table-selection → CSV (classic script).
//
// PURE table-to-CSV conversion plus the "is the selection inside a <table>?" question. Used by
// content.js in the page's isolated world; the CSV string travels back to the popup, which
// downloads it as a file — no import into any module happens automatically (the brief's rule:
// download only, no auto-import into someone else's tables).

var ExtCsv = (function () {
  "use strict";

  /** RFC-4180-style cell escaping: quote when the value has a comma, quote, newline or CR. */
  function csvCell(value) {
    var s = String(value == null ? "" : value).replace(/\u00a0/g, " ").trim();
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** One <table> element → CSV text. th cells count as the header row they are. */
  function tableToCsv(table) {
    if (!table || !table.rows || !table.rows.length) return "";
    var lines = [];
    for (var r = 0; r < table.rows.length; r++) {
      var cells = [];
      var row = table.rows[r];
      for (var c = 0; c < row.cells.length; c++) {
        cells.push(csvCell(row.cells[c].innerText || row.cells[c].textContent || ""));
      }
      lines.push(cells.join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  /**
   * The <table> the current selection sits in, or null. A selection spanning several tables
   * resolves to the table of its anchor — the honest reading of "selection inside <table>".
   */
  function selectionTable(doc) {
    var view = doc.defaultView;
    if (!view || !view.getSelection) return null;
    var sel = view.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var node = sel.getRangeAt(0).startContainer;
    var element = node.nodeType === 1 ? node : node.parentElement;
    // Closest by hand: the isolated world still supports Element.closest, but a walk is
    // equally short and survives exotic DOMs (SVG table cells and friends).
    while (element && element !== doc.body) {
      if (element.tagName === "TABLE") return element;
      element = element.parentElement;
    }
    return null;
  }

  return { csvCell: csvCell, tableToCsv: tableToCsv, selectionTable: selectionTable };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtCsv;
