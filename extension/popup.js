// OpenGSC extension — popup logic (classic script).
//
// The popup is two independent gathers over the active tab, rendered as each lands:
//   • the server summary — GET /api/ext/page (portfolio metrics, index status, audit issues,
//     tracked ranks) — only when the page belongs to the portfolio;
//   • the mini audit — content.js runs in the tab itself and computes everything locally.
// On Search Console and PageSpeed neither runs: those pages get exactly one button
// ("open this URL in OpenGSC"), because parsing foreign UIs is a contract we don't make.
//
// Buttons are wired ONCE and read the mutable `state` at click time — whichever gather is
// still in flight simply hasn't influenced the button label yet, and never double-binds.

var CR = globalThis.chrome || globalThis.browser;

function msg(key, substitutions) {
  return CR.i18n.getMessage(key, substitutions) || key;
}

function el(id) { return document.getElementById(id); }

function applyI18n(root) {
  var nodes = (root || document).querySelectorAll("[data-i18n]");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = msg(nodes[i].getAttribute("data-i18n"));
  }
}

function cloneTemplate(id) {
  var node = el(id).content.firstElementChild.cloneNode(true);
  applyI18n(node);
  return node;
}

function showState(templateId) {
  var main = el("content");
  main.textContent = "";
  main.appendChild(cloneTemplate(templateId));
  return main.firstElementChild;
}

// ─── tiny DOM builders — textContent only, never innerHTML with page data ───────

function tag(name, className, text) {
  var node = document.createElement(name);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function kvRow(key, value) {
  var row = tag("div", "kv");
  row.appendChild(tag("span", "k", key));
  row.appendChild(tag("span", "v", value));
  return row;
}

function pill(text, kind, title) {
  var node = tag("span", "pill" + (kind ? " " + kind : ""), text);
  if (title) node.title = title;
  return node;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch (e) {
    return "—";
  }
}

// ─── the server summary (п.1) ────────────────────────────────────────────────────

function renderSummary(container, data, baseUrl) {
  var site = data.site || {};

  var link = tag("a", "link", msg("openInApp"));
  link.href = baseUrl + (site.openPath || "/");
  link.target = "_blank";
  link.rel = "noopener";
  container.appendChild(link);

  if (data.metrics) {
    var metrics = tag("div", "metrics");
    var addMetric = function (value, labelKey) {
      var cell = tag("div", "metric");
      cell.appendChild(tag("div", "n", String(value)));
      cell.appendChild(tag("div", "l", msg(labelKey)));
      metrics.appendChild(cell);
    };
    addMetric(Number(data.metrics.clicks || 0).toLocaleString(), "metricClicks");
    addMetric(Number(data.metrics.impressions || 0).toLocaleString(), "metricImpressions");
    addMetric(data.metrics.avgPosition != null ? data.metrics.avgPosition : "—", "metricPosition");
    container.appendChild(metrics);
  } else {
    container.appendChild(tag("div", "muted", msg("noMetrics").replace("{n}", String(data.windowDays || 28))));
  }

  if (data.index) {
    container.appendChild(kvRow(msg("indexStatus"), fmtDate(data.index.checkedAt)));
  }

  if (data.topQueries && data.topQueries.length) {
    var list = tag("ul", "queries");
    for (var i = 0; i < data.topQueries.length; i++) {
      var q = data.topQueries[i];
      var li = tag("li", null);
      li.appendChild(tag("span", "q", q.query));
      li.appendChild(tag("span", "c", String(q.clicks) + " · " + msg("posShort") + " " + (q.position != null ? q.position : "—")));
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  if (data.audit && data.audit.issues && data.audit.issues.length) {
    container.appendChild(kvRow(msg("serverAudit"),
      String(data.audit.issues.length) + " · " + fmtDate(data.audit.auditedAt)));
  }

  if (data.ranks && data.ranks.length) {
    var ranks = tag("ul", "ranks");
    for (var r = 0; r < data.ranks.length; r++) {
      var k = data.ranks[r];
      var row = tag("li", null);
      var label = tag("span", "q", k.keyword);
      if (k.location) label.appendChild(tag("span", "loc", " · " + k.location));
      row.appendChild(label);
      var pos = tag("span", "pos", "#" + (k.position != null ? k.position : "—"));
      if (k.localPack) pos.appendChild(tag("span", "loc", " · " + msg("localPackShort") + k.localPack));
      row.appendChild(pos);
      ranks.appendChild(row);
    }
    container.appendChild(ranks);
  }
}

function renderSitePills(row, summaryData, auditPayload) {
  if (summaryData && summaryData.inPortfolio) {
    row.appendChild(pill(summaryData.site && summaryData.site.label ? summaryData.site.label : msg("yourSite"), "blue",
      summaryData.site && summaryData.site.siteId));
  }
  if (summaryData && summaryData.index) {
    if (summaryData.index.indexed === true) row.appendChild(pill(msg("indexIndexed"), "good"));
    else if (summaryData.index.indexed === false) row.appendChild(pill(msg("indexNotIndexed"), "bad", summaryData.index.status || ""));
    else row.appendChild(pill(msg("indexUnknown"), "unknown", summaryData.index.status || msg("indexUnknownTitle")));
  }
  if (auditPayload && auditPayload.issues) {
    var counts = ExtensionAudit.countSeverities(auditPayload.issues);
    var kind = counts.error ? "bad" : counts.warn ? "" : "good";
    row.appendChild(pill(msg("auditPill", [String(counts.error), String(counts.warn)]), kind));
  }
}

// ─── the mini audit (п.2) ────────────────────────────────────────────────────────

function renderAudit(container, payload) {
  if (!payload) {
    container.appendChild(tag("div", "muted", msg("auditUnavailable")));
    return;
  }
  var issues = payload.issues || [];
  if (!issues.length) {
    var okRow = tag("div", "issue okrow");
    okRow.appendChild(tag("span", "dot"));
    okRow.appendChild(tag("span", "what", msg("auditAllOk")));
    container.appendChild(okRow);
  }
  for (var i = 0; i < issues.length; i++) {
    var issue = issues[i];
    var row = tag("div", "issue " + issue.severity);
    row.appendChild(tag("span", "dot"));
    var what = tag("span", "what", msg("audit_" + issue.id));
    if (issue.detail) what.appendChild(tag("span", "detail", " (" + issue.detail + ")"));
    row.appendChild(what);
    container.appendChild(row);
  }

  var facts = payload.facts || {};
  container.appendChild(kvRow(msg("factWords"), String(facts.words || 0).toLocaleString()));
  container.appendChild(kvRow(msg("factLinks"),
    String(facts.links ? facts.links.total : 0) + " (" + (facts.links ? facts.links.internal : 0) + " / " + (facts.links ? facts.links.external : 0) + ")"));
  container.appendChild(kvRow(msg("factHreflang"), String(facts.hreflang ? facts.hreflang.length : 0)));
  container.appendChild(kvRow(msg("factJsonLd"), (facts.jsonLdValid || 0) + " ✓ / " + (facts.jsonLdInvalid || 0) + " ✕"));
  if (facts.canonical) container.appendChild(kvRow("canonical", facts.canonical));
}

// ─── CSV download ────────────────────────────────────────────────────────────────

function csvFileName(url) {
  var host = "page";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { /* keep default */ }
  return "opengsc-" + host + "-" + new Date().toISOString().slice(0, 10) + ".csv";
}

function downloadCsv(csv, name) {
  var blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}

// ─── boot ────────────────────────────────────────────────────────────────────────

function isSpecialHost(url) {
  // Brief п.4: Search Console and PageSpeed get one button and nothing else. We do not
  // parse their UIs — it changes without warning, and the GSC data is already in the app.
  try {
    var u = new URL(url);
    if (u.hostname === "search.google.com" && u.pathname.indexOf("/search-console") === 0) return true;
    if (u.hostname === "pagespeed.web.dev") return true;
  } catch (e) { /* not a URL */ }
  return false;
}

document.addEventListener("DOMContentLoaded", function () {
  applyI18n(document);
  el("openOptions").addEventListener("click", function (e) { e.preventDefault(); CR.runtime.openOptionsPage(); });

  ExtApi.getSettings().then(function (settings) {
    if (!settings.baseUrl || !settings.token) {
      var st = showState("tplConfigure");
      st.querySelector("#btnOpenOptions2").addEventListener("click", function () { CR.runtime.openOptionsPage(); });
      return;
    }

    CR.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
        showState("tplUnsupported");
        return;
      }

      if (isSpecialHost(tab.url)) {
        var special = showState("tplSpecial");
        special.querySelector("#btnOpenApp").addEventListener("click", function () {
          CR.tabs.create({ url: settings.baseUrl + "/" });
        });
        return;
      }

      var root = cloneTemplate("tplMain");
      var main = el("content");
      main.textContent = "";
      main.appendChild(root);

      var urlNode = root.querySelector("#pageUrl");
      urlNode.textContent = tab.url;
      urlNode.title = tab.url;
      root.querySelector("#instanceLabel").textContent = settings.baseUrl.replace(/^https?:\/\//, "");

      var summaryBody = root.querySelector("#summaryBody");
      var auditBody = root.querySelector("#auditBody");
      var pillRow = root.querySelector("#sitePills");
      var resultNode = root.querySelector("#actionResult");
      var btnSend = root.querySelector("#btnSend");
      var btnKeywords = root.querySelector("#btnKeywords");
      var btnCsv = root.querySelector("#btnCsv");

      // summary: null until the API answers; data: the parsed body; audit: content payload.
      var state = { summary: null, audit: null };

      function refreshPills() {
        pillRow.textContent = "";
        var summaryData = state.summary && state.summary.status === 200 ? state.summary.data : null;
        renderSitePills(pillRow, summaryData, state.audit);
      }

      function showError(text) {
        var err = showState("tplError");
        err.querySelector("#errorText").textContent = text;
        err.querySelector("#btnOpenOptions3").addEventListener("click", function () { CR.runtime.openOptionsPage(); });
      }

      // ── actions, wired once; handlers read `state` at click time ──
      function setResult(text, kind) {
        resultNode.textContent = text;
        resultNode.className = "actionResult" + (kind ? " " + kind : "");
      }

      btnSend.addEventListener("click", function () {
        btnSend.disabled = true;
        var finish = function (text, kind) { setResult(text, kind); btnSend.disabled = false; };
        var summaryData = state.summary && state.summary.status === 200 ? state.summary.data : null;
        if (summaryData && summaryData.inPortfolio) {
          ExtApi.indexQueue(tab.url).then(function (res) {
            if (res.status === 200 && res.data && res.data.queued) finish(msg("sentQueued"), "ok");
            else if (res.status === 200 && res.data && res.data.reason) finish(msg("sendReason_" + res.data.reason) || res.data.reason, "err");
            else if (res.status === 401) finish(msg("errAuth"), "err");
            else if (res.status === 403) finish(msg("errOrigin"), "err");
            else finish(msg("sendFailed"), "err");
          });
        } else if (summaryData) {
          var note = state.audit && state.audit.selection ? state.audit.selection.text : "";
          ExtApi.outreach(tab.url, note).then(function (res) {
            if (res.status === 200 && res.data && res.data.ok) {
              finish(res.data.created ? msg("sentProspect") : msg("sentProspectExisting"), "ok");
            } else if (res.status === 400 && res.data && res.data.error === "own_site") {
              finish(msg("sendReason_own_site"), "err");
            } else if (res.status === 401) finish(msg("errAuth"), "err");
            else if (res.status === 403) finish(msg("errOrigin"), "err");
            else finish(msg("sendFailed"), "err");
          });
        } else {
          finish(msg("sendWaiting"), "");
        }
      });

      btnKeywords.addEventListener("click", function () {
        var text = state.audit && state.audit.selection ? state.audit.selection.text : "";
        if (!text) return;
        CR.tabs.create({ url: settings.baseUrl + "/seo-tools/outline?keyword=" + encodeURIComponent(text.slice(0, 200)) });
      });

      btnCsv.addEventListener("click", function () {
        var sel = state.audit && state.audit.selection;
        if (!sel || !sel.csv) return;
        downloadCsv(sel.csv, csvFileName(tab.url));
        setResult(msg("csvSaved"), "ok");
      });

      // The send button's label depends on the summary; set it when the summary lands.
      function refreshSendLabel() {
        var summaryData = state.summary && state.summary.status === 200 ? state.summary.data : null;
        if (summaryData && summaryData.inPortfolio) btnSend.textContent = msg("sendOwn");
        else if (summaryData) btnSend.textContent = msg("sendForeign");
      }

      // ── gather A: the server summary ──
      ExtApi.page(tab.url).then(function (res) {
        state.summary = res;
        if (res.status === 200 && res.data) {
          if (res.data.notMigrated) {
            summaryBody.appendChild(tag("div", "muted", msg("notMigrated")));
          } else if (res.data.inPortfolio) {
            renderSummary(summaryBody, res.data, settings.baseUrl);
          } else {
            summaryBody.appendChild(tag("div", "muted", msg("notInPortfolio")));
          }
        } else if (res.status === 401) {
          showError(msg("errAuth"));
          return;
        } else if (res.status === 403) {
          showError(msg("errOrigin"));
          return;
        } else if (res.status === 0) {
          showError(msg("errNetwork").replace("{url}", settings.baseUrl));
          return;
        } else {
          summaryBody.appendChild(tag("div", "muted", msg("sendFailed") + " (" + res.status + ")"));
        }
        refreshSendLabel();
        refreshPills();
      });

      // ── gather B: the local mini audit ──
      CR.scripting.executeScript(
        { target: { tabId: tab.id }, files: ["lib/audit.js", "lib/csv.js", "content.js"] },
        function (results) {
          var payload = results && results[0] && results[0].result;
          state.audit = payload && payload.ok ? payload : null;
          renderAudit(auditBody, state.audit);

          var sel = state.audit && state.audit.selection;
          if (sel && sel.text) btnKeywords.hidden = false;
          if (sel && sel.inTable && sel.csv) btnCsv.hidden = false;

          refreshPills();
        }
      );

      // A CSV the background staged from the context menu while the popup was closed.
      CR.storage.local.get(["lastCsv"], function (stored) {
        var last = stored && stored.lastCsv;
        if (!last || !last.csv || Date.now() - (last.at || 0) > 300000) return;
        var row = tag("div", "actions");
        var btn = tag("button", "ghost", msg("downloadCsvStaged"));
        btn.addEventListener("click", function () {
          downloadCsv(last.csv, csvFileName(last.url || tab.url));
          CR.storage.local.remove("lastCsv");
          row.remove();
        });
        row.appendChild(btn);
        root.appendChild(row);
      });
    });
  });
});
