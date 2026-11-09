// OpenGSC extension — injected into the active tab (chrome.scripting.executeScript with
// PANEL_INJECT; activeTab or the standing "all sites" permission covers it).
//
// Runs in the page's ISOLATED world: reads the DOM, computes the audit locally, collects Core
// Web Vitals and donor facts, reports what the panel needs. Nothing here talks to the network —
// the panel decides what to send, and content scripts proxy through the background only.
//
// The completion value of this file is the payload the panel receives as
// InjectionResult.result (files injection returns the last script's completion value): the
// PageScan shape of CONTRACT §4.3.

(function () {
  var facts = ExtensionAudit.collectFacts(document);
  var selection = { text: "", inTable: false, csv: "" };
  try {
    var sel = window.getSelection ? window.getSelection() : null;
    var selText = sel ? String(sel.toString() || "").trim() : "";
    var table = ExtCsv.selectionTable(document);
    selection.text = selText.slice(0, 500);
    selection.inTable = !!table && !!selText;
    // Cap at 2 MB: a huge table's CSV belongs in a real export, not a popup handoff.
    selection.csv = selection.inTable ? ExtCsv.tableToCsv(table).slice(0, 2 * 1024 * 1024) : "";
  } catch {
    /* selection APIs missing (PDF viewer frame etc.) — audit still works */
  }

  // Vitals are awaited with a 1500 ms ceiling: a slow observer must not block the panel
  // forever — unresolved fields just stay null (the honest "not measured", not 0).
  var vitalsWait = Promise.race([
    ExtVitals.collect(),
    new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1500); }),
  ]);

  return vitalsWait.then(function (vitals) {
    var donor = null;
    try { donor = ExtDonor.collect(document); } catch { donor = null; }
    return {
      ok: true,
      url: location.href,
      facts: facts,
      issues: ExtensionAudit.deriveIssues(facts, vitals),
      vitals: vitals,
      donor: donor,
      selection: selection,
    };
  });
})();
