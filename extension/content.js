// OpenGSC extension — injected into the active tab (chrome.scripting.executeScript with
// files ["lib/audit.js", "lib/csv.js", "content.js"]; activeTab covers the permission).
//
// Runs in the page's ISOLATED world: reads the DOM, computes the mini audit locally, reports
// what the popup needs. Nothing here talks to the network — the popup decides what to send.
//
// The completion value of this file is the payload the popup receives as
// InjectionResult.result (files injection returns the last script's completion value).

(function () {
  var facts = ExtensionAudit.collectFacts(document);
  var issues = ExtensionAudit.deriveIssues(facts);

  var selection = { text: "", inTable: false, csv: "" };
  try {
    var sel = window.getSelection ? window.getSelection() : null;
    var selText = sel ? String(sel.toString() || "").trim() : "";
    var table = ExtCsv.selectionTable(document);
    selection.text = selText.slice(0, 500);
    selection.inTable = !!table && !!selText;
    // Cap at 2 MB: a huge table's CSV belongs in a real export, not a popup handoff.
    selection.csv = selection.inTable ? ExtCsv.tableToCsv(table).slice(0, 2 * 1024 * 1024) : "";
  } catch (e) {
    /* selection APIs missing (PDF viewer frame etc.) — audit still works */
  }

  return {
    ok: true,
    url: location.href,
    facts: facts,
    issues: issues,
    selection: selection,
  };
})();
