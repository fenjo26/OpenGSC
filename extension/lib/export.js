// OpenGSC extension — CSV/JSON export from the panel (wave-ext E1).
//
// Downloads happen inside the panel (a Blob + <a download> click); a content script could not
// trigger them. CSV text goes out with a BOM so Excel opens UTF-8 (Greek/Cyrillic anchors)
// correctly; escaping itself is lib/csv.js's csvCell, already used by the N11 table handoff.

var ExtExport = (function () {
  "use strict";

  function today() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  /** Safe file stem from a host: example.co.uk → example.co.uk (hostile chars dropped). */
  function stem(host) {
    return String(host || "page").toLowerCase().replace(/[^a-z0-9.-]+/g, "_").slice(0, 60);
  }

  /** rows: string[][] — the first row is the header. Adds the UTF-8 BOM Excel needs. */
  function csv(host, what, rows) {
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      for (var j = 0; j < rows[i].length; j++) {
        cells.push(ExtCsv.csvCell(rows[i][j]));
      }
      lines.push(cells.join(","));
    }
    download(stem(host) + "_" + what + "_" + today() + ".csv",
      "\uFEFF" + lines.join("\r\n") + "\r\n", "text/csv;charset=utf-8");
  }

  function json(host, what, value) {
    download(stem(host) + "_" + what + "_" + today() + ".json",
      JSON.stringify(value, null, 2), "application/json;charset=utf-8");
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  return { csv: csv, json: json, download: download };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtExport;
