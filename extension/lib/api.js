// OpenGSC extension — shared API client (classic script; loaded by popup.html via <script>
// and by the background service worker via importScripts).
//
// Every request the extension makes goes through here: Bearer token from chrome.storage.local,
// one JSON answer, no silent fallbacks. The instance URL and token are the only things the
// options page saves.
//
// This file intentionally contains no business logic: it is plumbing, the decisions live in
// popup.js / background.js, and the audit logic in lib/audit.js.

var ExtApi = (function () {
  "use strict";

  // `chrome` on Chrome and Edge (both Chromium); `browser` only if a future port needs it.
  var CR = globalThis.chrome || globalThis.browser;
  if (!CR || !CR.storage) {
    // Loaded outside an extension (e.g. a future test harness) — degrade to inert.
    return {
      getSettings: function () { return Promise.resolve({ baseUrl: "", token: "" }); },
      saveSettings: function () { return Promise.resolve(); },
      request: function () { return Promise.resolve({ status: 0, data: { error: "no_extension_apis" } }); },
    };
  }

  function normalizeBase(url) {
    var value = String(url || "").trim().replace(/\/+$/, "");
    if (value && !/^https?:\/\//i.test(value)) value = "https://" + value;
    return value;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      CR.storage.local.get(["baseUrl", "token"], function (stored) {
        resolve({
          baseUrl: normalizeBase(stored && stored.baseUrl),
          token: String((stored && stored.token) || "").trim(),
        });
      });
    });
  }

  function saveSettings(settings) {
    return new Promise(function (resolve) {
      CR.storage.local.set({
        baseUrl: normalizeBase(settings.baseUrl),
        token: String(settings.token || "").trim(),
      }, function () { resolve(); });
    });
  }

  /**
   * One /api/ext call. Resolves { status, data } — network failure resolves too, with
   * status 0, so callers render "server unreachable" instead of an uncaught promise.
   */
  function request(method, path, body) {
    return getSettings().then(function (s) {
      if (!s.baseUrl || !s.token) return { status: 0, data: { error: "not_configured" } };
      var init = {
        method: method,
        headers: {
          "Authorization": "Bearer " + s.token,
        },
      };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return fetch(s.baseUrl + path, init).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data };
        });
      }).catch(function () {
        return { status: 0, data: { error: "network" } };
      });
    });
  }

  return {
    getSettings: getSettings,
    saveSettings: saveSettings,
    normalizeBase: normalizeBase,
    request: request,
    page: function (url) { return request("GET", "/api/ext/page?url=" + encodeURIComponent(url)); },
    indexQueue: function (url) { return request("POST", "/api/ext/index-queue", { url: url }); },
    outreach: function (url, note) { return request("POST", "/api/ext/outreach", { url: url, note: note || "" }); },
  };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtApi;
