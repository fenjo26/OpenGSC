// OpenGSC extension — side panel core (wave-ext E1): the tab registry, the active-tab
// tracking and the shared ctx of CONTRACT §4.4.
//
// Which page is analyzed: the active tab of the current window — tabs.query at start, then
// tabs.onActivated / tabs.onUpdated (status "complete"), debounced 300 ms. While a new scan is
// in flight the previous result stays on screen with an "updating…" mark; the panel never
// flashes empty.
//
// Injection order (PANEL_INJECT) ends with content.js, whose completion value is the PageScan.
// chrome://, store and PDF pages are refused up front ("restricted_page"); a permission error
// distinguishes "no_permission" (offer the two buttons) from "injection_failed" (raw message).
// In parallel, GET /api/ext/page fills ctx.summary (10-min cache per URL; the local scan is
// never cached — it is cheap and pages change).

var Panel = (function () {
  "use strict";

  var CR = globalThis.chrome || globalThis.browser;

  var PANEL_INJECT = ["lib/audit.js", "lib/csv.js", "lib/vitals.js", "lib/donor.js", "content.js"];

  var SUMMARY_TTL = 10 * 60 * 1000;
  var DEBOUNCE_MS = 300;

  var RESTRICTED = /^(chrome|edge|chrome-extension|view-source|devtools|about|moz-extension):/i;
  var STORE_HOSTS = ["chrome.google.com", "chromewebstore.google.com", "addons.mozilla.org", "microsoftedge.microsoft.com"];

  var tabs = [];               // registered tab modules, sorted by order
  var state = {
    tabId: null,
    url: "",
    scan: null,
    scanError: null,
    scanning: false,
    summary: null,
    summaryError: "",
    settings: null,
    activeTab: null,           // registered tab id shown
    highlightOn: false,
    highlightSpec: { images_no_alt: true, h1: true, nofollow: false, external: false, empty_links: false },
  };
  var debounceTimer = 0;
  var scanSeq = 0;             // staleness guard: only the newest scan may render

  function msg(key, subs) {
    return CR.i18n.getMessage(key, subs) || key;
  }

  // ─── chrome.storage.session cache with a TTL — ctx.cache ───────────────────────

  function cacheGet(key) {
    return new Promise(function (resolve) {
      if (!CR.storage.session || !CR.storage.session.get) { resolve(null); return; }
      CR.storage.session.get(["cache:" + key], function (stored) {
        var hit = stored && stored["cache:" + key];
        resolve(hit && hit.exp > Date.now() ? hit.value : null);
      });
    });
  }

  function cacheSet(key, value, ttlMs) {
    return new Promise(function (resolve) {
      if (!CR.storage.session || !CR.storage.session.set) { resolve(); return; }
      var bag = {};
      bag["cache:" + key] = { value: value, exp: Date.now() + (ttlMs || 600000) };
      CR.storage.session.set(bag, function () { resolve(); });
    });
  }

  // ─── registry ──────────────────────────────────────────────────────────────────

  function register(tab) {
    tabs.push(tab);
    tabs.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }

  function currentCtx() {
    return {
      tabId: state.tabId,
      url: state.url,
      scan: state.scan,
      scanError: state.scanError,
      scanErrorText: state.scanErrorText || "",
      summary: state.summary,
      settings: state.settings,
      api: ExtApi,
      msg: msg,
      refresh: refresh,
      cache: { get: cacheGet, set: cacheSet },
      document: document,
    };
  }

  // ─── tiny DOM helpers (textContent only — page data never goes through innerHTML) ──

  function tag(name, className, text) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function iconButton(id, svg, titleKey) {
    var b = tag("button", "icon-btn");
    b.id = id;
    b.type = "button";
    b.title = msg(titleKey);
    b.innerHTML = svg; // static SVG strings defined here, never page data
    return b;
  }

  // ─── scanning ──────────────────────────────────────────────────────────────────

  function isRestricted(url) {
    if (!url || RESTRICTED.test(url)) return true;
    try {
      var u = new URL(url);
      if (STORE_HOSTS.indexOf(u.host) !== -1) return true;
      if (/\.pdf$/i.test(u.pathname)) return true;
    } catch { return true; }
    return false;
  }

  function scanNow() {
    var seq = ++scanSeq;
    var tabId = state.tabId;
    var url = state.url;

    markScanning(true);

    var done = function (patch) {
      if (seq !== scanSeq) return; // a newer scan superseded this one
      markScanning(false);
      Object.assign(state, patch);
      render();
    };

    if (isRestricted(url)) {
      state.scan = null;
      done({ scan: null, scanError: "restricted_page" });
      return;
    }

    CR.scripting.executeScript(
      { target: { tabId: tabId }, files: PANEL_INJECT },
      function (results) {
        var err = CR.runtime.lastError ? String(CR.runtime.lastError.message || "") : "";
        var payload = !err && results && results[0] && results[0].result;
        if (payload && payload.ok) {
          done({ scan: payload, scanError: null });
          return;
        }
        if (/permission|cannot access|host permission/i.test(err)) {
          done({ scan: null, scanError: "no_permission" });
        } else {
          done({ scan: null, scanError: "injection_failed", scanErrorText: err || "no result" });
        }
      }
    );

    // The server half, in parallel; cached 10 min per URL. A missing instance is not an error
    // for the panel — the page scan works without it, the header shows the connect hint.
    ExtApi.getSettings().then(function (s) {
      if (!s.baseUrl || !s.token) {
        if (seq === scanSeq) { state.summary = null; state.summaryError = "not_configured"; render(); }
        return;
      }
      var key = "summary:" + url;
      cacheGet(key).then(function (cached) {
        if (cached && seq === scanSeq) {
          state.summary = cached;
          state.summaryError = "";
          render();
        }
        ExtApi.page(url).then(function (res) {
          if (seq !== scanSeq) return;
          if (res.status === 200 && res.data && !res.data.error) {
            state.summary = res.data;
            state.summaryError = "";
            cacheSet(key, res.data, SUMMARY_TTL);
          } else if (!cached) {
            state.summary = null;
            state.summaryError = String((res.data && res.data.error) || res.status || "network");
          }
          render();
        });
      });
    });
  }

  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanNow, DEBOUNCE_MS);
  }

  function refresh() {
    clearTimeout(debounceTimer);
    scanNow();
  }

  function markScanning(on) {
    state.scanning = on;
    var badge = document.getElementById("updating");
    if (badge) badge.classList.toggle("vis", on);
  }

  // ─── header ────────────────────────────────────────────────────────────────────

  var SVGS = {
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
    hl: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L8 21H5v-3z"/><path d="m12.2 6.2 5.6 5.6"/><circle cx="17.5" cy="6.5" r="2.5"/></svg>',
    dl: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  };

  function buildHeader() {
    var head = document.querySelector(".head");
    head.textContent = "";

    var favicon = tag("img", "favicon");
    favicon.alt = "";
    favicon.src = /^https?:/i.test(state.url || "") ? "https://www.google.com/s2/favicons?sz=32&domain=" + encodeURIComponent(hostOf(state.url)) : "";
    favicon.onerror = function () { favicon.style.visibility = "hidden"; };
    head.appendChild(favicon);

    head.appendChild(tag("span", "host", hostOf(state.url) || "—"));
    head.appendChild(tag("span", "updating", msg("panelUpdating")));

    head.appendChild(highlightControl());
    head.appendChild(exportControl());

    var refreshBtn = iconButton("refresh", SVGS.refresh, "panelRefresh");
    refreshBtn.addEventListener("click", function () { refresh(); });
    head.appendChild(refreshBtn);

    var gear = iconButton("settings", SVGS.gear, "optionsIntro");
    gear.addEventListener("click", function () { CR.runtime.openOptionsPage(); });
    head.appendChild(gear);
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return ""; }
  }

  function highlightControl() {
    var wrap = tag("div", "menu");
    var btn = iconButton("hlBtn", SVGS.hl, "panelHighlight");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!state.scan) return;
      state.highlightOn = !state.highlightOn;
      btn.classList.toggle("on", state.highlightOn);
      applyHighlight();
    });
    wrap.appendChild(btn);

    var drop = tag("div", "drop");
    var kinds = [
      ["images_no_alt", "hlImagesNoAlt"],
      ["h1", "hlH1"],
      ["nofollow", "hlNofollow"],
      ["external", "hlExternal"],
      ["empty_links", "hlEmptyLinks"],
    ];
    kinds.forEach(function (pair) {
      var label = tag("label", "drop-item");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state.highlightSpec[pair[0]];
      cb.addEventListener("change", function () {
        state.highlightSpec[pair[0]] = cb.checked;
        if (state.highlightOn) applyHighlight();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(msg(pair[1])));
      drop.appendChild(label);
    });
    wrap.appendChild(drop);
    return wrap;
  }

  function applyHighlight() {
    if (state.tabId == null) return;
    var spec = state.highlightOn ? state.highlightSpec : {};
    CR.scripting.executeScript(
      {
        target: { tabId: state.tabId },
        func: globalThis.ExtHighlight ? ExtHighlight.apply : function () { return 0; },
        args: [spec],
      },
      function () { void CR.runtime.lastError; }
    );
  }

  function exportControl() {
    var wrap = tag("div", "menu");
    var btn = iconButton("exportBtn", SVGS.dl, "panelExport");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      wrap.classList.toggle("open");
    });
    wrap.appendChild(btn);

    var drop = tag("div", "drop right");
    var items = [
      ["exportLinks", exportLinks],
      ["exportImages", exportImages],
      ["exportHeadings", exportHeadings],
      ["exportJson", exportJson],
    ];
    items.forEach(function (pair) {
      var it = tag("button", "drop-item");
      it.type = "button";
      it.textContent = msg(pair[0]);
      it.addEventListener("click", function () {
        wrap.classList.remove("open");
        pair[1]();
      });
      drop.appendChild(it);
    });
    wrap.appendChild(drop);
    return wrap;
  }

  function scanDetail() {
    return state.scan && state.scan.facts && state.scan.facts.detail;
  }

  function exportLinks() {
    var d = scanDetail();
    if (!d) return;
    var rows = [["anchor", "url", "rel", "internal", "area"]];
    d.links.forEach(function (l) {
      rows.push([l.text, l.href, (l.rel || []).join(" "), l.internal ? "1" : "0", l.area]);
    });
    ExtExport.csv(hostOf(state.url), "links", rows);
  }

  function exportImages() {
    var d = scanDetail();
    if (!d) return;
    var rows = [["src", "alt", "width", "height", "format", "lazy", "area"]];
    d.images.forEach(function (i) {
      rows.push([i.src, i.alt == null ? "" : i.alt, String(i.width), String(i.height), i.ext, i.lazy ? "1" : "0", i.area]);
    });
    ExtExport.csv(hostOf(state.url), "images", rows);
  }

  function exportHeadings() {
    var d = scanDetail();
    if (!d) return;
    var rows = [["level", "text", "hidden"]];
    d.headings.forEach(function (h) {
      rows.push(["H" + h.level, h.text, h.hidden ? "1" : "0"]);
    });
    ExtExport.csv(hostOf(state.url), "headings", rows);
  }

  function exportJson() {
    if (!state.scan) return;
    ExtExport.json(hostOf(state.url), "scan", state.scan);
  }

  // ─── rendering ─────────────────────────────────────────────────────────────────

  function render() {
    buildHeader();
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    var nav = document.getElementById("tabs");
    nav.textContent = "";
    var ctx = currentCtx();
    var visible = tabs.filter(function (t) { return !t.applies || t.applies(ctx); });
    if (state.activeTab && !visible.some(function (t) { return t.id === state.activeTab; })) {
      state.activeTab = null;
    }
    visible.forEach(function (t) {
      var b = tag("button", state.activeTab === t.id ? "active" : "");
      b.textContent = msg(t.labelKey);
      b.addEventListener("click", function () {
        state.activeTab = t.id;
        renderTabs();
        renderBody();
      });
      nav.appendChild(b);
    });
    return visible;
  }

  function renderBody() {
    var root = document.getElementById("body");
    root.textContent = "";
    var ctx = currentCtx();

    // The instance hint rides above every tab when OpenGSC is not connected.
    if (state.summaryError === "not_configured") {
      var hint = tag("div", "hint-card", msg("panelConnectHint"));
      root.appendChild(hint);
    }

    var visible = tabs.filter(function (t) { return !t.applies || t.applies(ctx); });
    var tab = visible.find(function (t) { return t.id === state.activeTab; }) || visible[0];
    if (!tab) {
      root.appendChild(tag("div", "soon", msg("panelSoon")));
      return;
    }
    state.activeTab = tab.id;

    var pane = tag("div", "pane");
    root.appendChild(pane);
    if (tab.dispose) { try { tab.dispose(); } catch { /* */ } }
    var out = tab.render(pane, ctx);
    if (out && typeof out.then === "function") out.catch(function () { /* a render error leaves the pane as-is */ });
  }

  // ─── active-tab wiring ─────────────────────────────────────────────────────────

  function applyTabInfo(tab) {
    if (!tab) return;
    var url = String(tab.url || "");
    var changed = url !== state.url || tab.id !== state.tabId;
    state.tabId = tab.id != null ? tab.id : null;
    state.url = url;
    if (changed) {
      state.scan = null;
      state.scanError = null;
      state.summary = null;
      state.summaryError = "";
      state.highlightOn = false;
      scheduleScan();
    }
    render();
  }

  function activeTab() {
    return new Promise(function (resolve) {
      CR.tabs.query({ active: true, currentWindow: true }, function (found) {
        resolve(found && found[0]);
      });
    });
  }

  function start() {
    ExtSettings.get().then(function (s) {
      state.settings = s;
      activeTab().then(applyTabInfo);
    });

    CR.tabs.onActivated.addListener(function () {
      activeTab().then(applyTabInfo);
    });
    CR.tabs.onUpdated.addListener(function (_id, info, tab) {
      if (info.status !== "complete" || !tab.active) return;
      activeTab().then(applyTabInfo);
    });

    // The header is rebuilt on every render, so the refresh button is matched by delegation.
    document.addEventListener("click", function (e) {
      var target = e.target;
      if (target && target.closest && target.closest("#refresh")) { refresh(); return; }
      document.querySelectorAll(".menu.open").forEach(function (m) { m.classList.remove("open"); });
    });
  }

  return {
    register: register,
    start: start,
    refresh: refresh,
    ctx: currentCtx,
    PANEL_INJECT: PANEL_INJECT,
  };
})();

document.addEventListener("DOMContentLoaded", function () { Panel.start(); });

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = Panel;
