// OpenGSC extension — redirect chain recorder (Redirect Path–style), service worker side.
//
// Every top-level navigation is recorded hop by hop from chrome.webRequest (observe only,
// nothing is blocked or changed): status code + status line, URL, server IP, and for a
// redirect its type (301/302/307/308) and target. A client-side redirect (meta refresh or
// JavaScript, reported by webNavigation as "client_redirect") is stitched onto the previous
// chain. The action badge shows the first status of the chain (a redirect is the thing you
// want to notice), the panel's "Redirects" sub-tab shows the whole chain.
//
// webRequest only reports URLs the extension holds a host permission for — i.e. after the
// user allowed "all sites" in the options (the panel says so when nothing was recorded).

(function () {
  "use strict";

  var CR = globalThis.chrome || globalThis.browser;
  if (!CR || !CR.webRequest) return;

  var chains = {};          // tabId → { start, hops: [], pending, at, prev }
  var FILTER = { urls: ["<all_urls>"], types: ["main_frame"] };

  function persist(tabId) {
    var c = chains[tabId];
    if (!c) return;
    var o = {};
    o["rc_" + tabId] = { start: c.start, hops: c.hops, pending: c.pending, at: c.at };
    try { CR.storage.session.set(o); } catch { /* session storage unavailable */ }
  }

  function badge(tabId) {
    var c = chains[tabId];
    if (!c || !c.hops.length) return;
    var first = c.hops[0];
    var code = first.status;
    var text = code ? String(code) : "ERR";
    var color = !code ? "#9aa0a6" : code < 300 ? "#188038" : code < 400 ? "#e37400" : "#d93025";
    if (c.hops.length > 1 && c.hops.some(function (h) { return h.type === "client_redirect"; })) text = "JS";
    try {
      CR.action.setBadgeText({ tabId: tabId, text: text });
      CR.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
    } catch { /* tab gone */ }
  }

  CR.webRequest.onBeforeRequest.addListener(function (d) {
    if (d.tabId < 0) return;
    var cur = chains[d.tabId];
    if (cur && cur.pending) return; // a hop of the chain already in flight
    chains[d.tabId] = { start: d.url, hops: [], pending: true, at: Date.now(), prev: cur && !cur.pending ? cur : null };
  }, FILTER);

  CR.webRequest.onBeforeRedirect.addListener(function (d) {
    var c = chains[d.tabId];
    if (!c) return;
    c.hops.push({
      status: d.statusCode, statusLine: d.statusLine || "", url: d.url, ip: d.ip || "",
      type: "server_redirect", redirectType: String(d.statusCode), redirectUrl: d.redirectUrl || "",
    });
  }, FILTER);

  CR.webRequest.onCompleted.addListener(function (d) {
    var c = chains[d.tabId];
    if (!c) return;
    c.hops.push({
      status: d.statusCode, statusLine: d.statusLine || "", url: d.url, ip: d.ip || "",
      type: "normal", redirectType: "none", redirectUrl: "none",
    });
    c.pending = false;
    persist(d.tabId);
    badge(d.tabId);
  }, FILTER);

  CR.webRequest.onErrorOccurred.addListener(function (d) {
    var c = chains[d.tabId];
    if (!c) return;
    c.hops.push({
      status: 0, statusLine: d.error || "error", url: d.url, ip: d.ip || "",
      type: "error", redirectType: "none", redirectUrl: "none",
    });
    c.pending = false;
    persist(d.tabId);
    badge(d.tabId);
  }, FILTER);

  // meta refresh / JavaScript redirect: the previous chain's last page redirected here
  if (CR.webNavigation) {
    CR.webNavigation.onCommitted.addListener(function (d) {
      if (d.frameId !== 0) return;
      var q = d.transitionQualifiers || [];
      if (q.indexOf("client_redirect") === -1) return;
      var c = chains[d.tabId];
      if (!c || !c.prev || !c.prev.hops.length) return;
      var prevHops = c.prev.hops.slice();
      var last = Object.assign({}, prevHops[prevHops.length - 1]);
      last.type = "client_redirect";
      last.redirectType = "javascript/meta";
      last.redirectUrl = d.url;
      prevHops[prevHops.length - 1] = last;
      c.hops = prevHops.concat(c.hops);
      c.start = c.prev.start;
      c.prev = null;
      if (!c.pending) { persist(d.tabId); badge(d.tabId); }
    });
  }

  CR.tabs.onRemoved.addListener(function (tabId) {
    delete chains[tabId];
    try { CR.storage.session.remove("rc_" + tabId); } catch { /* */ }
  });

  // the panel asks for one tab's chain (memory first; session storage survives worker sleep)
  CR.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== ExtProtocol.MSG_REDIRECTS) return false;
    var tabId = Number(message.tabId);
    var c = chains[tabId];
    if (c && !c.pending) {
      sendResponse({ start: c.start, hops: c.hops, at: c.at });
      return false;
    }
    try {
      CR.storage.session.get(["rc_" + tabId], function (stored) {
        sendResponse((stored && stored["rc_" + tabId]) || null);
      });
    } catch {
      sendResponse(null);
    }
    return true;
  });
})();
