// OpenGSC extension — SERP overlay host cache (wave-ext E4 owns this file).
//
// Job: answer MSG_SERP_HOSTS (one /api/ext/hosts call per SERP page, cached 10 min in
// chrome.storage.session so back-navigation and reopens don't burn the 60/min token limit) and
// MSG_SERP_INVALIDATE (drop cached answers of a query after an action changed the data).
// Registration of the overlay content script itself is ExtSettings.syncOverlayRegistration()
// (lib/settings.js, E0); this file only serves the messages.

// E4 lands here. Nothing to do in E0: message names live in lib/protocol.js.
