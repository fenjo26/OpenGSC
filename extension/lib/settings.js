// OpenGSC extension — settings + optional permissions (wave-ext E0).
//
// Everything beyond the N11 pair (baseUrl/token) lives here, under one chrome.storage.local key
// ("extSettings"): side-panel behaviour, the SERP overlay and its Google domains, the default
// site/project for the overlay's action buttons.
//
// Permissions stay strictly opt-in: on install the extension has no standing host permissions.
// "All sites" (for the panel) and the enabled Google domains (for the overlay) are requested
// from a click handler — requestAllSites()/requestSerpDomains() MUST be called from one, or
// Chrome silently rejects the prompt. syncOverlayRegistration() (un)registers the overlay's
// content script to match the settings + what the user later revoked in chrome://extensions.

var ExtSettings = (function () {
  "use strict";

  var CR = globalThis.chrome || globalThis.browser;
  var KEY = "extSettings";
  var OVERLAY_SCRIPT_ID = "opengsc-serp";

  var DEFAULTS = {
    panelAllSites: false,        // true only after chrome.permissions.request({origins:["http://*/*","https://*/*"]}) succeeded
    serpOverlay: false,          // on/off
    serpDomains: ["www.google.com"], // subset of GOOGLE_SEARCH_HOSTS the user enabled AND granted
    serpCompact: false,          // one-line chips only
    defaultSiteId: "",           // Site.id for "Track in Rank Tracker" when no own site is on the SERP
    defaultProjectId: ""         // SerpProject.id for "Add to SERP Monitor"
  };

  function storage() {
    return CR && CR.storage && CR.storage.local
      ? CR.storage.local
      : { get: function (_a, cb) { cb({}); }, set: function (_o, cb) { cb(); } };
  }

  function get() {
    return new Promise(function (resolve) {
      storage().get([KEY], function (stored) {
        var saved = (stored && stored[KEY]) || {};
        var out = {};
        for (var k in DEFAULTS) out[k] = saved[k] !== undefined ? saved[k] : DEFAULTS[k];
        if (!Array.isArray(out.serpDomains)) out.serpDomains = DEFAULTS.serpDomains.slice();
        resolve(out);
      });
    });
  }

  function set(patch) {
    return get().then(function (current) {
      var next = {};
      for (var k in DEFAULTS) next[k] = patch[k] !== undefined ? patch[k] : current[k];
      return new Promise(function (resolve) {
        var bag = {};
        bag[KEY] = next;
        storage().set(bag, function () {
          resolve(next);
          if (CR && CR.runtime && CR.runtime.sendMessage) {
            // Tell the panel/background a setting changed. No listener → "message port closed"
            // noise in some contexts; the promise rejection is swallowed on purpose.
            try { CR.runtime.sendMessage({ type: "ext:settings-changed" }, function () { void CR.runtime.lastError; }); }
            catch { /* worker asleep — it re-reads settings on wake */ }
          }
        });
      });
    });
  }

  /** Must run inside a click handler. Grants the standing "all sites" host permission. */
  function requestAllSites() {
    return new Promise(function (resolve) {
      if (!CR || !CR.permissions || !CR.permissions.request) { resolve(false); return; }
      CR.permissions.request({ origins: ["http://*/*", "https://*/*"] }, function (granted) {
        resolve(!!granted);
      });
    });
  }

  /** Must run inside a click handler. Grants the origin patterns of the given Google hosts. */
  function requestSerpDomains(hosts) {
    return new Promise(function (resolve) {
      if (!CR || !CR.permissions || !CR.permissions.request) { resolve([]); return; }
      var list = (hosts || []).filter(Boolean);
      if (!list.length) { resolve([]); return; }
      CR.permissions.request({ origins: list.map(function (h) { return "https://" + h + "/*"; }) }, function (granted) {
        resolve(granted ? list.slice() : []);
      });
    });
  }

  function hasOrigin(pattern) {
    return new Promise(function (resolve) {
      if (!CR || !CR.permissions || !CR.permissions.contains) { resolve(false); return; }
      CR.permissions.contains({ origins: [pattern] }, function (ok) { resolve(!!ok); });
    });
  }

  function unregisterOverlay() {
    try {
      CR.scripting.unregisterContentScripts({ ids: [OVERLAY_SCRIPT_ID] }, function () {
        void CR.runtime.lastError; // "not registered" is the normal case — swallow it
      });
    } catch { /* scripting API unavailable */ }
  }

  /**
   * Keep the "opengsc-serp" content script in sync with the settings. Safe to call anywhere
   * (startup, onInstalled, after options change): with the overlay off or no granted domains it
   * unregisters; otherwise it registers or updates in place. Domains whose permission was
   * revoked in chrome://extensions are dropped from serpDomains.
   */
  function syncOverlayRegistration() {
    if (!CR || !CR.scripting || !CR.scripting.registerContentScripts) return;
    get().then(function (s) {
      if (!s.serpOverlay) { unregisterOverlay(); return; }
      var hosts = (s.serpDomains || []).filter(Boolean);
      if (!hosts.length) { unregisterOverlay(); return; }
      Promise.all(hosts.map(function (h) {
        return hasOrigin("https://" + h + "/*").then(function (ok) { return ok ? h : null; });
      })).then(function (checked) {
        var valid = checked.filter(Boolean);
        if (valid.length !== hosts.length) set({ serpDomains: valid }); // permission revoked → drop
        if (!valid.length) { unregisterOverlay(); return; }
        var spec = {
          id: OVERLAY_SCRIPT_ID,
          matches: valid.map(function (h) { return "https://" + h + "/search*"; }),
          js: ["lib/protocol.js", "lib/serpParse.js", "serp/overlay.js"],
          runAt: "document_idle",
          allFrames: false,
        };
        try {
          CR.scripting.getRegisteredContentScripts(function (regs) {
            var exists = (regs || []).some(function (r) { return r.id === OVERLAY_SCRIPT_ID; });
            var done = function () { void CR.runtime.lastError; };
            if (exists) CR.scripting.updateContentScripts([spec], done);
            else CR.scripting.registerContentScripts([spec], done);
          });
        } catch { /* unregister/reregister races are healed on the next sync */ }
      });
    });
  }

  return {
    DEFAULTS: DEFAULTS,
    get: get,
    set: set,
    requestAllSites: requestAllSites,
    requestSerpDomains: requestSerpDomains,
    hasOrigin: hasOrigin,
    syncOverlayRegistration: syncOverlayRegistration,
  };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtSettings;
