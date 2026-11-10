// OpenGSC extension — the Google SERP overlay (wave-ext E4). Registered as "opengsc-serp"
// on the domains the user enabled; runs at document_idle, reads the results the user opened
// themselves and draws ONLY our own shadow hosts — no attributes, classes or styles on
// Google's elements, nothing breaks when the layout changes (a failed parse is silence).
//
// Data: ONE ext:serp-hosts message per SERP page (the background caches 10 min); every other
// call (capture, actions, cloak, outreach) goes through the ext:api proxy — this script never
// fetches anything itself.

(function () {
  "use strict";

  var CR = globalThis.chrome || globalThis.browser;
  if (!CR || !CR.runtime || !CR.runtime.id) return; // not our content script context

  var state = {
    settings: null,
    parsed: null,
    hostsData: null,       // HostsResponse
    intelByHost: {},
    drawn: new WeakSet(),  // result blocks that already have a row
    rows: [],              // { result, layer } — redrawn in place when data arrives later
    card: null,            // { el, layer } of the side card
    extras: { paa: [], related: [] },
    cardTab: "related",
    enriching: false,
    requestedHosts: {},    // hosts already asked for (infinite scroll dedupe)
    perf: { parseMs: 0, renderMs: 0 },
  };

  function msg(key, subs) {
    try { return ExtI18n.msg(key, subs); } catch { return key; }
  }

  /** All API through the worker proxy. Resolves { status, data }. */
  function extApi(method, path, body) {
    return new Promise(function (resolve) {
      try {
        CR.runtime.sendMessage({ type: ExtProtocol.MSG_API, method: method, path: path, body: body }, function (res) {
          void CR.runtime.lastError;
          resolve(res || { status: 0, data: { error: "no_response" } });
        });
      } catch {
        resolve({ status: 0, data: { error: "no_extension_context" } });
      }
    });
  }

  function serpHosts(body) {
    return new Promise(function (resolve) {
      try {
        CR.runtime.sendMessage({ type: ExtProtocol.MSG_SERP_HOSTS, body: body }, function (res) {
          void CR.runtime.lastError;
          resolve(res || { status: 0, data: { error: "no_response" } });
        });
      } catch {
        resolve({ status: 0, data: { error: "no_extension_context" } });
      }
    });
  }

  function getSettings() {
    return new Promise(function (resolve) {
      CR.storage.local.get(["extSettings"], function (stored) {
        var s = (stored && stored.extSettings) || {};
        resolve({
          serpCompact: !!s.serpCompact,
          serpPositions: s.serpPositions !== false,
          serpAutoEnrich: s.serpAutoEnrich !== false,
          serpHideAds: !!s.serpHideAds,
          defaultSiteId: s.defaultSiteId || "",
          defaultProjectId: s.defaultProjectId || "",
        });
      });
    });
  }

  // ─── styles (inside our shadow roots only) ─────────────────────────────────────

  var CSS = [
    ":host{all:initial;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.45;display:block;}",
    ".row{display:flex;flex-wrap:wrap;gap:5px 8px;align-items:center;padding:3px 0;color:#4d5156;}",
    ".row.own{background:rgba(42,125,234,0.08);border-radius:6px;padding:3px 6px;margin-left:-6px;}",
    ".chip{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;color:#4d5156;}",
    ".chip b{color:#1a73e8;font-weight:700;}",
    ".chip.warn{color:#b06000;}",
    ".pill{display:inline-block;font-size:10px;font-weight:700;padding:0 6px;border-radius:7px;background:#e8f0fe;color:#1a73e8;margin-right:3px;}",
    ".pill.o{background:#e6f4ea;color:#137333;}.pill.r{background:#fce8e6;color:#c5221f;}.pill.g{background:#f1f3f4;color:#5f6368;}",
    ".menu-btn{cursor:pointer;color:#5f6368;padding:0 4px;border:none;background:none;font-size:14px;line-height:1;}",
    ".menu{position:relative;}",
    ".drop{display:none;position:absolute;left:0;top:18px;z-index:9999;background:#fff;border:1px solid #dadce0;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.15);padding:4px 0;min-width:190px;}",
    ".menu.open .drop{display:block;}",
    ".drop button{display:block;width:100%;text-align:left;background:none;border:none;padding:6px 14px;font-size:12px;cursor:pointer;color:#202124;}",
    ".drop button:hover{background:#f1f3f4;}",
    ".cloak{margin-top:3px;font-size:11.5px;color:#4d5156;}",
    ".cloak.bad{color:#c5221f;}.cloak.ok{color:#137333;}",
    ".spin{display:inline-block;width:10px;height:10px;border:2px solid #dadce0;border-top-color:#1a73e8;border-radius:50%;animation:opengsc-rot 0.8s linear infinite;}",
    "@keyframes opengsc-rot{to{transform:rotate(360deg)}}",
    "a{color:#1a73e8;text-decoration:none;}a:hover{text-decoration:underline;}",
    // header block
    ".head{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:6px 10px;margin:0 0 12px;border:1px solid #dadce0;border-radius:10px;background:#fff;color:#3c4043;}",
    ".head .q{font-weight:700;color:#202124;}",
    ".head .muted{color:#70757a;}",
    ".head button{padding:3px 10px;border-radius:6px;border:1px solid #dadce0;background:#fff;color:#1a73e8;font-size:11.5px;font-weight:600;cursor:pointer;}",
    ".head button:hover{background:#f8f9fa;}",
    ".head select{padding:2px 6px;border-radius:6px;border:1px solid #dadce0;font-size:11.5px;}",
    // position number in the left gutter (host is a zero-size block right before the result)
    ".pos{position:absolute;right:14px;width:34px;text-align:right;font:600 15px/1.25 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#70757a;}",
    ".dr b{color:#202124;}",
    // side card
    ".card{box-sizing:border-box;border:1px solid #dadce0;border-radius:12px;padding:12px 14px;background:#fff;color:#3c4043;margin:0 0 18px;font-size:12.5px;}",
    ".card .top{display:flex;align-items:center;gap:8px;margin-bottom:8px;}",
    ".card .brand{font-weight:800;color:#1a73e8;letter-spacing:.2px;}",
    ".card .q{font-weight:700;color:#202124;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
    ".card .muted{color:#70757a;}",
    ".card .sec{margin:6px 0;line-height:1.5;}",
    ".card .lbl{color:#70757a;font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-top:8px;}",
    ".card .btns{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 6px;}",
    ".card button{padding:4px 10px;border-radius:7px;border:1px solid #dadce0;background:#fff;color:#1a73e8;font-size:12px;font-weight:600;cursor:pointer;}",
    ".card button:hover{background:#f8f9fa;}",
    ".card button:disabled{opacity:.55;cursor:default;}",
    ".card select{padding:2px 6px;border-radius:6px;border:1px solid #dadce0;font-size:12px;}",
    ".tabs{display:flex;gap:14px;border-bottom:1px solid #e8eaed;margin-top:10px;}",
    ".tabs .t{background:none;border:none;border-bottom:2px solid transparent;border-radius:0;padding:6px 0;color:#5f6368;font-weight:600;}",
    ".tabs .t.on{color:#202124;border-bottom-color:#1a73e8;}",
    ".tabs .copy{margin-left:auto;border:none;color:#5f6368;font-weight:500;padding:6px 0;}",
    ".list{list-style:none;margin:0;padding:0;}",
    ".list li{padding:7px 0;border-bottom:1px solid #f1f3f4;}",
    ".list li a{color:#202124;}",
    ".toggle{display:inline-flex;align-items:center;gap:5px;color:#5f6368;font-size:11.5px;cursor:pointer;white-space:nowrap;}",
    "@media (prefers-color-scheme:dark){",
    "  .pos{color:#9aa0a6;}.dr b{color:#e8eaed;}",
    "  .card{background:#202124;border-color:#5f6368;color:#bdc1c6;}.card .q{color:#e8eaed;}.card .muted,.card .lbl{color:#9aa0a6;}",
    "  .card button{background:#202124;border-color:#5f6368;color:#8ab4f8;}.card button:hover{background:#303134;}",
    "  .tabs{border-color:#3c4043;}.tabs .t{color:#9aa0a6;}.tabs .t.on{color:#e8eaed;border-bottom-color:#8ab4f8;}.list li{border-color:#303134;}.list li a{color:#e8eaed;}",
    "  .card select{background:#202124;border-color:#5f6368;color:#e8eaed;}",
    "  .row{color:#bdc1c6;}.row.own{background:rgba(138,180,248,0.12);}",
    "  .chip{color:#bdc1c6;}.chip b{color:#8ab4f8;}",
    "  .pill{background:#1f3141;color:#8ab4f8;}.pill.o{background:#1e3327;color:#81c995;}.pill.r{background:#3c1f1e;color:#f28b82;}.pill.g{background:#2f3136;color:#9aa0a6;}",
    "  .drop{background:#202124;border-color:#5f6368;}.drop button{color:#e8eaed;}.drop button:hover{background:#303134;}",
    "  .head{background:#202124;border-color:#5f6368;color:#bdc1c6;}.head .q{color:#e8eaed;}.head .muted{color:#9aa0a6;}",
    "  .head button{background:#202124;border-color:#5f6368;color:#8ab4f8;}.head button:hover{background:#303134;}",
    "  .head select{background:#202124;border-color:#5f6368;color:#e8eaed;}",
    "}",
  ].join("");

  function shadowHost(tagName, parent) {
    var el = document.createElement(tagName);
    var root = el.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    var layer = document.createElement("div");
    root.appendChild(layer);
    (parent || document.body).appendChild(el);
    return { el: el, layer: layer };
  }

  function d(tagName, className, text) {
    var n = document.createElement(tagName);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // ─── rendering ─────────────────────────────────────────────────────────────────

  function chipRow(intel, result) {
    var row = d("div", "chip");
    if (result.approx) {
      row.title = msg("serpApproxUrl") + (result.cite ? "\n" + result.cite : "");
      row.appendChild(d("span", "muted", "≈"));
    }
    var q = state.hostsData && state.hostsData.query;

    if (intel && intel.own) {
      row.classList.add("own");
      row.appendChild(d("span", null, msg("serpYourSite", [intel.own.label])));
      if (q) {
        var mine = (q.own || []).find(function (o) { return sameUrlHost(o.url, result.url); });
        if (mine) {
          row.appendChild(d("span", null, msg("serpYourUrlStats", [String(mine.clicks), String(mine.impressions), String(mine.position)])));
        } else if ((q.own || []).length) {
          var other = q.own[0];
          row.appendChild(d("span", "warn", msg("serpOtherUrlRanks", [other.url])));
        }
      }
    }
    if (intel) {
      var drChip = d("span", "dr");
      drChip.appendChild(document.createTextNode("DR "));
      drChip.appendChild(d("b", null, intel.dr != null ? String(Math.round(intel.dr)) : state.enriching ? "…" : "—"));
      if (intel.dr == null) drChip.title = state.enriching ? msg("serpEnriching") : msg("serpDrUnknown");
      row.appendChild(drChip);
      if (typeof intel.ageMonths === "number" && intel.ageMonths > 0) {
        var yrs = Math.floor(intel.ageMonths / 12);
        row.appendChild(d("span", null, yrs >= 1 ? msg("serpAgeYears", [String(yrs)]) : msg("serpAgeMonths", [String(intel.ageMonths)])));
      }
      (intel.serpmon || []).slice(0, 1).forEach(function (sm) {
        row.appendChild(d("span", null, msg("serpMonitorChip", [
          String(sm.keywords), String(sm.top10),
          sm.firstSeenAt ? sm.firstSeenAt.slice(0, 10) : "—",
        ])));
        (sm.tags || []).forEach(function (t) {
          var key = "serpTag_" + t;
          row.appendChild(d("span", "pill" + (t === "own" ? " o" : t === "bounced" ? " r" : ""), msg(key)));
        });
      });
      (intel.linksToUs || []).forEach(function (l) {
        row.appendChild(d("span", null, msg("serpLinksToYou", [String(l.links)])));
      });
      if (intel.outreach) row.appendChild(d("span", null, msg("serpOutreachStage", [intel.outreach.stage])));
      if (intel.drops) {
        row.appendChild(d("span", null, intel.drops.watched ? msg("serpDropWatched") : msg("serpDropStage", [intel.drops.stage])));
      }
      if (intel.ownPbn) row.appendChild(d("span", "pill", msg("serpPbn")));
    }
    row.appendChild(menu(result));
    return row;
  }

  function sameUrlHost(a, b) {
    try { return new URL(a).host === new URL(b).host; } catch { return false; }
  }

  function menu(result) {
    var wrap = d("span", "menu");
    var btn = d("button", "menu-btn", "⋯");
    btn.type = "button";
    var drop = d("div", "drop");

    var items = [
      [msg("serpMenuOutreach"), function (note) {
        extApi("POST", "/api/ext/outreach", { url: result.url, note: "" }).then(function (res) {
          note.textContent = res.status === 200 ? msg("serpAdded") : errText(res);
        });
      }],
      [msg("serpMenuWatch"), function (note) {
        extApi("POST", "/api/ext/serp/action", { kind: "drops_watch", host: result.host }).then(function (res) {
          note.textContent = res.status === 200 ? msg("serpDropWatched") : errText(res);
        });
      }],
      [msg("serpMenuCloak"), function (note) {
        if (result.approx) {
          note.textContent = msg("serpApproxUrl");
          note.className = "cloak warn";
          // still check the host root — the only URL that SERP shape honestly names
        }
        runCloak(result, note);
      }],
      [msg("serpMenuOpenDomain"), function () {
        var intel = state.intelByHost[result.host];
        var sm = intel && (intel.serpmon || [])[0];
        if (sm && state.instanceBase) {
          window.open(state.instanceBase + "/serp-monitor/" + sm.projectId + "?tab=domains&q=" + encodeURIComponent(result.host), "_blank", "noopener");
        }
      }],
    ];
    items.forEach(function (pair) {
      var b = d("button", null, pair[0]);
      b.type = "button";
      var note = d("div", "cloak");
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        wrap.classList.remove("open");
        if (!note.parentNode) pair[1](note), wrap.parentNode && wrap.parentNode.appendChild(note);
      });
      drop.appendChild(b);
    });

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      wrap.classList.toggle("open");
    });
    wrap.appendChild(btn);
    wrap.appendChild(drop);
    return wrap;
  }

  function errText(res) {
    var code = res && res.data && res.data.error;
    if (code && msg("err_" + code) !== "err_" + code) return msg("err_" + code);
    if (res && res.status === 429) return msg("err_rate_limited");
    if (res && res.status === 0) return msg("serpNotConfigured");
    return msg("serpCloakError");
  }

  function runCloak(result, note) {
    note.textContent = "…";
    note.className = "cloak";
    extApi("POST", "/api/ext/cloak", { url: result.url, title: result.title, snippet: result.snippet }).then(function (res) {
      if (res.status === 429) { note.className = "cloak warn"; note.textContent = msg("serpWaitMinute"); return; }
      if (res.status !== 200 || !res.data || res.data.error) {
        note.className = "cloak bad";
        note.textContent = errText(res);
        return;
      }
      var c = res.data;
      var v = { same: ["ok", "serpCloakSame"], differs: ["bad", "serpCloakDiffers"], blocked: ["warn", "serpCloakBlocked"], error: ["bad", "serpCloakError"] }[c.verdict] || ["bad", "serpCloakError"];
      note.className = "cloak " + v[0];
      note.textContent = msg(v[1]);
      if (c.reasons && c.reasons.length) note.textContent += " (" + c.reasons.join(", ") + ")";
      if (c.bot && c.browser && (c.bot.snippetFound != null || c.browser.snippetFound != null)) {
        note.appendChild(d("div", null, msg("serpCloakSnippet", [
          c.bot.snippetFound == null ? "—" : c.bot.snippetFound ? msg("serpYes") : msg("serpNo"),
          c.browser.snippetFound == null ? "—" : c.browser.snippetFound ? msg("serpYes") : msg("serpNo"),
        ])));
      }
    });
  }

  function drawRows() {
    if (!state.parsed || !state.hostsData) return;
    var t0 = performance.now();
    state.parsed.results.forEach(function (result) {
      var block = result.node;
      if (!block || !block.isConnected || state.drawn.has(block)) return;
      state.drawn.add(block);

      if (state.settings.serpPositions) drawPosition(result, block);

      var host2 = shadowHost("opengsc-serp-row");
      host2.el.style.display = "block";
      var entry = { result: result, layer: host2.layer };
      state.rows.push(entry);
      paintRow(entry);
      // after the title block, before the snippet
      var titleNode = result.titleNode || block.querySelector("a[href] h3, a[href] [role='heading'], h2");
      var container = titleNode ? (titleNode.closest("a") || titleNode).closest("div, h2") || block : block;
      if (container === block || !block.contains(container)) block.appendChild(host2.el);
      else container.parentNode.insertBefore(host2.el, container.nextSibling);
    });
    state.perf.renderMs = Math.round(performance.now() - t0);
  }

  function paintRow(entry) {
    entry.layer.textContent = "";
    entry.layer.appendChild(chipRow(state.intelByHost[entry.result.host] || null, entry.result));
  }

  function redrawRows() {
    state.rows.forEach(function (entry) { if (entry.layer.isConnected) paintRow(entry); });
  }

  /** The rank number in the left gutter, level with the title. Zero-size host right before
   *  the result, so Google's own elements stay untouched. */
  function drawPosition(result, block) {
    if (!block.parentNode) return;
    var host = shadowHost("opengsc-serp-pos");
    host.el.style.cssText = "display:block;position:relative;height:0;width:0;overflow:visible;";
    var badge = d("span", "pos", String(result.position));
    var title = result.titleNode;
    var offset = 0;
    try {
      if (title) offset = Math.max(0, Math.round(title.getBoundingClientRect().top - block.getBoundingClientRect().top));
    } catch { /* offset 0 */ }
    badge.style.top = offset + "px";
    host.layer.appendChild(badge);
    block.parentNode.insertBefore(host.el, block);
  }

  // ─── ads ───────────────────────────────────────────────────────────────────────

  var AD_CSS = {
    google: "#tads,#tadsb,#bottomads,[data-text-ad]{display:none!important}",
    bing: "#b_results>li.b_ad,.b_adTop,.b_adBottom,#b_results>li.b_adLastChild{display:none!important}",
    yandex: "[data-fast-name=\"direct\"],li.serp-item[data-fast-name^=\"adv\"],.serp-adv__item,.serp-adv-item{display:none!important}",
  };
  var AD_HEADING_RE = /^(реклама( мест)?|sponsored( places| results| products)?|ads|ad|διαφήμιση|χορηγούμεν[οα]|anzeigen?|annunci|anuncios?|annonces?|gesponsord|sponsorlu|реклама місць|赞助商?|广告)$/i;
  var adStyle = null;
  var hiddenAds = [];

  /** Hide paid blocks: one stylesheet for the known containers, plus the sponsored-places
   *  carousels found by their heading. Turning it off restores everything. */
  function applyAdHiding(on) {
    var engine = (state.parsed && state.parsed.engine) || "google";
    if (!on) {
      if (adStyle) { adStyle.remove(); adStyle = null; }
      hiddenAds.forEach(function (n) { n.style.removeProperty("display"); });
      hiddenAds = [];
      return;
    }
    if (!adStyle) {
      adStyle = document.createElement("style");
      adStyle.textContent = AD_CSS[engine] || AD_CSS.google;
      (document.head || document.documentElement).appendChild(adStyle);
    }
    if (engine !== "google") return;
    var scope = document.getElementById("center_col") || document.getElementById("rcnt") || document.body;
    var rso = document.getElementById("rso");
    scope.querySelectorAll('[role="heading"], h2, h3, span, div').forEach(function (n) {
      if (n.childElementCount > 1) return;
      var t = String(n.textContent || "").trim();
      if (!t || t.length > 30 || !AD_HEADING_RE.test(t)) return;
      // climb to the block that is a direct child of the results list (or of center_col)
      var blk = n;
      while (blk.parentElement && blk.parentElement !== rso && blk.parentElement !== scope && blk.parentElement !== document.body) blk = blk.parentElement;
      if (blk && blk !== scope && blk.id !== "rso" && hiddenAds.indexOf(blk) === -1 && !blk.querySelector("opengsc-serp-row")) {
        blk.style.setProperty("display", "none", "important");
        hiddenAds.push(blk);
      }
    });
  }

  // ─── the side card ─────────────────────────────────────────────────────────────

  /** Where the card lives: the engine's right column when there is one, else a column we add
   *  next to the results (Google), else right above the results. */
  function mountCard() {
    var engine = (state.parsed && state.parsed.engine) || "google";
    var host = shadowHost("opengsc-serp-head");
    host.el.style.display = "block";
    var side = null;
    if (engine === "google") side = document.getElementById("rhs");
    if (engine === "bing") side = document.getElementById("b_context");
    if (engine === "yandex") side = document.querySelector("#search-result-aside, .content__right");
    if (side) {
      side.insertBefore(host.el, side.firstChild);
      host.el.style.maxWidth = "420px";
      return host;
    }
    var rcnt = engine === "google" ? document.getElementById("rcnt") : null;
    var center = document.getElementById("center_col");
    var results = document.getElementById("rso") || document.getElementById("b_results") || document.getElementById("search-result");
    if (rcnt && results) {
      // Google lays #rcnt out as a CSS grid; the native right column (#rhs) spans
      // "span 7 / -2". Taking the same columns right after #center_col auto-places the card
      // in the results' row. On an older flex layout the width/flex values do the same job.
      if (center && center.parentNode === rcnt) rcnt.insertBefore(host.el, center.nextSibling);
      else rcnt.appendChild(host.el);
      host.el.style.cssText = getComputedStyle(rcnt).display === "grid"
        ? "display:block;grid-column:span 7 / -2;align-self:start;max-width:372px;"
        : "display:block;width:360px;flex:0 0 360px;margin-left:56px;";
      // not a flex row on this layout → it fell below the results; put it on top instead
      var fell = host.el.getBoundingClientRect().top - results.getBoundingClientRect().top > 200;
      if (!fell) return host;
      host.el.style.cssText = "display:block;";
    }
    if (results && results.parentNode) results.parentNode.insertBefore(host.el, results);
    host.el.style.maxWidth = "652px";
    return host;
  }

  function regionText(meta) {
    var parts = [];
    if (meta.engineHost) parts.push(meta.engineHost.replace(/^www\./, ""));
    if (meta.country) parts.push(meta.country.toUpperCase());
    return parts.join(" · ") || msg("serpRegionUnknown");
  }

  function drawHeader() {
    if (!state.parsed || !state.hostsData) return;
    if (!state.card) state.card = mountCard();
    renderCard();
  }

  function renderCard() {
    var layer = state.card.layer;
    layer.textContent = "";
    var meta = state.parsed.meta;
    var q = state.hostsData.query;
    var missing = state.hostsData.missing || { age: 0, dr: 0 };

    var card = d("div", "card");
    var top = d("div", "top");
    top.appendChild(d("span", "brand", "OpenGSC"));
    top.appendChild(d("span", "q", meta.query || ""));
    top.appendChild(d("span", "muted", regionText(meta)));
    card.appendChild(top);

    // quick ad toggle — same setting as in the options page
    var adToggle = d("label", "toggle");
    var adBox = document.createElement("input");
    adBox.type = "checkbox";
    adBox.checked = !!state.settings.serpHideAds;
    adBox.addEventListener("change", function () {
      state.settings.serpHideAds = adBox.checked;
      applyAdHiding(adBox.checked);
      CR.storage.local.get(["extSettings"], function (stored) {
        var s = (stored && stored.extSettings) || {};
        s.serpHideAds = adBox.checked;
        CR.storage.local.set({ extSettings: s });
      });
    });
    adToggle.appendChild(adBox);
    adToggle.appendChild(document.createTextNode(msg("optSerpHideAds")));

    if (state.notConfigured) {
      card.appendChild(d("div", "sec warn", msg("serpNotConfigured")));
      card.appendChild(adToggle);
      layer.appendChild(card);
      return;
    }

    if (q) {
      card.appendChild(d("div", "lbl", msg("serpYourPositions")));
      var own = d("div", "sec");
      if ((q.own || []).length) {
        q.own.forEach(function (o) {
          var line = d("div");
          line.appendChild(d("b", null, o.label + " "));
          line.appendChild(document.createTextNode(msg("serpYourUrlStats", [String(o.clicks), String(o.impressions), String(o.position)])));
          own.appendChild(line);
        });
      } else {
        own.appendChild(d("span", "muted", "—"));
      }
      (q.tracked || []).forEach(function (t) {
        own.appendChild(d("div", null, t.label + ": " + msg("serpTracked", [
          t.lastPosition == null ? "—" : String(t.lastPosition),
          t.lastCheckedAt ? t.lastCheckedAt.slice(0, 10) : "—",
        ])));
      });
      card.appendChild(own);
      (q.serpmon || []).forEach(function (sm) {
        card.appendChild(d("div", "sec", msg("serpMonitored", [sm.projectName]) + " · " + (sm.lastRunStorm ? "⚠ " + msg("serpStorm") : msg("serpNoStorm"))));
      });
      if (q.metrics && (q.metrics.volume != null || q.metrics.difficulty != null)) {
        card.appendChild(d("div", "sec muted", msg("serpQueryMetrics", [
          q.metrics.volume == null ? "—" : String(q.metrics.volume),
          q.metrics.difficulty == null ? "—" : String(q.metrics.difficulty),
          q.metrics.checkedAt ? q.metrics.checkedAt.slice(0, 10) : "—",
        ])));
      }
    }

    var btns = d("div", "btns");
    var toRank = d("button", null, msg("serpToRank"));
    toRank.type = "button";
    toRank.addEventListener("click", function () { pickSiteAndTrack(meta); });
    btns.appendChild(toRank);
    var toMon = d("button", null, msg("serpToMonitor"));
    toMon.type = "button";
    toMon.addEventListener("click", function () { pickProjectAndAdd(meta); });
    btns.appendChild(toMon);
    var save = d("button", null, msg("serpCapture"));
    save.type = "button";
    save.addEventListener("click", function () { saveCapture(save, meta); });
    btns.appendChild(save);
    if (missing.age + missing.dr > 0 && !state.enriching) {
      var enrich = d("button", null, msg("serpEnrich", [String(missing.age + missing.dr)]));
      enrich.type = "button";
      enrich.addEventListener("click", function () { enrich.disabled = true; runEnrich(true); });
      btns.appendChild(enrich);
    }
    if (state.enriching) btns.appendChild(d("span", "muted", msg("serpEnriching")));
    card.appendChild(btns);
    card.appendChild(adToggle);

    // related searches / people also ask, from the page itself
    var ex = state.extras || { paa: [], related: [] };
    if (ex.related.length || ex.paa.length) {
      if (state.cardTab === "related" && !ex.related.length) state.cardTab = "paa";
      if (state.cardTab === "paa" && !ex.paa.length) state.cardTab = "related";
      var tabs = d("div", "tabs");
      [["related", "serpRelated", ex.related], ["paa", "serpPaa", ex.paa]].forEach(function (t) {
        if (!t[2].length) return;
        var b = d("button", "t" + (state.cardTab === t[0] ? " on" : ""), msg(t[1]));
        b.type = "button";
        b.addEventListener("click", function () { state.cardTab = t[0]; renderCard(); });
        tabs.appendChild(b);
      });
      var list = state.cardTab === "paa" ? ex.paa : ex.related;
      var copy = d("button", "copy", msg("serpCopy"));
      copy.type = "button";
      copy.addEventListener("click", function () {
        try {
          navigator.clipboard.writeText(list.join("\n")).then(function () { copy.textContent = msg("ogCopied"); });
        } catch { /* clipboard blocked */ }
      });
      tabs.appendChild(copy);
      card.appendChild(tabs);
      var ul = d("ul", "list");
      list.forEach(function (text) {
        var li = d("li");
        if (state.cardTab === "related") {
          var a = d("a", null, text);
          var u = new URL(window.location.href);
          u.searchParams.set(state.parsed.engine === "yandex" ? "text" : "q", text);
          u.searchParams.delete("start"); u.searchParams.delete("first"); u.searchParams.delete("p");
          a.href = u.href;
          li.appendChild(a);
        } else {
          li.textContent = text;
        }
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    layer.appendChild(card);
  }

  // ─── free age + DR, automatically ─────────────────────────────────────────────

  var ENRICH_TRIED_KEY = "serpEnrichTried";
  var ENRICH_RETRY_MS = 3 * 24 * 3600 * 1000;

  /** Ask the server to fill age + DR for hosts it does not know yet (free: RDAP/WHOIS and the
   *  free DR endpoint), then repaint. Auto mode skips hosts tried in the last 3 days, so a host
   *  with no DR anywhere is not re-asked on every search. */
  function runEnrich(manual) {
    if (state.enriching || state.notConfigured) return;
    CR.storage.local.get([ENRICH_TRIED_KEY], function (stored) {
      var tried = (stored && stored[ENRICH_TRIED_KEY]) || {};
      var now = Date.now();
      Object.keys(tried).forEach(function (h) { if (now - tried[h] > ENRICH_RETRY_MS) delete tried[h]; });
      var hosts = [];
      state.parsed.results.forEach(function (r) {
        var i = state.intelByHost[r.host];
        if (!i || (i.dr != null && i.ageMonths != null)) return;
        if (!manual && tried[r.host]) return;
        if (hosts.indexOf(r.host) === -1) hosts.push(r.host);
      });
      hosts = hosts.slice(0, 40);
      if (!hosts.length) return;
      hosts.forEach(function (h) { tried[h] = now; });
      var set = {}; set[ENRICH_TRIED_KEY] = tried;
      CR.storage.local.set(set);

      state.enriching = true;
      redrawRows();
      renderCard();
      var chain = Promise.resolve();
      for (var i = 0; i < hosts.length; i += 20) {
        (function (batch) {
          chain = chain.then(function () { return extApi("POST", "/api/ext/hosts/enrich", { hosts: batch }); });
        })(hosts.slice(i, i + 20));
      }
      chain.then(function () {
        return new Promise(function (resolve) {
          CR.runtime.sendMessage({ type: ExtProtocol.MSG_SERP_INVALIDATE, query: state.parsed.meta.query }, function () {
            void CR.runtime.lastError;
            resolve();
          });
        });
      }).then(function () {
        return serpHosts({
          hosts: state.parsed.results.map(function (r) { return r.host; }),
          query: state.parsed.meta.query, country: state.parsed.meta.country, lang: state.parsed.meta.lang,
        });
      }).then(function (res) {
        state.enriching = false;
        if (res && res.status === 200 && res.data && res.data.hosts) {
          state.hostsData = res.data;
          res.data.hosts.forEach(function (intel) { state.intelByHost[intel.host] = intel; });
        }
        redrawRows();
        renderCard();
      });
    });
  }

  function saveCapture(btn, meta) {
    btn.disabled = true;
    var body = {
      query: meta.query,
      engineHost: meta.engineHost,
      country: meta.country || "",
      lang: meta.lang || "",
      device: meta.device,
      page: meta.page,
      startPos: meta.startPos,
      results: state.parsed.results.map(function (r) {
        return { position: r.position, url: r.url, title: r.title, snippet: r.snippet, approx: !!r.approx };
      }),
      features: state.parsed.features,
    };
    extApi("POST", "/api/ext/serp/capture", body).then(function (res) {
      btn.disabled = false;
      if (res.status !== 200 || !res.data || res.data.error) {
        btn.textContent = errText(res);
        return;
      }
      var link = document.createElement("a");
      link.textContent = msg("serpCaptured");
      if (state.instanceBase && res.data.projectId) {
        link.href = state.instanceBase + "/serp-monitor/" + res.data.projectId + "?tab=captures";
        link.target = "_blank";
        link.rel = "noopener";
      }
      btn.textContent = "";
      btn.appendChild(link);
    });
  }

  function pickSiteAndTrack(meta) {
    var ownSite = Object.keys(state.intelByHost).map(function (h) { return state.intelByHost[h]; })
      .find(function (i) { return i && i.own; });
    var siteId = ownSite ? ownSite.own.siteId : state.settings.defaultSiteId;
    if (siteId) {
      trackKeyword(meta, siteId);
      return;
    }
    // no own site on this SERP and no default: offer the dropdown
    extApi("GET", "/api/ext/lists").then(function (res) {
      if (res.status !== 200 || !res.data || !res.data.sites || !res.data.sites.length) {
        alertBox(msg("serpPickSite"));
        return;
      }
      var sel = document.createElement("select");
      res.data.sites.slice(0, 200).forEach(function (s) {
        var o = document.createElement("option");
        o.value = s.id;
        o.textContent = s.label;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { if (sel.value) trackKeyword(meta, sel.value); });
      var headEl = document.querySelector("opengsc-serp-head");
      var place = headEl && headEl.shadowRoot && headEl.shadowRoot.querySelector(".card");
      if (place) { place.appendChild(sel); place.appendChild(d("span", "muted", msg("serpPickSite"))); }
    });
  }

  function trackKeyword(meta, siteId) {
    extApi("POST", "/api/ext/serp/action", {
      kind: "rank_track", query: meta.query, siteId: siteId,
      country: meta.country || "us", lang: meta.lang || "en", device: meta.device,
    }).then(function (res) {
      alertBox(res.status === 200 && res.data && res.data.ok
        ? (res.data.added ? msg("serpAdded") : msg("serpAlready"))
        : errText(res));
    });
  }

  function pickProjectAndAdd(meta) {
    var matching = null;
    if (state.hostsData && state.hostsData.query) {
      // a project that tracks this keyword — from q.serpmon
      matching = (state.hostsData.query.serpmon || [])[0];
    }
    var projectId = matching ? matching.projectId : state.settings.defaultProjectId;
    if (projectId) {
      addKeyword(meta, projectId);
      return;
    }
    extApi("GET", "/api/ext/lists").then(function (res) {
      if (res.status !== 200 || !res.data || !res.data.projects || !res.data.projects.length) {
        alertBox(msg("serpPickProject"));
        return;
      }
      var projects = res.data.projects.filter(function (p) {
        return !meta.country || !p.country || p.country === meta.country;
      });
      if (projects.length === 1) { addKeyword(meta, projects[0].id); return; }
      var sel = document.createElement("select");
      projects.slice(0, 100).forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name + " · " + p.country + "/" + p.lang;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { if (sel.value) addKeyword(meta, sel.value); });
      var headEl = document.querySelector("opengsc-serp-head");
      var place = headEl && headEl.shadowRoot && headEl.shadowRoot.querySelector(".card");
      if (place) { place.appendChild(sel); place.appendChild(d("span", "muted", msg("serpPickProject"))); }
    });
  }

  function addKeyword(meta, projectId) {
    extApi("POST", "/api/ext/serp/action", { kind: "serpmon_keyword", query: meta.query, projectId: projectId })
      .then(function (res) {
        alertBox(res.status === 200 && res.data && res.data.ok
          ? (res.data.added ? msg("serpAdded") : msg("serpAlready"))
          : errText(res));
      });
  }

  function alertBox(text) {
    var headEl = document.querySelector("opengsc-serp-head");
    var place = headEl && headEl.shadowRoot && headEl.shadowRoot.querySelector(".card");
    if (place) {
      var note = d("span", "muted", text);
      place.appendChild(note);
      setTimeout(function () { note.remove(); }, 6000);
    }
  }

  // ─── boot ──────────────────────────────────────────────────────────────────────

  function boot() {
    ExtI18n.ready().then(bootInner);
  }

  function bootInner() {
    if (document.visibilityState === "hidden") {
      document.addEventListener("visibilitychange", function onVis() {
        document.removeEventListener("visibilitychange", onVis);
        bootInner();
      });
      return;
    }

    var t0 = performance.now();
    var parsed = SerpParse.parse(document);
    state.perf.parseMs = Math.round(performance.now() - t0);
    if (!parsed) {
      try { console.debug("[opengsc] serp: no results matched"); } catch { /* */ }
      return;
    }
    state.parsed = parsed;
    try { state.extras = SerpParse.extras(document); } catch { /* card without lists */ }

    getSettings().then(function (s) {
      state.settings = s;
      if (s.serpHideAds) applyAdHiding(true);
      CR.storage.local.get(["baseUrl"], function (stored) {
        state.instanceBase = String((stored && stored.baseUrl) || "").replace(/\/+$/, "");
        return serpHosts({
          hosts: parsed.results.map(function (r) { return r.host; }),
          query: parsed.meta.query,
          country: parsed.meta.country,
          lang: parsed.meta.lang,
        }).then(function (res) {
          if (res.status === 0 || !res.data) {
            state.notConfigured = true;
            state.hostsData = { hosts: [], query: null, missing: { age: 0, dr: 0 } };
          } else if (res.status === 200 && res.data && !res.data.error) {
            state.hostsData = res.data;
            (res.data.hosts || []).forEach(function (intel) {
              state.intelByHost[intel.host] = intel;
            });
          } else {
            state.error = res.data && res.data.error;
            state.hostsData = { hosts: [], query: null, missing: { age: 0, dr: 0 } };
          }
          drawHeader();
          drawRows();
          watchScroll();
          if (state.settings.serpAutoEnrich) runEnrich(false);
        });
      });
    });
  }

  var scrollTimer = 0;
  function watchScroll() {
    var container = document.querySelector("#rso") || document.querySelector("#search");
    if (!container || typeof MutationObserver === "undefined") return;
    var observer = new MutationObserver(function () {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        var reparsed = SerpParse.parse(document);
        if (!reparsed) return;
        state.parsed = reparsed;
        // infinite scroll: ask only for hosts we have not seen yet
        var fresh = [];
        reparsed.results.forEach(function (r) {
          if (!state.intelByHost[r.host] && !state.requestedHosts[r.host]) {
            state.requestedHosts[r.host] = 1;
            fresh.push(r.host);
          }
        });
        var done = function () {
          drawRows();
          if (state.settings.serpHideAds) applyAdHiding(true);
        };
        if (!fresh.length) { done(); return; }
        serpHosts({ hosts: fresh, query: reparsed.meta.query, country: reparsed.meta.country, lang: reparsed.meta.lang })
          .then(function (res) {
            if (res.status === 200 && res.data && res.data.hosts) {
              res.data.hosts.forEach(function (intel) { state.intelByHost[intel.host] = intel; });
            }
            done();
          });
      }, 500);
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
})();
