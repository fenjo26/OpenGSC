// OpenGSC extension — SERP overlay host cache (wave-ext E4). The overlay's content script
// never talks to the OpenGSC server itself (content scripts proxy everything through the
// worker); for the hosts call it uses these two messages instead of the generic ext:api, so
// the answer can be cached per query in chrome.storage.session for 10 minutes — back-
// navigation and reopens then cost nothing against the 60/min token limit.

(function () {
  "use strict";

  // Own binding: this file runs at importScripts time, before background.js assigns its CR.
  var CR = globalThis.chrome || globalThis.browser;

  var TTL_MS = 10 * 60 * 1000;
  var PREFIX = "serphosts:";

  function hashHosts(hosts) {
    var s = (hosts || []).join(",");
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  function cacheKey(body) {
    return PREFIX + [body.query || "", body.country || "", body.lang || "", hashHosts(body.hosts)].join("|");
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      if (!CR.storage.session || !CR.storage.session.get) { resolve(null); return; }
      CR.storage.session.get([key], function (stored) {
        var hit = stored && stored[key];
        resolve(hit && hit.exp > Date.now() ? hit.value : null);
      });
    });
  }

  function storageSet(key, value) {
    return new Promise(function (resolve) {
      if (!CR.storage.session || !CR.storage.session.set) { resolve(); return; }
      var bag = {};
      bag[key] = { value: value, exp: Date.now() + TTL_MS };
      CR.storage.session.set(bag, function () { resolve(); });
    });
  }

  CR.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== ExtProtocol.MSG_SERP_HOSTS) return false;
    if (!sender || sender.id !== CR.runtime.id) { sendResponse({ status: 0, data: { error: "forbidden" } }); return false; }
    var body = message.body || {};
    var key = cacheKey(body);
    storageGet(key).then(function (cached) {
      if (cached) { sendResponse(cached); return; }
      ExtApi.hosts(body).then(function (res) {
        if (res.status === 200 && res.data) void storageSet(key, res);
        sendResponse(res);
      }).catch(function () {
        sendResponse({ status: 0, data: { error: "network" } });
      });
    });
    return true; // async response
  });

  CR.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== ExtProtocol.MSG_SERP_INVALIDATE) return false;
    if (!sender || sender.id !== CR.runtime.id) { sendResponse({ ok: false }); return false; }
    if (!CR.storage.session || !CR.storage.session.get) { sendResponse({ ok: true }); return false; }
    CR.storage.session.get(null, function (stored) {
      var toDrop = Object.keys(stored || {}).filter(function (k) {
        return k.indexOf(PREFIX) === 0 && (String(message.query || "") === "" || k.indexOf(String(message.query || "")) !== -1);
      });
      if (toDrop.length) CR.storage.session.remove(toDrop);
      sendResponse({ ok: true, dropped: toDrop.length });
    });
    return true;
  });
})();
