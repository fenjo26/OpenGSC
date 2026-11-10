// OpenGSC extension — UI language override (classic script, loaded by every surface).
//
// Chrome's own chrome.i18n always follows the BROWSER language and cannot be switched at
// runtime. Users of a self-hosted tool often run an English browser but want the tool in
// their own language, so the options page lets them pick one: the chosen locale's
// messages.json is read once (an extension page may fetch its own files) and stored in
// chrome.storage.local as { uiLang, uiMessages }. Every surface calls ExtI18n.ready() before
// it renders and then uses ExtI18n.msg(), which falls back to chrome.i18n — so "auto" (no
// override) behaves exactly like before.

var ExtI18n = (function () {
  "use strict";

  var CR = globalThis.chrome || globalThis.browser;

  // The languages OpenGSC itself ships (src/locales) — one _locales/<code> folder each.
  var LANGS = [
    { code: "en", name: "English" },
    { code: "ru", name: "Русский" },
    { code: "uk", name: "Українська" },
    { code: "de", name: "Deutsch" },
    { code: "fr", name: "Français" },
    { code: "es", name: "Español" },
    { code: "nl", name: "Nederlands" },
    { code: "zh", name: "中文" },
  ];

  var dict = null;   // key → message of the override language, null = follow the browser
  var lang = "";     // "" = auto

  /** Chrome's substitution rules: $1…$9 → subs[0…8], "$$" → "$". */
  function substitute(text, subs) {
    var list = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
    return String(text).replace(/\$(\$|[1-9])/g, function (m, d) {
      if (d === "$") return "$";
      var v = list[Number(d) - 1];
      return v == null ? "" : String(v);
    });
  }

  function msg(key, subs) {
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return substitute(dict[key], subs);
    try {
      var native = CR && CR.i18n ? CR.i18n.getMessage(key, subs) : "";
      return native || key;
    } catch {
      return key;
    }
  }

  /** Load the stored override. Resolves when msg() is ready to use; never rejects. */
  function ready() {
    return new Promise(function (resolve) {
      try {
        CR.storage.local.get(["uiLang", "uiMessages"], function (stored) {
          lang = String((stored && stored.uiLang) || "");
          dict = lang && stored && stored.uiMessages && typeof stored.uiMessages === "object" ? stored.uiMessages : null;
          resolve(lang);
        });
      } catch {
        resolve("");
      }
    });
  }

  /** "" = auto (browser language). Only callable from an extension page (it fetches a file). */
  function setLanguage(code) {
    code = String(code || "");
    if (!code || !LANGS.some(function (l) { return l.code === code; })) {
      return new Promise(function (resolve) {
        CR.storage.local.remove(["uiLang", "uiMessages"], function () { lang = ""; dict = null; resolve(""); });
      });
    }
    // Chrome only accepts its own locale folder names: Chinese lives in zh_CN
    var folder = code === "zh" ? "zh_CN" : code;
    return fetch(CR.runtime.getURL("_locales/" + folder + "/messages.json"))
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var flat = {};
        Object.keys(json || {}).forEach(function (k) {
          if (json[k] && typeof json[k].message === "string") flat[k] = json[k].message;
        });
        return new Promise(function (resolve) {
          CR.storage.local.set({ uiLang: code, uiMessages: flat }, function () {
            lang = code; dict = flat; resolve(code);
          });
        });
      });
  }

  /** The language a surface should render <html lang> with. */
  function current() {
    if (lang) return lang;
    try { return (CR.i18n.getUILanguage() || "en").slice(0, 2); } catch { return "en"; }
  }

  /** Fill [data-i18n] / [data-i18n-placeholder] / [data-i18n-title] inside root. */
  function applyTo(root) {
    var scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (n) { n.textContent = msg(n.getAttribute("data-i18n")); });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(function (n) { n.setAttribute("placeholder", msg(n.getAttribute("data-i18n-placeholder"))); });
    scope.querySelectorAll("[data-i18n-title]").forEach(function (n) { n.setAttribute("title", msg(n.getAttribute("data-i18n-title"))); });
  }

  return { LANGS: LANGS, msg: msg, ready: ready, setLanguage: setLanguage, current: current, applyTo: applyTo, substitute: substitute };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ExtI18n;
