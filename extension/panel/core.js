// OpenGSC extension — side panel core: the tab registry and the shared ctx (wave-ext E0 lays
// the skeleton; E1 owns the full implementation per CONTRACT §4.4).
//
// Tab modules call Panel.register({...}) once at load; the last line of this file starts the
// panel on DOMContentLoaded. E0 renders the registered tabs (all stubs → "Coming soon") and the
// page host in the header; scanning, caching and per-tab rendering arrive with E1/E2/E3.

var Panel = (function () {
  "use strict";

  var CR = globalThis.chrome || globalThis.browser;

  var tabs = [];
  var state = {
    tabId: null,
    url: "",
    scan: null,
    scanError: null,
    summary: null,
    activeTab: null,
  };

  function msg(key, subs) {
    return CR.i18n.getMessage(key, subs) || key;
  }

  // chrome.storage.session wrapper with a TTL — the ctx.cache the briefs share.
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
      summary: state.summary,
      settings: state.settings,
      api: ExtApi,
      msg: msg,
      refresh: refresh,
      cache: { get: cacheGet, set: cacheSet },
    };
  }

  function renderTabs() {
    var nav = document.getElementById("tabs");
    if (!nav) return;
    nav.textContent = "";
    var ctx = currentCtx();
    tabs.filter(function (t) { return !t.applies || t.applies(ctx); }).forEach(function (t) {
      var b = document.createElement("button");
      b.textContent = msg(t.labelKey);
      b.className = state.activeTab === t.id ? "active" : "";
      b.addEventListener("click", function () {
        state.activeTab = t.id;
        renderTabs();
        renderBody();
      });
      nav.appendChild(b);
    });
  }

  function renderBody() {
    var root = document.getElementById("body");
    if (!root) return;
    root.textContent = "";
    var ctx = currentCtx();
    var tab = tabs.find(function (t) { return t.id === state.activeTab; })
      || tabs.find(function (t) { return !t.applies || t.applies(ctx); });
    if (!tab) {
      root.textContent = msg("panelSoon");
      return;
    }
    var box = document.createElement("div");
    box.className = "soon";
    box.textContent = msg("panelSoon");
    root.appendChild(box);
    // The stub shape matches CONTRACT §4.4: E1+ replace this with tab.render(root, ctx).
  }

  function applyTabInfo(tab) {
    if (!tab) return;
    state.tabId = tab.id != null ? tab.id : null;
    state.url = String(tab.url || "");
    var host = document.getElementById("host");
    if (host) {
      var shown = "";
      try { shown = state.url ? new URL(state.url).host : ""; } catch { shown = state.url; }
      host.textContent = shown || "—";
      host.title = state.url;
    }
    if (state.activeTab == null && tabs.length) state.activeTab = tabs[0].id;
    renderTabs();
    renderBody();
  }

  function activeTab() {
    return new Promise(function (resolve) {
      CR.tabs.query({ active: true, currentWindow: true }, function (found) {
        resolve(found && found[0]);
      });
    });
  }

  function refresh() {
    activeTab().then(applyTabInfo);
  }

  function start() {
    ExtSettings.get().then(function (s) {
      state.settings = s;
      refresh();
    });
    CR.tabs.onActivated.addListener(function () { refresh(); });
    CR.tabs.onUpdated.addListener(function (_id, info, tab) {
      if (info.status === "complete") refresh();
    });
    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("settings").addEventListener("click", function () {
      CR.runtime.openOptionsPage();
    });
  }

  return {
    register: register,
    start: start,
    refresh: refresh,
    ctx: currentCtx,
  };
})();

document.addEventListener("DOMContentLoaded", function () { Panel.start(); });

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = Panel;
