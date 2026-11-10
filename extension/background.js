// OpenGSC extension — background service worker (MV3, classic).
//
// wave-ext E0: this file is now the loader + the message router. The actual jobs live in bg/*:
//   • bg/menus.js — the context menu, "send to OpenGSC" and the CSV handoff (moved from here, unchanged);
//   • bg/panel.js — the side panel (open on action click, ext:open-panel);
//   • bg/serp.js  — the SERP overlay's hosts cache (wave-ext E4).
// Here: importScripts in dependency order, the ext:api proxy (the ONLY way content scripts
// reach the OpenGSC server), the legacy opengsc-send message, and overlay registration sync on
// startup/install.
//
// MV3 rule honoured throughout: every listener is registered synchronously at worker load, or
// events are lost after the worker sleeps.

// Declared BEFORE importScripts: bg/menus.js uses CR at its top level, and a hoisted-but-unassigned
// `var` here made the whole worker throw on evaluation ("Service worker registration failed.
// Status code: 15").
var CR = globalThis.chrome || globalThis.browser;

importScripts(
  "lib/i18n.js",
  "lib/api.js",
  "lib/protocol.js",
  "lib/settings.js",
  "lib/googleDomains.js",
  "bg/menus.js",
  "bg/panel.js",
  "bg/serp.js",
  "bg/redirects.js"
);


// ─── ext:api proxy — content scripts' only path to the OpenGSC server ──────────

CR.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === ExtProtocol.MSG_API) {
    // Only our own content scripts may proxy through the worker.
    if (!sender || sender.id !== CR.runtime.id) {
      sendResponse({ status: 0, data: { error: "forbidden" } });
      return false;
    }
    var path = String(message.path || "").split("?")[0];
    var allowed = ExtProtocol.API_WHITELIST.some(function (p) { return p === path; });
    if (!allowed) {
      sendResponse({ status: 0, data: { error: "path_not_allowed" } });
      return false;
    }
    ExtApi.request(message.method === "GET" ? "GET" : "POST", path, message.body)
      .then(sendResponse)
      .catch(function () { sendResponse({ status: 0, data: { error: "network" } }); });
    return true; // async response
  }

  // The popup asks the background to run the send when the user clicks the popup button —
  // one code path for the same action from both surfaces (bg/menus.js owns sendUrl).
  if (message && message.type === ExtProtocol.MSG_SEND && message.url) {
    sendUrl(String(message.url)).then(function () { sendResponse({ started: true }); });
    return true; // async response
  }
});

// ─── overlay registration follows the settings + granted permissions ──────────

CR.runtime.onStartup.addListener(function () { ExtSettings.syncOverlayRegistration(); });
CR.runtime.onInstalled.addListener(function () { ExtSettings.syncOverlayRegistration(); });
