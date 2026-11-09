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
    headerDrawn: false,
    requestedHosts: {},    // hosts already asked for (infinite scroll dedupe)
    perf: { parseMs: 0, renderMs: 0 },
  };

  function msg(key, subs) {
    try { return CR.i18n.getMessage(key, subs) || key; } catch { return key; }
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
    "@media (prefers-color-scheme:dark){",
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
      if (intel.dr != null) row.appendChild(d("span", null, "DR " + intel.dr));
      else {
        var drChip = d("span", null, "DR —");
        drChip.title = msg("serpDrUnknown");
        row.appendChild(drChip);
      }
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
      var intel = state.intelByHost[result.host] || null;
      var host2 = shadowHost("opengsc-serp-row");
      host2.el.style.display = "block";
      host2.layer.appendChild(chipRow(intel, result));
      // after the heading block, before the snippet: the anchor's closest container
      var anchorParent = block.querySelector("a[href] h3, a[href] [role='heading']");
      var container = anchorParent ? anchorParent.closest("div") || block : block;
      container.parentNode && container.parentNode.insertBefore(host2.el, container.nextSibling);
    });
    state.perf.renderMs = Math.round(performance.now() - t0);
  }

  // ─── the header ────────────────────────────────────────────────────────────────

  function drawHeader() {
    if (state.headerDrawn || !state.parsed || !state.hostsData) return;
    state.headerDrawn = true;
    var meta = state.parsed.meta;
    var q = state.hostsData.query;
    var missing = state.hostsData.missing || { age: 0, dr: 0 };

    var host = shadowHost("opengsc-serp-head", document.getElementById("rso") || document.getElementById("search"));
    if (host.el.nextSibling) host.el.parentNode.insertBefore(host.el, host.el.nextSibling); // insert before the results

    var head = d("div", "head");
    head.appendChild(d("span", "q", meta.query || ""));
    var region = meta.country || meta.lang
      ? (meta.country.toUpperCase() + (meta.lang ? "/" + meta.lang : ""))
      : msg("serpRegionUnknown");
    head.appendChild(d("span", "muted", region));

    if (state.notConfigured) {
      head.appendChild(d("span", "warn", msg("serpNotConfigured")));
      host.layer.appendChild(head);
      return;
    }

    if (q) {
      var own = d("span", null, msg("serpYourPositions") + ": ");
      if ((q.own || []).length) {
        q.own.forEach(function (o) {
          own.appendChild(d("b", null, o.label + " "));
          own.appendChild(document.createTextNode(msg("serpYourUrlStats", [String(o.clicks), String(o.impressions), String(o.position)]) + "; "));
        });
      } else {
        own.appendChild(document.createTextNode("—"));
      }
      head.appendChild(own);
      (q.tracked || []).forEach(function (t) {
        head.appendChild(d("span", null, t.label + ": " + msg("serpTracked", [
          t.lastPosition == null ? "—" : String(t.lastPosition),
          t.lastCheckedAt ? t.lastCheckedAt.slice(0, 10) : "—",
        ])));
      });
      (q.serpmon || []).forEach(function (sm) {
        head.appendChild(d("span", null, msg("serpMonitored", [sm.projectName]) + " · " + (sm.lastRunStorm ? "⚠ " + msg("serpStorm") : msg("serpNoStorm"))));
      });
      if (q.metrics && (q.metrics.volume != null || q.metrics.difficulty != null)) {
        head.appendChild(d("span", "muted", msg("serpQueryMetrics", [
          q.metrics.volume == null ? "—" : String(q.metrics.volume),
          q.metrics.difficulty == null ? "—" : String(q.metrics.difficulty),
          q.metrics.checkedAt ? q.metrics.checkedAt.slice(0, 10) : "—",
        ])));
      }
    }

    // actions
    var toRank = d("button", null, msg("serpToRank"));
    toRank.type = "button";
    toRank.addEventListener("click", function () { pickSiteAndTrack(meta); });
    head.appendChild(toRank);

    var toMon = d("button", null, msg("serpToMonitor"));
    toMon.type = "button";
    toMon.addEventListener("click", function () { pickProjectAndAdd(meta); });
    head.appendChild(toMon);

    var save = d("button", null, msg("serpCapture"));
    save.type = "button";
    save.addEventListener("click", function () { saveCapture(save, meta); });
    head.appendChild(save);

    if (missing.age + missing.dr > 0) {
      var enrich = d("button", null, msg("serpEnrich", [String(missing.age + missing.dr)]));
      enrich.type = "button";
      enrich.addEventListener("click", function () {
        enrich.disabled = true;
        var hosts = Object.keys(state.intelByHost).filter(function (h) {
          var i = state.intelByHost[h];
          return i && (i.dr == null || i.ageMonths == null);
        }).slice(0, 20);
        var chain = Promise.resolve();
        for (var i = 0; i < hosts.length; i += 20) {
          (function (batch) {
            chain = chain.then(function () { return extApi("POST", "/api/ext/hosts/enrich", { hosts: batch }); });
          })(hosts.slice(i, i + 20));
        }
        chain.then(function () {
          CR.runtime.sendMessage({ type: ExtProtocol.MSG_SERP_INVALIDATE, query: meta.query }, function () {
            void CR.runtime.lastError;
            window.location.reload();
          });
        });
      });
      head.appendChild(enrich);
    }

    host.layer.appendChild(head);
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
        return { position: r.position, url: r.url, title: r.title, snippet: r.snippet };
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
      var place = headEl && headEl.shadowRoot && headEl.shadowRoot.querySelector(".head");
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
      var place = headEl && headEl.shadowRoot && headEl.shadowRoot.querySelector(".head");
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
    var place = headEl && headEl.shadowRoot && headEl.shadowRoot.querySelector(".head");
    if (place) {
      var note = d("span", "muted", text);
      place.appendChild(note);
      setTimeout(function () { note.remove(); }, 6000);
    }
  }

  // ─── boot ──────────────────────────────────────────────────────────────────────

  function boot() {
    if (document.visibilityState === "hidden") {
      document.addEventListener("visibilitychange", function onVis() {
        document.removeEventListener("visibilitychange", onVis);
        boot();
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

    getSettings().then(function (s) {
      state.settings = s;
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
        var done = function () { drawRows(); };
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
