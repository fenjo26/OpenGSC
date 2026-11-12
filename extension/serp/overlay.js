// OpenGSC extension — the Google SERP overlay (wave-ext E4). Registered as "opengsc-serp"
// on every search domain from the manifest; runs at document_idle, reads the results the user opened
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
  // once per page: an extension reload or a leftover dynamic registration must not double it
  if (globalThis.__opengscSerpOverlay) return;
  globalThis.__opengscSerpOverlay = true;

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
    noDrKey: false,        // the instance has no Ahrefs DR key: say so instead of "DR —" forever
    collected: [],         // the user's own list of related / PAA queries (storage.local)
    placeTimer: 0,
    statusTimer: 0,
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
          serpOverlay: s.serpOverlay !== false,
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
    ".pos{position:absolute;right:16px;width:34px;text-align:right;display:block;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-weight:600;font-size:16px;line-height:26px;color:#70757a;font-variant-numeric:tabular-nums;}",
    ".dr b{color:#202124;}",
    // side card
    ".card{box-sizing:border-box;border:1px solid #dadce0;border-radius:12px;padding:12px 14px;background:#fff;color:#3c4043;margin:0 0 18px;font-size:12.5px;}",
    ".card .top{display:flex;align-items:center;gap:8px;margin-bottom:8px;}",
    ".card .brand{font-weight:800;color:#1a73e8;letter-spacing:.2px;}",
    ".card .q{font-weight:700;color:#202124;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
    ".card .muted{color:#70757a;}",
    ".card .sec{margin:6px 0;line-height:1.5;}",
    ".card .lbl{color:#70757a;font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-top:8px;}",
    ".card .btns{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 6px;}",
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
    ".card .info{margin:8px 0 2px;font-size:11.5px;line-height:1.5;}",
    ".card .warn{color:#b06000;}",
    ".card .status{font-size:11.5px;color:#137333;min-height:0;}",
    ".card .status:not(:empty){margin:4px 0 6px;}",
    ".card .pick{border:1px solid #e8eaed;border-radius:10px;padding:10px;margin:4px 0 8px;background:#f8f9fa;}",
    ".card .pick .pt{font-weight:600;color:#202124;margin-bottom:6px;}",
    ".card .pick select{width:100%;padding:5px 6px;margin-bottom:8px;box-sizing:border-box;}",
    ".card .pick .pr{display:flex;gap:6px;}",
    ".card button.primary{background:#1a73e8;border-color:#1a73e8;color:#fff;}",
    ".card button.primary:hover{background:#1765cc;}",
    ".lbar{display:flex;gap:14px;justify-content:flex-end;margin:6px 0 2px;}",
    ".card button.link{border:none;background:none;padding:0;color:#1a73e8;font-weight:500;font-size:11.5px;}",
    ".card button.link:hover{text-decoration:underline;background:none;}",
    ".list li{display:flex;align-items:center;gap:8px;}",
    ".list li .txt{flex:1;min-width:0;}",
    ".card button.plus{flex:0 0 auto;width:22px;height:22px;padding:0;border-radius:50%;font-size:14px;line-height:20px;text-align:center;color:#5f6368;}",
    ".card button.plus.on{background:#e6f4ea;border-color:#ceead6;color:#137333;}",
    ".toggle{display:inline-flex;align-items:center;gap:5px;color:#5f6368;font-size:11.5px;cursor:pointer;white-space:nowrap;}",
    "@media (prefers-color-scheme:dark){",
    "  .pos{color:#9aa0a6;}.dr b{color:#e8eaed;}",
    "  .card{background:#202124;border-color:#5f6368;color:#bdc1c6;}.card .q{color:#e8eaed;}.card .muted,.card .lbl{color:#9aa0a6;}",
    "  .card button{background:#202124;border-color:#5f6368;color:#8ab4f8;}.card button:hover{background:#303134;}",
    "  .tabs{border-color:#3c4043;}.tabs .t{color:#9aa0a6;}.tabs .t.on{color:#e8eaed;border-bottom-color:#8ab4f8;}.list li{border-color:#303134;}.list li a{color:#e8eaed;}",
    "  .card select{background:#202124;border-color:#5f6368;color:#e8eaed;}",
    "  .card .pick{background:#303134;border-color:#3c4043;}.card .pick .pt{color:#e8eaed;}.card button.link{color:#8ab4f8;}.card button.plus.on{background:#1e3327;border-color:#1e3327;color:#81c995;}",
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
      if (title) {
        // the host sits right before the block, so block-top is our zero; centre the number on
        // the title's FIRST line (titles wrap) using the title's own line box
        var cs = getComputedStyle(title);
        var fontPx = parseFloat(cs.fontSize) || 20;
        var linePx = parseFloat(cs.lineHeight);
        if (!linePx || isNaN(linePx)) linePx = Math.round(fontPx * 1.3);
        var rect = title.getClientRects()[0] || title.getBoundingClientRect();
        offset = Math.max(0, Math.round(rect.top - block.getBoundingClientRect().top));
        badge.style.height = linePx + "px";
        badge.style.lineHeight = linePx + "px";
        badge.style.fontSize = Math.round(Math.max(13, fontPx * 0.8)) + "px";
      }
    } catch { /* default size, offset 0 */ }
    badge.style.top = offset + "px";
    host.layer.appendChild(badge);
    block.parentNode.insertBefore(host.el, block);
  }

  // ─── ads ───────────────────────────────────────────────────────────────────────

  var AD_CSS = {
    google: "#tads,#tadsb,#bottomads,[data-text-ad],#atvcap,.cu-container,.commercial-unit-desktop-rhs,.commercial-unit-desktop-top{display:none!important}",
    bing: "#b_results>li.b_ad,.b_adTop,.b_adBottom,#b_results>li.b_adLastChild{display:none!important}",
    yandex: "[data-fast-name=\"direct\"],li.serp-item[data-fast-name^=\"adv\"],.serp-adv__item,.serp-adv-item{display:none!important}",
  };
  var AD_HEADING_RE = /^(реклама( мест)?|sponsored( places| results| products)?|ads|ad|διαφήμιση|χορηγούμεν[οα]|anzeigen?|annunci|anuncios?|annonces?|gesponsord|sponsorlu|реклама місць|赞助商?|广告)$/i;
  var adStyle = null;
  var hiddenAds = [];

  /** Hide paid blocks: one stylesheet for the known containers, plus the sponsored-places
   *  carousels found by their heading. Turning it off restores everything. */
  function applyAdHiding(on) {
    toggleAds(on);
    // hidden ads free their space (and shown ones take it back) — the floating card follows
    if (state.card && state.card.floating) placeCard(state.card);
  }

  function toggleAds(on) {
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
    if (side && side.getBoundingClientRect().width > 200) {
      side.insertBefore(host.el, side.firstChild);
      host.el.style.maxWidth = "420px";
      return host;
    }
    // No native right column on this SERP (local pack, no knowledge panel…). Google's grid
    // placement proved unreliable across layouts, so the card floats in the free space to
    // the right of the results instead — measured, and re-measured on resize.
    host.floating = true;
    placeCard(host);
    var replace = function () {
      clearTimeout(state.placeTimer);
      state.placeTimer = setTimeout(function () { placeCard(host); }, 150);
    };
    window.addEventListener("resize", replace);
    // The page keeps moving after we mount: the AI overview loads late and grows on "Show
    // more", and our own card gets taller as data arrives. Re-measure on either.
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(replace);
      ro.observe(host.el);
      var page = document.getElementById("rcnt") || resultsColumn();
      if (page) ro.observe(page);
    }
    return host;
  }

  /** Vertical spans (document coordinates) that the engine's own content occupies inside the
   *  horizontal band [left, right] beside the results. Google has no #rhs on many SERPs yet
   *  still draws there — the AI overview's sources panel is the usual one — so the floating
   *  card must look before it lands. Wrappers that also span the results column are opened
   *  up; whatever sits in the band itself counts whole. A sticky block claims the full track
   *  it slides along (its parent), not just where it happens to be right now. */
  function sideObstacles(left, right, col, own) {
    var out = [];
    var budget = 3000;
    var sy = window.scrollY;
    function ownText(el) {
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue.trim()) return true;
      }
      return false;
    }
    function kids(el, depth) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c, depth + 1);
    }
    function walk(el, depth) {
      if (el === own || budget-- <= 0 || depth > 60) return;
      if (/^OPENGSC-/.test(el.tagName)) return;
      if (el.contains(col)) { if (el !== col) kids(el, depth); return; }
      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") return;
      var r = el.getBoundingClientRect();
      if (cs.display === "contents" || ((r.width < 2 || r.height < 2) && cs.overflow === "visible")) { kids(el, depth); return; }
      if (r.width < 2 || r.height < 2 || cs.opacity === "0") return;
      if (r.right <= left + 4 || r.left >= right - 4) return;
      if (cs.position === "sticky") {
        var pr = el.parentElement ? el.parentElement.getBoundingClientRect() : r;
        out.push({ top: Math.min(pr.top, r.top) + sy, bottom: Math.max(pr.bottom, r.bottom) + sy });
        return;
      }
      var wrapper = r.left < left - 40 && el.firstElementChild && !ownText(el) &&
        !/^(IMG|SVG|VIDEO|CANVAS|IFRAME)$/i.test(el.tagName);
      if (wrapper) { kids(el, depth); return; }
      out.push({ top: r.top + sy, bottom: r.bottom + sy });
    }
    var root = document.getElementById("rcnt") || document.body;
    if (root && col) walk(root, 0);
    return out.sort(function (a, b) { return a.top - b.top; });
  }

  function resultsColumn() {
    return document.getElementById("center_col") || document.getElementById("rso") ||
      document.getElementById("b_results") || document.getElementById("search-result");
  }

  function placeCard(host) {
    var col = resultsColumn();
    var top = document.getElementById("rcnt") || col;
    var room = col ? document.documentElement.clientWidth - col.getBoundingClientRect().right - 48 - 24 : 0;
    if (col && room >= 300) {
      var cr = col.getBoundingClientRect();
      var width = Math.min(380, Math.round(room));
      var left = cr.right + 48;
      // start level with the results, then slide down past anything the engine put there
      var y = top.getBoundingClientRect().top + window.scrollY;
      var height = Math.max(host.el.offsetHeight || 0, 160);
      sideObstacles(left, left + width, col, host.el).forEach(function (o) {
        if (o.bottom > y - 16 && o.top < y + height + 16) y = o.bottom + 16;
      });
      var css = "display:block;position:absolute;z-index:2;" +
        "top:" + Math.round(y) + "px;" +
        "left:" + Math.round(left + window.scrollX) + "px;" +
        "width:" + width + "px;";
      if (host.el.parentNode !== document.body) document.body.appendChild(host.el);
      if (host.css !== css) { host.css = css; host.el.style.cssText = css; }
      return;
    }
    host.css = "";
    // narrow window: above the results, in the flow
    var results = document.getElementById("rso") || document.getElementById("b_results") || document.getElementById("search-result");
    if (results && results.parentNode && host.el.nextSibling !== results) results.parentNode.insertBefore(host.el, results);
    host.el.style.cssText = "display:block;max-width:652px;";
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
    // keep an open picker / a fresh status line across repaints (enrich finishing, a tab click)
    var oldPicker = cardPart("picker"), oldStatus = cardPart("status");
    layer.textContent = "";
    var meta = state.parsed.meta;
    var q = state.hostsData.query;

    var card = d("div", "card");
    var top = d("div", "top");
    top.appendChild(d("span", "brand", "OpenGSC"));
    top.appendChild(d("span", "q", meta.query || ""));
    top.appendChild(d("span", "muted", regionText(meta)));
    card.appendChild(top);

    if (state.notConfigured) {
      card.appendChild(d("div", "sec warn", msg("serpNotConfigured")));
      card.appendChild(adToggle());
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

    // actions: one tidy segmented row; the pickers open in their own panel below it
    var btns = d("div", "btns");
    [["serpToRank", function () { pickSiteAndTrack(meta); }],
      ["serpToMonitor", function () { pickProjectAndAdd(meta); }],
      ["serpCapture", function (b) { saveCapture(b, meta); }]].forEach(function (a) {
      var b = d("button", null, msg(a[0]));
      b.type = "button";
      b.addEventListener("click", function () { a[1](b); });
      btns.appendChild(b);
    });
    card.appendChild(btns);
    card.appendChild(oldPicker || d("div", "picker"));
    card.appendChild(oldStatus || d("div", "status"));

    // data line: what the rows are missing, with a quiet refresh — not a fourth big button
    var info = d("div", "info");
    var miss = missingHosts();
    if (state.enriching) {
      info.appendChild(d("span", "spin"));
      info.appendChild(d("span", "muted", " " + msg("serpEnriching")));
    } else if (state.noDrKey) {
      info.appendChild(d("span", "warn", msg("serpNoDrKey") + " "));
      if (state.instanceBase) {
        var k = d("a", null, msg("serpSetKey"));
        k.href = state.instanceBase + "/settings?tab=metrics";
        k.target = "_blank"; k.rel = "noopener";
        info.appendChild(k);
      }
    } else if (miss.length) {
      info.appendChild(d("span", "muted", msg("serpDataMissing", [String(miss.length), String(uniqueHosts().length)]) + " · "));
      var re = d("a", null, msg("serpRefresh"));
      re.href = "#";
      re.addEventListener("click", function (e) { e.preventDefault(); runEnrich(true); });
      info.appendChild(re);
    }
    if (info.childNodes.length) card.appendChild(info);
    card.appendChild(adToggle());

    renderLists(card);
    layer.appendChild(card);
  }

  function adToggle() {
    var label = d("label", "toggle");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!state.settings.serpHideAds;
    box.addEventListener("change", function () {
      state.settings.serpHideAds = box.checked;
      applyAdHiding(box.checked);
      CR.storage.local.get(["extSettings"], function (stored) {
        var s = (stored && stored.extSettings) || {};
        s.serpHideAds = box.checked;
        CR.storage.local.set({ extSettings: s });
      });
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(msg("optSerpHideAds")));
    return label;
  }

  function uniqueHosts() {
    var seen = {};
    return state.parsed.results.map(function (r) { return r.host; }).filter(function (h) {
      if (!h || seen[h]) return false;
      seen[h] = 1;
      return true;
    });
  }

  function missingHosts() {
    return uniqueHosts().filter(function (h) {
      var i = state.intelByHost[h];
      return i && (i.dr == null || i.ageMonths == null);
    });
  }

  // ─── related / PAA lists + the user's own collected list ────────────────────────

  var COLLECT_KEY = "serpCollected";

  function loadCollected(cb) {
    CR.storage.local.get([COLLECT_KEY], function (stored) {
      var list = stored && Array.isArray(stored[COLLECT_KEY]) ? stored[COLLECT_KEY] : [];
      state.collected = list;
      cb();
    });
  }

  function saveCollected() {
    var set = {};
    set[COLLECT_KEY] = state.collected.slice(0, 1000);
    CR.storage.local.set(set);
  }

  function isCollected(text) {
    return state.collected.indexOf(text) !== -1;
  }

  function toggleCollected(text) {
    var i = state.collected.indexOf(text);
    if (i === -1) state.collected.push(text); else state.collected.splice(i, 1);
    saveCollected();
    renderCard();
  }

  function copyText(btn, text) {
    try {
      navigator.clipboard.writeText(text).then(function () {
        var was = btn.textContent;
        btn.textContent = msg("ogCopied");
        setTimeout(function () { btn.textContent = was; }, 1500);
      });
    } catch { /* clipboard blocked */ }
  }

  function renderLists(card) {
    var ex = state.extras || { paa: [], related: [] };
    var collected = state.collected || [];
    var tabsDef = [["related", "serpRelated", ex.related], ["paa", "serpPaa", ex.paa], ["mine", "serpCollected", collected]]
      .filter(function (t) { return t[0] === "mine" || t[2].length; });
    if (tabsDef.length === 1 && !collected.length) return; // nothing on this page, nothing saved
    if (!tabsDef.some(function (t) { return t[0] === state.cardTab; })) state.cardTab = tabsDef[0][0];

    var tabs = d("div", "tabs");
    tabsDef.forEach(function (t) {
      var label = msg(t[1]) + (t[0] === "mine" ? " (" + collected.length + ")" : "");
      var b = d("button", "t" + (state.cardTab === t[0] ? " on" : ""), label);
      b.type = "button";
      b.addEventListener("click", function () { state.cardTab = t[0]; renderCard(); });
      tabs.appendChild(b);
    });
    card.appendChild(tabs);

    var list = state.cardTab === "paa" ? ex.paa : state.cardTab === "mine" ? collected : ex.related;
    var bar = d("div", "lbar");
    if (state.cardTab === "mine") {
      if (list.length) {
        var copy = d("button", "link", msg("serpCopy"));
        copy.type = "button";
        copy.addEventListener("click", function () { copyText(copy, list.join("\n")); });
        bar.appendChild(copy);
        var clear = d("button", "link", msg("serpClear"));
        clear.type = "button";
        clear.addEventListener("click", function () { state.collected = []; saveCollected(); renderCard(); });
        bar.appendChild(clear);
      }
    } else {
      var all = d("button", "link", msg("serpCollectAll"));
      all.type = "button";
      all.addEventListener("click", function () {
        list.forEach(function (t) { if (!isCollected(t)) state.collected.push(t); });
        saveCollected();
        renderCard();
      });
      bar.appendChild(all);
      var copyAll = d("button", "link", msg("serpCopy"));
      copyAll.type = "button";
      copyAll.addEventListener("click", function () { copyText(copyAll, list.join("\n")); });
      bar.appendChild(copyAll);
    }
    if (bar.childNodes.length) card.appendChild(bar);

    var ul = d("ul", "list");
    if (!list.length) ul.appendChild(d("li", "muted", msg("serpListEmpty")));
    list.forEach(function (text) {
      var li = d("li");
      var on = isCollected(text);
      var plus = d("button", "plus" + (on ? " on" : ""), state.cardTab === "mine" ? "×" : on ? "✓" : "+");
      plus.type = "button";
      plus.title = msg("serpCollectAdd");
      plus.addEventListener("click", function () { toggleCollected(text); });
      if (state.cardTab === "paa") {
        li.appendChild(d("span", "txt", text));
      } else {
        var a = d("a", "txt", text);
        var u = new URL(window.location.href);
        u.searchParams.set(state.parsed.engine === "yandex" ? "text" : "q", text);
        u.searchParams.delete("start"); u.searchParams.delete("first"); u.searchParams.delete("p");
        a.href = u.href;
        li.appendChild(a);
      }
      li.appendChild(plus);
      ul.appendChild(li);
    });
    card.appendChild(ul);
  }

  // ─── free age + DR, automatically ─────────────────────────────────────────────

  var ENRICH_TRIED_KEY = "serpEnrichTried2"; // v1 marks were written while DR was never fetched
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

      state.enriching = true;
      redrawRows();
      renderCard();
      var chain = Promise.resolve();
      for (var i = 0; i < hosts.length; i += 20) {
        (function (batch) {
          chain = chain.then(function () {
            return extApi("POST", "/api/ext/hosts/enrich", { hosts: batch }).then(function (res) {
              var ok = res && res.status === 200 && res.data && !res.data.error;
              if (!ok) return; // a failed call marks nothing — the next search asks again
              if (res.data.drKey === false) state.noDrKey = true;
              // a host is "tried" only once the server really looked at it with a DR key
              if (res.data.drKey !== false) batch.forEach(function (h) { tried[h] = now; });
            });
          });
        })(hosts.slice(i, i + 20));
      }
      chain.then(function () {
        var set = {}; set[ENRICH_TRIED_KEY] = tried;
        CR.storage.local.set(set);
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

  function cardPart(cls) {
    var headEl = state.card && state.card.layer;
    return headEl ? headEl.querySelector("." + cls) : null;
  }

  /** A small labelled panel under the action row: title, full-width select, Add / Cancel. */
  function openPicker(title, options, onPick) {
    var place = cardPart("picker");
    if (!place) return;
    place.textContent = "";
    var box = d("div", "pick");
    box.appendChild(d("div", "pt", title));
    var sel = document.createElement("select");
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    box.appendChild(sel);
    var row = d("div", "pr");
    var ok = d("button", "primary", msg("serpAddBtn"));
    ok.type = "button";
    ok.addEventListener("click", function () { place.textContent = ""; onPick(sel.value); });
    var no = d("button", null, msg("serpCancel"));
    no.type = "button";
    no.addEventListener("click", function () { place.textContent = ""; });
    row.appendChild(ok);
    row.appendChild(no);
    box.appendChild(row);
    place.appendChild(box);
    sel.focus();
  }

  function pickSiteAndTrack(meta) {
    var ownSite = Object.keys(state.intelByHost).map(function (h) { return state.intelByHost[h]; })
      .find(function (i) { return i && i.own; });
    var siteId = ownSite ? ownSite.own.siteId : state.settings.defaultSiteId;
    if (siteId) {
      trackKeyword(meta, siteId);
      return;
    }
    extApi("GET", "/api/ext/lists").then(function (res) {
      if (res.status !== 200 || !res.data || !res.data.sites || !res.data.sites.length) {
        alertBox(msg("serpPickSite"));
        return;
      }
      openPicker(msg("serpPickSite"),
        res.data.sites.slice(0, 300).map(function (s) { return { value: s.id, label: s.label }; }),
        function (id) { trackKeyword(meta, id); });
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
      if (!projects.length) projects = res.data.projects;
      if (projects.length === 1) { addKeyword(meta, projects[0].id); return; }
      openPicker(msg("serpPickProject"),
        projects.slice(0, 200).map(function (p) { return { value: p.id, label: p.name + " · " + p.country + "/" + p.lang }; }),
        function (id) { addKeyword(meta, id); });
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
    var place = cardPart("status");
    if (!place) return;
    place.textContent = text;
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(function () { place.textContent = ""; }, 6000);
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
      if (!s.serpOverlay) return; // switched off in the options
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
          loadCollected(function () {
            drawHeader();
            drawRows();
            watchScroll();
            if (state.settings.serpAutoEnrich) runEnrich(false);
          });
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
