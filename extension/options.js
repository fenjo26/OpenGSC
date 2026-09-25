// OpenGSC extension — options page logic (classic script).
//
// Saves the instance URL + token to chrome.storage.local and, on save, asks (from this user
// gesture, the only moment Chrome allows it) for the OPTIONAL host permission covering the
// instance origin. That permission is what keeps API calls working even if CORS headers ever
// change; the server's own token + extension-id checks remain the real access control.

var CR = globalThis.chrome || globalThis.browser;

function msg(key) {
  return CR.i18n.getMessage(key) || key;
}

function el(id) { return document.getElementById(id); }

function i18nPage() {
  var nodes = document.querySelectorAll("[data-i18n]");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].textContent = msg(nodes[i].getAttribute("data-i18n"));
  }
  document.documentElement.lang = CR.i18n.getUILanguage().slice(0, 2) || "en";
}

function setStatus(text, kind) {
  var node = el("status");
  node.textContent = text;
  node.className = "status" + (kind ? " " + kind : "");
}

/** The origin pattern the optional-host request needs: scheme + host, any path. */
function originPattern(base) {
  try {
    var u = new URL(base);
    return u.origin + "/*";
  } catch (e) {
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
      else if (res.status === 403) setStatus(msg("optionsTest403"), "err");
      else if (res.status === 0) setStatus(msg("optionsTestNetwork"), "err");
      else setStatus(msg("optionsTestFail") + " (" + res.status + ")", "err");
    });
  });
}

document.addEventListener("DOMContentLoaded", function () {
  i18nPage();

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
});
