// OpenGSC extension — the side panel (wave-ext E0 lays the opening mechanics; E1 owns the
// panel itself).
//
// On Chrome ≥ 116 the action click opens the side panel (manifest 1.1.0 removed the default
// popup). Older Chromium builds keep the N11 popup via chrome.action.setPopup. The panel is
// one per window and follows the active tab — panel/core.js does the following; here we only
// open it, which is allowed strictly inside a user gesture.

(function () {
  "use strict";

  // Own binding: this file's top-level code runs at importScripts time, before background.js
  // assigns its own CR.
  var CR = globalThis.chrome || globalThis.browser;

  if (CR.sidePanel && CR.sidePanel.setPanelBehavior) {
    CR.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {
      /* falls back to the popup below when the API is present but refuses */
    });
  } else if (CR.action && CR.action.setPopup) {
    CR.action.setPopup({ popup: "popup.html" });
  }

  CR.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== ExtProtocol.MSG_OPEN_PANEL) return false;
    // sidePanel.open needs a user gesture at the SENDER (a click in the popup/overlay); the
    // message must therefore be sent from inside a click handler.
    var target = sender.tab && sender.tab.id != null
      ? { tabId: sender.tab.id }
      : (sender.tab && sender.tab.windowId != null ? { windowId: sender.tab.windowId } : null);
    if (CR.sidePanel && CR.sidePanel.open && target) {
      CR.sidePanel.open(target).then(
        function () { sendResponse({ opened: true }); },
        function (e) { sendResponse({ opened: false, error: String(e && e.message || e) }); }
      );
      return true; // async response
    }
    sendResponse({ opened: false, error: "side_panel_unavailable" });
    return false;
  });
})();
