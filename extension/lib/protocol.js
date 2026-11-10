// OpenGSC extension — message names and the ext:api whitelist (wave-ext E0).
//
// Content scripts (SERP overlay, page scan) never talk to the OpenGSC server directly: they
// send MSG_API to the background service worker, which is the only place allowed to call
// ExtApi.request. The whitelist below is the complete set of paths the proxy accepts; anything
// else answers { status: 0, data: { error: "path_not_allowed" } }.

var ExtProtocol = {
  MSG_API: "ext:api",               // { type, method: "GET"|"POST", path, body? } → { status, data }
  MSG_OPEN_PANEL: "ext:open-panel", // { type } from popup/overlay → background opens the side panel for sender tab
  MSG_SEND: "opengsc-send",         // N11, unchanged
  MSG_SETTINGS_CHANGED: "ext:settings-changed",  // broadcast after ExtSettings.set
  MSG_SERP_HOSTS: "ext:serp-hosts",           // overlay → bg/serp.js: { type, body: HostsRequest } → { status, data } (cached 10 min)
  MSG_SERP_INVALIDATE: "ext:serp-invalidate", // overlay → bg/serp.js: { type, query } — drop cached answers of this query
  MSG_REDIRECTS: "ext:redirects",             // panel → bg/redirects.js: { type, tabId } → { start, hops[], at } | null
  API_WHITELIST: [                  // the only paths ext:api will proxy; anything else → { status: 0, data: { error: "path_not_allowed" } }
    "/api/ext/hosts", "/api/ext/hosts/enrich", "/api/ext/serp/capture", "/api/ext/serp/action",
    "/api/ext/cloak", "/api/ext/outreach", "/api/ext/page", "/api/ext/lists"
  ]
};

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtProtocol;
