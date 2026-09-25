// OpenGSC extension — background service worker (MV3, classic).
//
// Three jobs, all user-invoked:
//   • the context menu: "Send to OpenGSC" (page), "Selection → keywords", "Selection in table → CSV";
//   • the send itself: a portfolio URL goes to the index-check queue, a foreign one to Outreach;
//   • badge feedback, because a service worker has no surface of its own.
//
// activeTab is granted when the user clicks the action OR invokes a context-menu item, which
// is exactly when content.js / csv handling needs the tab — no standing host permissions.

importScripts("lib/api.js");

var CR = globalThis.chrome || globalThis.browser;

var MENU_SEND_PAGE = "opengsc-send-page";
var MENU_SELECTION = "opengsc-selection";
var MENU_TABLE_CSV = "opengsc-table-csv";

function msg(key, substitutions) {
  return CR.i18n.getMessage(key, substitutions) || key;
}

/** Short-lived badge: the only feedback channel a service worker has. */
function badge(text, color) {
  try {
    CR.action.setBadgeText({ text: text });
    CR.action.setBadgeBackgroundColor({ color: color || "#2997ff" });
    setTimeout(function () { CR.action.setBadgeText({ text: "" }); }, 2500);
  } catch (e) { /* action API unavailable in a non-tab context */ }
}

// ─── the send: index queue for our pages, outreach for everyone else's ───────────

function sendUrl(url) {
  return ExtApi.page(url).then(function (res) {
    if (res.status !== 200 || !res.data) {
      badge("ERR", "#ff453a");
      return;
    }
    if (res.data.inPortfolio) {
      ExtApi.indexQueue(url).then(function (q) {
        if (q.status === 200 && q.data && q.data.queued) badge("Q", "#34c759");
        else badge("·", "#ff9f0a"); // queued:false — reason is in the popup on next open
      });
    } else {
      ExtApi.outreach(url, "").then(function (o) {
        if (o.status === 200 && o.data && o.data.ok) badge("O", "#34c759");
        else badge("ERR", "#ff453a");
      });
    }
  });
}

// ─── context menu ────────────────────────────────────────────────────────────────

CR.runtime.onInstalled.addListener(function () {
  CR.contextMenus.removeAll(function () {
    CR.contextMenus.create({
      id: MENU_SEND_PAGE,
      title: msg("menuSendPage"),
      contexts: ["page"],
    });
    CR.contextMenus.create({
      id: MENU_SELECTION,
      title: msg("menuSelection", ["%s"]),
      contexts: ["selection"],
    });
    CR.contextMenus.create({
      id: MENU_TABLE_CSV,
      title: msg("menuTableCsv"),
      contexts: ["selection"],
    });
  });
});

CR.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === MENU_SEND_PAGE && info.pageUrl) {
    sendUrl(info.pageUrl);
    return;
  }
  if (info.menuItemId === MENU_SELECTION) {
    var text = String(info.selectionText || "").trim().slice(0, 200);
    if (!text) return;
    ExtApi.getSettings().then(function (s) {
      if (!s.baseUrl) { badge("CFG", "#ff9f0a"); CR.runtime.openOptionsPage(); return; }
      CR.tabs.create({ url: s.baseUrl + "/seo-tools/outline?keyword=" + encodeURIComponent(text) });
    });
    return;
  }
  if (info.menuItemId === MENU_TABLE_CSV) {
    if (!tab || !tab.id) return;
    CR.scripting.executeScript(
      { target: { tabId: tab.id }, files: ["lib/audit.js", "lib/csv.js", "content.js"] },
      function (results) {
        var payload = results && results[0] && results[0].result;
        if (!payload || !payload.selection || !payload.selection.inTable) {
          badge("—", "#ff9f0a"); // the selection was not inside a <table>
          return;
        }
        // A worker cannot click a download anchor, so the CSV travels back through storage
        // and the (already open, or next-opened) popup performs the download. Simplest
        // reliable channel that needs no extra permission.
        CR.storage.local.set({ lastCsv: { csv: payload.selection.csv, url: payload.url, at: Date.now() } }, function () {
          badge("CSV", "#34c759");
          if (CR.action.openPopup) CR.action.openPopup();
        });
      }
    );
  }
});

// The popup asks the background to run the send when the user clicks the popup button —
// one code path for the same action from both surfaces.
CR.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (message && message.type === "opengsc-send" && message.url) {
    sendUrl(String(message.url)).then(function () { sendResponse({ started: true }); });
    return true; // async response
  }
});
