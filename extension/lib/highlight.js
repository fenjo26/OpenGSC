// OpenGSC extension — on-page problem highlighting (wave-ext E1).
//
// Injected into the page via chrome.scripting.executeScript({ func: ExtHighlight.apply }).
// ONE shadow host <opengsc-highlight> at the end of body holds absolutely-positioned frames
// positioned over the problem elements; nothing — no class, no attribute, no style — is ever
// written onto the page's own elements. clear() removes the host and its listeners entirely;
// a repeat apply() clears first.

var ExtHighlight = (function () {
  "use strict";

  var HOST_TAG = "opengsc-highlight";

  var COLORS = {
    base: "#ff453a",         // red frame — images without alt
    h1: "#ff9f0a",           // orange with a number — H1 headings
    nofollow: "#2997ff",     // blue dashed
    external: "#8e8e93",     // grey dashed
    empty: "#ff453a",        // red dashed
    top: "#bf5af2",          // purple dashed — links above all content (donor tab)
  };

  var state = { placed: [], raf: 0, listening: false };

  function ensureHost() {
    var existing = document.querySelector(HOST_TAG);
    if (existing) return existing;
    var el = document.createElement(HOST_TAG);
    var root = el.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent =
      ":host{position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;}" +
      ".f{position:absolute;border:2px solid " + COLORS.base + ";border-radius:4px;pointer-events:none;box-sizing:border-box;}" +
      ".f.dash{border-style:dashed;}" +
      ".f.c-nofollow{border-color:" + COLORS.nofollow + ";}" +
      ".f.c-external{border-color:" + COLORS.external + ";}" +
      ".f.c-empty{border-color:" + COLORS.empty + ";}" +
      ".f.c-top{border-color:" + COLORS.top + ";}" +
      ".f.c-h1{border-color:" + COLORS.h1 + ";}" +
      ".n{position:absolute;font:700 10px/1.4 system-ui,sans-serif;color:#fff;background:" + COLORS.h1 +
      ";border-radius:6px;padding:0 4px;transform:translate(2px,-14px);white-space:nowrap;pointer-events:none;}";
    root.appendChild(style);
    var layer = document.createElement("div");
    root.appendChild(layer);
    el.__opengscLayer = layer;
    document.body.appendChild(el);
    return el;
  }

  /** Frame record {el, f, n?} — el is the page element, f/n live in our shadow. */
  function frame(el, className, label) {
    var layer = ensureHost().__opengscLayer;
    var record = { el: el };
    var f = document.createElement("div");
    f.className = "f " + (className || "");
    layer.appendChild(f);
    record.f = f;
    if (label) {
      var n = document.createElement("div");
      n.className = "n";
      n.textContent = label;
      layer.appendChild(n);
      record.n = n;
    }
    place(record);
    return record;
  }

  function place(record) {
    var r = record.el.getBoundingClientRect();
    var x = r.left + window.scrollX;
    var y = r.top + window.scrollY;
    record.f.style.left = x + "px";
    record.f.style.top = y + "px";
    record.f.style.width = Math.max(r.width, 4) + "px";
    record.f.style.height = Math.max(r.height, 4) + "px";
    if (record.n) {
      record.n.style.left = x + "px";
      record.n.style.top = y + "px";
    }
  }

  function redraw() {
    if (state.raf) return;
    state.raf = window.requestAnimationFrame(function () {
      state.raf = 0;
      var alive = [];
      for (var i = 0; i < state.placed.length; i++) {
        if (!state.placed[i].el.isConnected) {
          state.placed[i].f.remove();
          if (state.placed[i].n) state.placed[i].n.remove();
          continue;
        }
        place(state.placed[i]);
        alive.push(state.placed[i]);
      }
      state.placed = alive;
    });
  }

  function listen() {
    if (state.listening) return;
    state.listening = true;
    window.addEventListener("scroll", redraw, true);
    window.addEventListener("resize", redraw);
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  /** Which problem kinds to highlight; see the panel's dropdown. Returns the frame count. */
  function apply(spec) {
    clear();
    spec = spec || {};
    var placed = state.placed;
    var MAX = 800;

    if (spec.images_no_alt) {
      var imgs = document.querySelectorAll("img");
      for (var i = 0; i < imgs.length && placed.length < MAX; i++) {
        if (imgs[i].getAttribute("alt") != null || !visible(imgs[i])) continue;
        placed.push(frame(imgs[i], ""));
      }
    }
    if (spec.h1) {
      var h1s = document.querySelectorAll("h1");
      var h1n = 0;
      for (var j = 0; j < h1s.length && placed.length < MAX; j++) {
        if (!visible(h1s[j])) continue;
        placed.push(frame(h1s[j], "c-h1", "H1 #" + ++h1n));
      }
    }
    if (spec.nofollow) {
      var nfs = document.querySelectorAll('a[rel~="nofollow" i]');
      for (var k = 0; k < nfs.length && placed.length < MAX; k++) {
        if (visible(nfs[k])) placed.push(frame(nfs[k], "dash c-nofollow"));
      }
    }
    if (spec.external) {
      var anchors = document.querySelectorAll("a[href]");
      for (var m = 0; m < anchors.length && placed.length < MAX; m++) {
        var a = anchors[m];
        if (!/^https?:/i.test(a.href || "")) continue;
        try { if (new URL(a.href).host === location.host) continue; } catch { continue; }
        if (visible(a)) placed.push(frame(a, "dash c-external"));
      }
    }
    if (spec.empty_links) {
      var all = document.querySelectorAll("a[href]");
      for (var p = 0; p < all.length && placed.length < MAX; p++) {
        var a2 = all[p];
        if (String(a2.textContent || "").trim()) continue;
        if (a2.getAttribute("aria-label")) continue;
        var withAlt = a2.querySelector("img[alt]");
        if (withAlt && String(withAlt.getAttribute("alt") || "").trim()) continue;
        if (!visible(a2)) continue;
        placed.push(frame(a2, "dash c-empty"));
      }
    }
    if (spec.top_links && globalThis.ExtensionAudit) {
      var first = ExtensionAudit.firstTextBlock(document);
      if (first) {
        var links = document.querySelectorAll("a[href]");
        for (var q = 0; q < links.length && placed.length < MAX; q++) {
          var a3 = links[q];
          if (!/^https?:/i.test(a3.href || "")) continue;
          if (a3.compareDocumentPosition(first) & 4 /* FOLLOWING: link before content */ && visible(a3)) {
            placed.push(frame(a3, "dash c-top"));
          }
        }
      }
    }

    if (placed.length) listen();
    return placed.length;
  }

  function clear() {
    if (state.raf) { window.cancelAnimationFrame(state.raf); state.raf = 0; }
    if (state.listening) {
      window.removeEventListener("scroll", redraw, true);
      window.removeEventListener("resize", redraw);
      state.listening = false;
    }
    state.placed = [];
    var existing = document.querySelector(HOST_TAG);
    if (existing) existing.remove();
  }

  return { apply: apply, clear: clear, COLORS: COLORS };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtHighlight;
