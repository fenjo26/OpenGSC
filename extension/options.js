// OpenGSC extension — options page logic (classic script).
//
// Three jobs:
//   • connection: instance URL + token → chrome.storage.local, plus the optional host
//     permission for the instance origin (asked from the save click — the only moment Chrome
//     allows it);
//   • side panel: the "analyze any page" standing permission (opt-in, from the toggle click);
//   • Google overlay: enable, pick Google domains (permission asked on save), compact mode,
//     default site/project for the overlay's action buttons (dropdowns from /api/ext/lists,
//     text fields when the server is unreachable).
// wave-ext E0; the connection part is unchanged N11.

var CR = globalThis.chrome || globalThis.browser;

function msg(key, subs) {
  return ExtI18n.msg(key, subs);
}

function el(id) { return document.getElementById(id); }

function i18nPage() {
  ExtI18n.applyTo(document);
  document.documentElement.lang = ExtI18n.current();
}

// ─── language ───────────────────────────────────────────────────────────────────

function initLanguage() {
  var sel = el("uiLang");
  if (!sel) return;
  var auto = document.createElement("option");
  auto.value = "";
  auto.textContent = msg("optLangAuto");
  sel.appendChild(auto);
  ExtI18n.LANGS.forEach(function (l) {
    var o = document.createElement("option");
    o.value = l.code;
    o.textContent = l.name;
    sel.appendChild(o);
  });
  CR.storage.local.get(["uiLang"], function (stored) { sel.value = (stored && stored.uiLang) || ""; });
  sel.addEventListener("change", function () {
    ExtI18n.setLanguage(sel.value).then(function () {
      // every open surface re-reads the language on its next render; this page reloads now
      CR.runtime.sendMessage({ type: ExtProtocol.MSG_SETTINGS_CHANGED }, function () { void CR.runtime.lastError; });
      window.location.reload();
    });
  });
}

function setStatus(text, kind) {
  var node = el("status");
  node.textContent = text;
  node.className = "status" + (kind ? " " + kind : "");
}

function setSerpStatus(text, kind) {
  var node = el("serpStatus");
  node.textContent = text;
  node.className = "status" + (kind ? " " + kind : "");
}

/** The origin pattern the optional-host request needs: scheme + host, any path. */
function originPattern(base) {
  try {
    var u = new URL(base);
    return u.origin + "/*";
  } catch {
    return "";
  }
}

function save() {
  var baseUrl = ExtApi.normalizeBase(el("baseUrl").value);
  var token = el("token").value.trim();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    setStatus(msg("optionsErrUrl"), "err");
    return;
  }
  if (!token || token.indexOf("ogscext_") !== 0) {
    setStatus(msg("optionsErrToken"), "err");
    return;
  }

  ExtApi.saveSettings({ baseUrl: baseUrl, token: token }).then(function () {
    // Optional host permission for exactly this instance — requested from the click gesture.
    var pattern = originPattern(baseUrl);
    var done = function (granted) {
      setStatus(granted ? msg("optionsSaved") : msg("optionsSavedNoHost"), granted ? "ok" : "warn");
      loadLists(); // the connection may just have started working
    };
    if (pattern && CR.permissions && CR.permissions.request) {
      CR.permissions.request({ origins: [pattern] }, function (granted) { done(!!granted); });
    } else {
      done(false);
    }
  });
}

function test() {
  setStatus(msg("optionsTesting"), "");
  ExtApi.getSettings().then(function (s) {
    if (!s.baseUrl || !s.token) {
      setStatus(msg("optionsErrFillFirst"), "warn");
      return;
    }
    ExtApi.page(s.baseUrl + "/").then(function (res) {
      // Any 200 (even { inPortfolio: false }) proves URL + token + CORS together.
      if (res.status === 200 && res.data && !res.data.error) setStatus(msg("optionsTestOk"), "ok");
      else if (res.status === 401) setStatus(msg("optionsTest401"), "err");
      // 403 has two causes — say which (origin_not_allowed = id not on the list; forbidden = role).
      else if (res.status === 403) setStatus(res.data && res.data.error === "forbidden" ? "403: forbidden (role)" : msg("optionsTest403"), "err");
      else if (res.status === 0) setStatus(msg("optionsTestNetwork"), "err");
      else setStatus(msg("optionsTestFail") + " (" + res.status + ")", "err");
    });
  });
}

// ─── side panel permission ──────────────────────────────────────────────────────

function paintPanelPerm(granted) {
  var node = el("panelPerm");
  node.textContent = granted ? msg("optPermissionGranted") : msg("optPermissionMissing");
  node.className = "hint " + (granted ? "ok" : "warn");
  el("panelAllSites").checked = granted;
}

function refreshPanelPerm() {
  ExtSettings.hasOrigin("http://*/*").then(paintPanelPerm);
}

function togglePanelAllSites() {
  // Must run from the click: Chrome rejects permission prompts outside a user gesture.
  if (el("panelAllSites").checked) {
    ExtSettings.requestAllSites().then(function (granted) {
      ExtSettings.set({ panelAllSites: granted }).then(function () { paintPanelPerm(granted); });
    });
  } else {
    ExtSettings.set({ panelAllSites: false }).then(function () { refreshPanelPerm(); });
  }
}

// ─── Google overlay ─────────────────────────────────────────────────────────────

var domainChecked = {}; // host → boolean, the working copy until "Save"

function renderDomains(filter) {
  var box = el("domainList");
  box.textContent = "";
  var needle = String(filter || "").toLowerCase();
  ALL_SEARCH_HOSTS
    .filter(function (h) { return !needle || h.indexOf(needle) !== -1; })
    .slice(0, 400)
    .forEach(function (host) {
      var label = document.createElement("label");
      label.className = "domain";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!domainChecked[host];
      cb.addEventListener("change", function () { domainChecked[host] = cb.checked; });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(host));
      box.appendChild(label);
    });
}

// The currently saved default ids — the selects restore to these when (re)populated.
var currentDefaults = { siteId: "", projectId: "" };

function fillSelect(select, textInput, entries, current) {
  // entries null → server unreachable: hide the select, show the free-text ID field.
  if (!entries) {
    select.classList.add("hidden");
    textInput.classList.remove("hidden");
    textInput.value = current;
    return;
  }
  select.classList.remove("hidden");
  textInput.classList.add("hidden");
  select.textContent = "";
  var empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "—";
  select.appendChild(empty);
  entries.forEach(function (e) {
    var opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.label;
    select.appendChild(opt);
  });
  select.value = current && entries.some(function (e) { return e.id === current; }) ? current : "";
}

function loadLists() {
  ExtApi.lists().then(function (res) {
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.sites)) {
      fillSelect(el("defaultSite"), el("defaultSiteText"), null, currentDefaults.siteId);
      fillSelect(el("defaultProject"), el("defaultProjectText"), null, currentDefaults.projectId);
      return;
    }
    fillSelect(el("defaultSite"), el("defaultSiteText"),
      res.data.sites.map(function (s) { return { id: s.id, label: s.label }; }),
      currentDefaults.siteId);
    fillSelect(el("defaultProject"), el("defaultProjectText"),
      (res.data.projects || []).map(function (p) { return { id: p.id, label: p.name + " · " + p.country + "/" + p.lang }; }),
      currentDefaults.projectId);
  });
}

function serpPatch() {
  return {
    serpOverlay: el("serpOverlay").checked,
    serpCompact: el("serpCompact").checked,
    serpPositions: el("serpPositions").checked,
    serpAutoEnrich: el("serpAutoEnrich").checked,
    serpHideAds: el("serpHideAds").checked,
    defaultSiteId: !el("defaultSite").classList.contains("hidden") ? el("defaultSite").value : el("defaultSiteText").value.trim(),
    defaultProjectId: !el("defaultProject").classList.contains("hidden") ? el("defaultProject").value : el("defaultProjectText").value.trim(),
  };
}

/** The overlay runs on every supported search engine out of the box (manifest
 *  content_scripts + host access granted at install); these switches only tune it. */
function saveSerp() {
  ExtSettings.set(serpPatch()).then(function (saved) {
    currentDefaults = { siteId: saved.defaultSiteId || "", projectId: saved.defaultProjectId || "" };
    setSerpStatus(msg("optSaved"), "ok");
  });
}

// ─── boot ───────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
  ExtI18n.ready().then(boot);
});

function boot() {
  i18nPage();
  initLanguage();

  el("extId").textContent = CR.runtime.id || "";

  ExtApi.getSettings().then(function (s) {
    el("baseUrl").value = s.baseUrl || "";
    el("token").value = s.token || "";
  });

  el("save").addEventListener("click", save);
  el("test").addEventListener("click", test);

  el("reveal").addEventListener("click", function () {
    var input = el("token");
    input.type = input.type === "password" ? "text" : "password";
  });

  el("copyId").addEventListener("click", function () {
    var id = CR.runtime.id || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(function () {
        setStatus(msg("optionsCopied"), "ok");
      });
    }
  });

  // Panel + overlay state (the defaults propose the UI language's country domain).
  ExtSettings.get().then(function (s) {
    el("serpOverlay").checked = s.serpOverlay !== false;
    el("serpCompact").checked = !!s.serpCompact;
    el("serpPositions").checked = s.serpPositions !== false;
    el("serpAutoEnrich").checked = s.serpAutoEnrich !== false;
    el("serpHideAds").checked = !!s.serpHideAds;
    currentDefaults = { siteId: s.defaultSiteId || "", projectId: s.defaultProjectId || "" };
    el("defaultSiteText").value = s.defaultSiteId || "";
    el("defaultProjectText").value = s.defaultProjectId || "";
  });

  refreshPanelPerm();
  el("panelAllSites").addEventListener("change", togglePanelAllSites);

  ["serpOverlay", "serpPositions", "serpAutoEnrich", "serpHideAds", "serpCompact"].forEach(function (id) {
    el(id).addEventListener("change", saveSerp); // switches apply at once — no Save needed
  });
  el("serpSave").addEventListener("click", saveSerp);

  loadLists();
}
