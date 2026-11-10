// OpenGSC extension — panel tab "Page" (wave-ext E1): the local page breakdown, everything
// SEO META in 1 CLICK shows plus what it doesn't do (CWV, score, highlight, exports). Eight
// sub-tabs; all data comes from ctx.scan (the PageScan of CONTRACT §4.3), nothing is fetched
// from the server here — except the robots.txt/sitemap reads of the robots tab, which go from
// the panel (an extension page) straight to the site origin.

(function () {
  "use strict";

  var SUB = [
    { id: "overview", key: "pageOverview" },
    { id: "headings", key: "pageHeadings" },
    { id: "links", key: "pageLinks" },
    { id: "images", key: "pageImages" },
    { id: "schema", key: "pageSchema" },
    { id: "social", key: "pageSocial" },
    { id: "robots", key: "pageRobots" },
    { id: "speed", key: "pageSpeed" },
  ];

  // issue id → the group the overview lists it under (N11 ids by meaning, new ids by the brief)
  var GROUPS = [
    { id: "meta", key: "pageGroupMeta", ids: ["title_missing", "title_short", "title_long", "description_missing", "description_short", "description_long", "canonical_missing", "canonical_other", "og_missing", "og_incomplete", "robots_noindex"] },
    { id: "content", key: "pageGroupContent", ids: ["h1_missing", "h1_multiple", "heading_skip", "heading_empty"] },
    { id: "technical", key: "pageGroupTechnical", ids: ["jsonld_missing", "jsonld_invalid", "viewport_missing", "mixed_content"] },
    { id: "performance", key: "pageGroupPerformance", ids: ["lcp_poor", "cls_poor", "images_no_dims"] },
    { id: "accessibility", key: "pageGroupAccessibility", ids: ["images_no_alt", "html_lang_missing", "link_empty_text"] },
  ];

  var ui = { sub: "overview", linkFilter: "all", linkArea: "all", linkSearch: "", imgFilter: "all" };

  function tag(name, className, text) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtNum(n) {
    return typeof n === "number" ? n.toLocaleString() : String(n == null ? "" : n);
  }

  // ─── error / loading screens ───────────────────────────────────────────────────

  function screenNoScan(root, ctx) {
    if (ctx.scanError === "restricted_page") {
      root.appendChild(tag("div", "block-msg", ctx.msg("panelRestricted")));
      return;
    }
    if (ctx.scanError === "no_permission") {
      root.appendChild(tag("div", "block-msg", ctx.msg("panelNoPermission")));
      var hint = tag("div", "muted small", ctx.msg("panelClickIcon"));
      root.appendChild(hint);
      var allow = tag("button", "btn", ctx.msg("panelAllowAll"));
      allow.type = "button";
      allow.addEventListener("click", function () {
        ExtSettings.requestAllSites().then(function (granted) {
          if (granted) ctx.refresh();
        });
      });
      root.appendChild(allow);
      return;
    }
    if (ctx.scanError === "injection_failed") {
      root.appendChild(tag("div", "block-msg", ctx.msg("panelInjectFailed", [ctx.scanErrorText || ""])));
      return;
    }
    root.appendChild(tag("div", "block-msg muted", "…"));
  }

  // ─── shared bits ───────────────────────────────────────────────────────────────

  /** A length bar: the band position of `value` inside the audit band, ok/short/long colours. */
  var CTX = null; // set in render(); the closures read it
  function ctxMsg(key, subs) {
    return CTX ? CTX.msg(key, subs) : key;
  }

  function kv(k, v) {
    var row = tag("div", "kv");
    row.appendChild(tag("span", "k", k));
    row.appendChild(tag("span", "v", v));
    return row;
  }

  function openUrl(url) {
    window.open(url, "_blank", "noopener");
  }

  // ─── overview ──────────────────────────────────────────────────────────────────

  function renderOverview(root, ctx) {
    var scan = ctx.scan;
    var f = scan.facts;
    var d = f.detail || {};
    var score = ExtensionAudit.pageScore(scan.issues);

    var scoreRow = tag("div", "score-row");
    var scoreBox = tag("span", "score", String(score));
    scoreBox.title = ctxMsg("panelScoreFormula") + " · " + ctxMsg("panelScore");
    scoreRow.appendChild(scoreBox);
    scoreRow.appendChild(tag("span", "muted small", ctxMsg("panelScore")));
    root.appendChild(scoreRow);

    root.appendChild(lenBar2("Title", f.titleLength, ExtensionAudit.META_LIMITS.title));
    root.appendChild(lenBar2("Description", f.descriptionLength, ExtensionAudit.META_LIMITS.description));

    var urlRow = kv("URL", f.url || ctx.url);
    root.appendChild(urlRow);
    if (d.canonical) {
      var same = canonicalSame(d.canonical, f.url);
      var cRow = kv("canonical", d.canonical);
      if (!same) cRow.appendChild(tag("span", "warn-inline", ctxMsg("pageCanonicalOther")));
      root.appendChild(cRow);
    }
    root.appendChild(kv("robots", d.robotsMeta || "—"));
    if (f.noindex) root.appendChild(tag("div", "warn-inline", ctxMsg("audit_robots_noindex")));
    root.appendChild(kv("lang", d.lang || "—"));
    root.appendChild(kv("viewport", d.viewport || "—"));
    root.appendChild(kv(ctxMsg("factWords"), fmtNum(d.counts ? d.counts.words : f.words)));

    // issues by group
    var byId = {};
    scan.issues.forEach(function (i) { byId[i.id] = i; });
    GROUPS.forEach(function (grp) {
      var mine = grp.ids.filter(function (id) { return byId[id]; }).map(function (id) { return byId[id]; });
      if (!mine.length) return;
      var section = tag("div", "group");
      var head = tag("div", "group-head");
      head.appendChild(tag("span", null, ctxMsg(grp.key)));
      head.appendChild(tag("span", "pill warn", String(mine.length)));
      section.appendChild(head);
      var ul = tag("ul", "issues");
      mine.forEach(function (issue) {
        var li = tag("li", "sev-" + issue.severity);
        li.textContent = ctxMsg("audit_" + issue.id) + (issue.detail ? " · " + issue.detail : "");
        ul.appendChild(li);
      });
      section.appendChild(ul);
      root.appendChild(section);
    });
    if (!scan.issues.length) {
      root.appendChild(tag("div", "ok-inline", ctxMsg("auditAllOk")));
    }
  }

  function lenBar2(label, value, limits) {
    var wrap = tag("div", "lenbar");
    var head = tag("div", "lenbar-head");
    head.appendChild(tag("span", "len-label", label));
    var state = value === 0 ? "empty" : value < limits.auditMin ? "short" : value > limits.auditMax ? "long" : "ok";
    var verdict = state === "ok" ? ctxMsg("pageLenOk") : state === "short" ? ctxMsg("pageLenShort") : state === "long" ? ctxMsg("pageLenLong") : "—";
    head.appendChild(tag("span", "len-num", String(value)));
    head.appendChild(tag("span", "len-" + state, verdict));
    wrap.appendChild(head);
    var bar = tag("div", "bar");
    var fill = tag("div", "bar-fill " + state);
    fill.style.width = Math.min(100, (value / limits.auditMax) * 100) + "%";
    bar.appendChild(fill);
    wrap.appendChild(bar);
    return wrap;
  }

  function canonicalSame(canonical, url) {
    var norm = function (u) {
      var s = String(u || "").split("#")[0];
      if (s.length > 0 && s.split("/").length > 3 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
      return s.toLowerCase();
    };
    return norm(canonical) === norm(url);
  }

  // ─── headings ──────────────────────────────────────────────────────────────────

  function renderHeadings(root, ctx) {
    var d = ctx.scan.facts.detail || {};
    var list = d.headings || [];
    if (d.truncated && d.truncated.headings) {
      root.appendChild(tag("div", "muted small", ctxMsg("panelTruncated", [String(list.length)])));
    }
    var h1s = list.filter(function (h) { return h.level === 1 && !h.hidden; });
    if (!h1s.length) root.appendChild(tag("div", "warn-inline", ctxMsg("audit_h1_missing")));
    else if (h1s.length > 1) root.appendChild(tag("div", "warn-inline", ctxMsg("audit_h1_multiple")));

    var ol = tag("div", "htree");
    list.forEach(function (h, i) {
      var row = tag("div", "hrow h" + h.level);
      row.style.paddingLeft = (h.level - 1) * 12 + "px";
      row.appendChild(tag("span", "htag", "H" + h.level));
      var text = tag("span", h.hidden ? "muted" : null, h.text || "—");
      row.appendChild(text);
      if (h.hidden) row.appendChild(tag("span", "note", ctxMsg("pageHidden")));
      row.addEventListener("click", function () {
        scrollToHeading(i, ctx);
      });
      ol.appendChild(row);
    });
    root.appendChild(ol);
  }

  function scrollToHeading(index, ctx) {
    chrome.scripting.executeScript(
      {
        target: { tabId: ctx.tabId },
        func: function (idx) {
          var heads = document.querySelectorAll("h1,h2,h3,h4,h5,h6");
          var el = heads[idx];
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        },
        args: [index],
      },
      function () { void chrome.runtime.lastError; }
    );
  }

  // ─── links ─────────────────────────────────────────────────────────────────────

  function renderLinks(root, ctx) {
    var d = ctx.scan.facts.detail || {};
    var links = d.links || [];
    if (d.truncated && d.truncated.links) {
      root.appendChild(tag("div", "muted small", ctxMsg("panelTruncated", [String(links.length)])));
    }

    var counts = d.counts || {};
    var real = links.filter(function (l) { return !l.kind; });
    var unique = {};
    real.forEach(function (l) { unique[l.href] = 1; });
    var summary = tag("div", "chips");
    summary.appendChild(chip(ctxMsg("pageLinks"), String(links.length)));
    summary.appendChild(chip(ctxMsg("pageLinksInternal"), String(counts.linksInternal || 0)));
    summary.appendChild(chip(ctxMsg("pageLinksExternal"), String(counts.linksExternal || 0)));
    summary.appendChild(chip(ctxMsg("pageLinksUnique"), String(Object.keys(unique).length)));
    summary.appendChild(chip("nofollow", String(counts.linksNofollow || 0)));
    root.appendChild(summary);

    // filters + search
    var bar = tag("div", "filterbar");
    var mode = tag("select");
    [["all", ctxMsg("pageLinks")], ["internal", ctxMsg("pageLinksInternal")], ["external", ctxMsg("pageLinksExternal")], ["nofollow", "nofollow"]].forEach(function (o) {
      var opt = tag("option", null, o[1]);
      opt.value = o[0];
      mode.appendChild(opt);
    });
    mode.value = ui.linkFilter;
    mode.addEventListener("change", function () { ui.linkFilter = mode.value; repaintLinks(); });
    bar.appendChild(mode);

    var areaSel = tag("select");
    [["all", "—"], ["content", ctxMsg("pageAreaContent")], ["nav", ctxMsg("pageAreaNav")], ["header", ctxMsg("pageAreaHeader")], ["footer", ctxMsg("pageAreaFooter")], ["aside", ctxMsg("pageAreaAside")], ["top", ctxMsg("pageAreaTop")], ["other", ctxMsg("pageAreaOther")]].forEach(function (o) {
      var opt = tag("option", null, o[1]);
      opt.value = o[0];
      areaSel.appendChild(opt);
    });
    areaSel.value = ui.linkArea;
    areaSel.addEventListener("change", function () { ui.linkArea = areaSel.value; repaintLinks(); });
    bar.appendChild(areaSel);

    var search = tag("input");
    search.type = "search";
    search.placeholder = ctxMsg("optSerpDomainsSearch");
    search.value = ui.linkSearch;
    search.addEventListener("input", function () { ui.linkSearch = search.value.toLowerCase(); repaintLinks(); });
    bar.appendChild(search);
    root.appendChild(bar);

    var tableBox = tag("div", "table-wrap");
    root.appendChild(tableBox);

    function repaintLinks() {
      tableBox.textContent = "";
      var rows = real.filter(function (l) {
        if (ui.linkFilter === "internal" && !l.internal) return false;
        if (ui.linkFilter === "external" && (l.internal || !/^https?:/i.test(l.href))) return false;
        if (ui.linkFilter === "nofollow" && (l.rel || []).indexOf("nofollow") === -1) return false;
        if (ui.linkArea !== "all" && l.area !== ui.linkArea) return false;
        if (ui.linkSearch && (String(l.text).toLowerCase().indexOf(ui.linkSearch) === -1 && String(l.href).toLowerCase().indexOf(ui.linkSearch) === -1)) return false;
        return true;
      });
      if (!rows.length) { tableBox.appendChild(tag("div", "muted small", "—")); return; }
      var table = tag("table", "tbl");
      var thead = tag("tr");
      [ctxMsg("pageLinks"), "URL", "rel", ""].forEach(function (h) { thead.appendChild(tag("th", null, h)); });
      var head = tag("thead");
      head.appendChild(thead);
      table.appendChild(head);
      var tbody = tag("tbody");
      rows.slice(0, 400).forEach(function (l) {
        var tr = tag("tr");
        var anchorCell = tag("td", "clip", l.text || "—");
        if (!l.text) anchorCell.appendChild(tag("span", "note", ctxMsg("hlEmptyLinks")));
        tr.appendChild(anchorCell);
        var hrefCell = tag("td", "clip mono small");
        var a = tag("a", null, l.href);
        a.href = l.href;
        a.target = "_blank";
        a.rel = "noopener";
        hrefCell.appendChild(a);
        tr.appendChild(hrefCell);
        var relCell = tag("td", "small");
        (l.rel || []).forEach(function (r) { relCell.appendChild(tag("span", "pill", r)); });
        tr.appendChild(relCell);
        tr.appendChild(tag("td", "small muted", ctxMsg("pageArea" + cap(l.area))));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableBox.appendChild(table);
      if (rows.length > 400) tableBox.appendChild(tag("div", "muted small", ctxMsg("panelTruncated", ["400"])));
    }
    repaintLinks();
  }

  function cap(s) {
    s = String(s || "other");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function chip(label, value) {
    var c = tag("span", "chip", label + " " + value);
    return c;
  }

  // ─── images ────────────────────────────────────────────────────────────────────

  function renderImages(root, ctx) {
    var d = ctx.scan.facts.detail || {};
    var images = d.images || [];
    if (d.truncated && d.truncated.images) {
      root.appendChild(tag("div", "muted small", ctxMsg("panelTruncated", [String(images.length)])));
    }

    var noAlt = images.filter(function (i) { return i.alt == null; }).length;
    var emptyAlt = images.filter(function (i) { return i.alt === ""; }).length;
    var noDims = images.filter(function (i) { return !i.hasDims; }).length;
    var lazy = images.filter(function (i) { return i.lazy; }).length;

    var summary = tag("div", "chips");
    summary.appendChild(chip(ctxMsg("pageImages"), String(images.length)));
    summary.appendChild(chip(ctxMsg("pageNoAlt"), String(noAlt)));
    summary.appendChild(chip(ctxMsg("pageEmptyAlt"), String(emptyAlt)));
    summary.appendChild(chip(ctxMsg("pageNoDims"), String(noDims)));
    summary.appendChild(chip("lazy", String(lazy)));
    root.appendChild(summary);

    var bar = tag("div", "filterbar");
    var mode = tag("select");
    [["all", "—"], ["noalt", ctxMsg("pageNoAlt")], ["nodims", ctxMsg("pageNoDims")]].forEach(function (o) {
      var opt = tag("option", null, o[1]);
      opt.value = o[0];
      mode.appendChild(opt);
    });
    mode.value = ui.imgFilter;
    mode.addEventListener("change", function () { ui.imgFilter = mode.value; repaint(); });
    bar.appendChild(mode);
    root.appendChild(bar);

    var box = tag("div", "table-wrap");
    root.appendChild(box);

    function repaint() {
      box.textContent = "";
      var rows = images.filter(function (im) {
        if (ui.imgFilter === "noalt" && im.alt != null) return false;
        if (ui.imgFilter === "nodims" && im.hasDims) return false;
        return true;
      });
      if (!rows.length) { box.appendChild(tag("div", "muted small", "—")); return; }
      var grid = tag("div", "imglist");
      rows.slice(0, 200).forEach(function (im) {
        var row = tag("div", "imgrow");
        var thumb = tag("img", "thumb");
        thumb.src = im.src;
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.onerror = function () { thumb.replaceWith(tag("span", "thumb muted", "—")); };
        row.appendChild(thumb);
        var mid = tag("div", "imgmid");
        mid.appendChild(tag("div", "clip small", im.alt == null ? "∅ alt" : im.alt === "" ? 'alt=""' : im.alt));
        var meta = tag("div", "muted small",
          (im.hasDims ? im.width + "×" + im.height : ctxMsg("pageNoDims")) +
          (im.ext ? " · " + im.ext : "") + (im.lazy ? " · lazy" : ""));
        mid.appendChild(meta);
        row.appendChild(mid);
        row.appendChild(tag("span", "small muted", ctxMsg("pageArea" + cap(im.area))));
        grid.appendChild(row);
      });
      box.appendChild(grid);
      if (rows.length > 200) box.appendChild(tag("div", "muted small", ctxMsg("panelTruncated", ["200"])));
    }
    repaint();
  }

  // ─── schema ────────────────────────────────────────────────────────────────────

  function renderSchema(root, ctx) {
    var d = ctx.scan.facts.detail || {};
    var blocks = d.jsonLd || [];
    if (!blocks.length) root.appendChild(tag("div", "muted", ctxMsg("audit_jsonld_missing")));

    blocks.forEach(function (b) {
      var row = tag("div", "row-line");
      var head = tag("div", "row-head");
      (b.types.length ? b.types : ["?"]).forEach(function (t) {
        head.appendChild(tag("span", "pill " + (b.valid ? "ok" : "bad"), t));
      });
      if (!b.valid) head.appendChild(tag("span", "note", b.error || ctxMsg("audit_jsonld_invalid")));
      row.appendChild(head);
      root.appendChild(row);
    });

    if ((d.microdataTypes || []).length) {
      root.appendChild(tag("div", "group-head", "Microdata"));
      d.microdataTypes.forEach(function (t) {
        root.appendChild(tag("div", "row-line mono small", t));
      });
    }

    var rrt = tag("button", "btn", ctxMsg("pageRichTest"));
    rrt.type = "button";
    rrt.addEventListener("click", function () {
      openUrl("https://search.google.com/test/rich-results?url=" + encodeURIComponent(ctx.url));
    });
    root.appendChild(rrt);
  }

  // ─── social ────────────────────────────────────────────────────────────────────

  function renderSocial(root, ctx) {
    var d = ctx.scan.facts.detail || {};
    var og = d.og || {};
    var tw = d.twitter || {};

    var card = tag("div", "ogcard");
    var img = tag("div", "ogimg");
    if (og["og:image"]) {
      var pic = tag("img");
      pic.src = og["og:image"];
      pic.alt = "";
      pic.onerror = function () { pic.remove(); };
      img.appendChild(pic);
    }
    card.appendChild(img);
    var body = tag("div", "ogbody");
    body.appendChild(tag("div", "ogdomain", hostOf(og["og:url"] || ctx.url)));
    body.appendChild(tag("div", "ogtitle", og["og:title"] || "—"));
    body.appendChild(tag("div", "ogdesc muted small", og["og:description"] || "—"));
    card.appendChild(body);
    root.appendChild(card);

    ["og:title", "og:description", "og:image", "og:url"].forEach(function (req) {
      if (!og[req]) root.appendChild(tag("div", "warn-inline small", req + " —"));
    });

    root.appendChild(tag("div", "group-head", "Open Graph"));
    metaTable(root, og);
    root.appendChild(tag("div", "group-head", "Twitter"));
    metaTable(root, tw);
  }

  function metaTable(root, dict) {
    var keys = Object.keys(dict);
    if (!keys.length) { root.appendChild(tag("div", "muted small", "—")); return; }
    keys.sort().forEach(function (k) {
      var row = tag("div", "row-line");
      row.appendChild(tag("span", "mono small k", k));
      var v = tag("div", "clip small");
      v.textContent = dict[k];
      row.appendChild(v);
      root.appendChild(row);
    });
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return ""; }
  }

  // ─── robots & sitemap ──────────────────────────────────────────────────────────

  var robotsCache = { origin: "", text: null, failed: false, status: 0 };

  /**
   * GET a text file for the robots/sitemap tab. Same-origin files are fetched INSIDE the tab
   * (executeScript): that works whenever the page scan works — activeTab included — with no
   * extra permission. Anything else, or if injection is refused, falls back to a fetch from the
   * panel, which needs a host permission. Resolves { status, text }; status 0 = could not reach
   * it at all (permission / network), never confused with a real 404.
   */
  function fetchText(ctx, url) {
    var direct = function () {
      return fetch(url, { credentials: "omit" })
        .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: r.ok ? t : "" }; }); })
        .catch(function () { return { status: 0, text: "" }; });
    };
    var sameOrigin = false;
    try { sameOrigin = new URL(url).origin === new URL(ctx.url).origin; } catch { /* */ }
    if (!sameOrigin || !ctx.tabId || !chrome.scripting) return direct();
    return new Promise(function (resolve) {
      chrome.scripting.executeScript({
        target: { tabId: ctx.tabId },
        func: function (u) {
          return fetch(u, { credentials: "omit" })
            .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: r.ok ? t.slice(0, 5 * 1024 * 1024) : "" }; }); })
            .catch(function () { return { status: 0, text: "" }; });
        },
        args: [url],
      }, function (results) {
        var res = !chrome.runtime.lastError && results && results[0] && results[0].result;
        if (res && res.status) resolve(res); else direct().then(resolve);
      });
    });
  }

  function renderRobots(root, ctx) {
    var origin = "";
    try { origin = new URL(ctx.url).origin; } catch { /* */ }
    var box = tag("div");
    root.appendChild(box);

    var findBox = tag("div");
    root.appendChild(findBox);

    var load = function () {
      box.textContent = "";
      box.appendChild(tag("div", "muted small", "…"));
      fetchText(ctx, origin + "/robots.txt").then(function (res) {
        // 200 → the file; 4xx → "no robots.txt" (Google treats that as allow-all);
        // 0 or 5xx → we could not read it, which is NOT the same as "there is none".
        if (res.status >= 200 && res.status < 300) robotsCache = { origin: origin, text: res.text.slice(0, 50 * 1024), failed: false, status: res.status };
        else if (res.status >= 400 && res.status < 500) robotsCache = { origin: origin, text: "", failed: false, status: res.status };
        else robotsCache = { origin: origin, text: null, failed: true, status: res.status };
        paintRobots();
      });
    };

    var paintRobots = function () {
      box.textContent = "";
      findBox.textContent = "";
      if (robotsCache.failed || robotsCache.text == null) {
        // could not read it (no access to this site, network, 5xx) — say so and offer the fix
        box.appendChild(tag("div", "muted", ctx.msg("panelNoPermission") + (robotsCache.status ? " (HTTP " + robotsCache.status + ")" : "")));
        var allow = tag("button", "btn", ctx.msg("panelAllowAll"));
        allow.type = "button";
        allow.addEventListener("click", function () {
          ExtSettings.requestAllSites().then(function (granted) { if (granted) load(); });
        });
        box.appendChild(allow);
        return;
      }
      if (robotsCache.text === "") {
        // a 4xx robots.txt: there is none, everything is allowed — still let the user check the sitemap
        box.appendChild(tag("div", "ok-inline", ctxMsg("pageRobotsMissing") + " (HTTP " + robotsCache.status + ") — " + ctxMsg("pageRobotsAllowed")));
      }

      var path = "/";
      try { path = new URL(ctx.url).pathname || "/"; } catch { /* */ }
      var verdict = ExtensionAudit.robotsAllows(robotsCache.text, "Googlebot", path);
      var line = !robotsCache.text ? null : verdict.allowed
        ? tag("div", "ok-inline", ctxMsg("pageRobotsAllowed"))
        : tag("div", "warn-inline", ctxMsg("pageRobotsBlocked", [verdict.rule || ""]));
      if (line) box.appendChild(line);

      if (robotsCache.text) {
        var pre = tag("pre", "mono small robotspre");
        pre.textContent = robotsCache.text;
        box.appendChild(pre);
      }

      // sitemaps from robots.txt + the default /sitemap.xml
      var sitemaps = [];
      robotsCache.text.split(/\r?\n/).forEach(function (line2) {
        var m = line2.match(/^\s*sitemap\s*:\s*(\S+)/i);
        if (m) sitemaps.push(m[1]);
      });
      if (sitemaps.indexOf(origin + "/sitemap.xml") === -1) sitemaps.push(origin + "/sitemap.xml");

      var findBtn = tag("button", "btn", ctxMsg("pageSitemapFind"));
      findBtn.type = "button";
      findBtn.addEventListener("click", function () { findInSitemaps(sitemaps, ctx.url, findBox, ctx); });
      findBox.appendChild(findBtn);
    };

    if (robotsCache.origin === origin) paintRobots();
    else load();
  }

  function findInSitemaps(sitemaps, url, box, ctx) {
    box.textContent = "";
    box.appendChild(tag("div", "muted small", "…"));
    var target = String(url || "").split("#")[0];
    var files = 0;
    var found = null;

    var checkOne = function (index) {
      if (found || index >= sitemaps.length || index > 20) {
        box.textContent = "";
        if (found) box.appendChild(tag("div", "ok-inline", ctxMsg("pageSitemapFound", [found])));
        else box.appendChild(tag("div", "muted", ctxMsg("pageSitemapNotFound", [String(files)])));
        return;
      }
      files++;
      fetchText(ctx, sitemaps[index])
        .then(function (res) { return res.status >= 200 && res.status < 300 ? res.text : ""; })
        .then(function (xml) {
          if (!xml || xml.length > 5 * 1024 * 1024) return checkOne(index + 1);
          if (xml.indexOf(target) !== -1) { found = sitemaps[index]; return checkOne(index); }
          // a sitemap index: one level down, ≤ 20 children
          var children = [];
          var re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
          var m;
          while ((m = re.exec(xml)) && children.length < 20) children.push(m[1]);
          var isIndex = /<sitemapindex/i.test(xml);
          if (isIndex && children.length) {
            sitemaps = sitemaps.concat(children);
          }
          checkOne(index + 1);
        })
        .catch(function () { checkOne(index + 1); });
    };
    checkOne(0);
  }

  // ─── speed ─────────────────────────────────────────────────────────────────────

  var THRESHOLDS = {
    lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], cls: [0.1, 0.25],
  };

  function renderSpeed(root, ctx) {
    var v = ctx.scan && ctx.scan.vitals;
    if (!v) {
      root.appendChild(tag("div", "muted", ctxMsg("auditUnavailable")));
    } else {
      var metric = function (name, value, unit, limits) {
        var row = tag("div", "row-line");
        row.appendChild(tag("span", "k", name));
        var state = value == null ? "na" : value <= limits[0] ? "ok" : value <= limits[1] ? "warnv" : "bad";
        row.appendChild(tag("span", "v " + state, value == null ? "—" : String(value) + (unit || "")));
        root.appendChild(row);
      };
      metric("LCP", v.lcp, " ms", THRESHOLDS.lcp);
      metric("FCP", v.fcp, " ms", THRESHOLDS.fcp);
      metric("TTFB", v.ttfb, " ms", THRESHOLDS.ttfb);
      metric("CLS", v.cls, "", THRESHOLDS.cls);
      metric("INP", null, "", THRESHOLDS.cls);
      root.appendChild(tag("div", "muted small", ctxMsg("pageInpNote")));
      metric("DOM", v.domNodes, "", [0, 1500]);
      metric("KB", v.transferKb, "", [0, 1000]);
    }
    root.appendChild(tag("div", "muted small", ctxMsg("pageLabNote")));

    var psi = tag("button", "btn", ctxMsg("pagePsi"));
    psi.type = "button";
    psi.addEventListener("click", function () {
      openUrl("https://pagespeed.web.dev/analysis?url=" + encodeURIComponent(ctx.url));
    });
    root.appendChild(psi);
  }

  // ─── the tab ───────────────────────────────────────────────────────────────────

  var SUB_RENDER = {
    overview: renderOverview,
    headings: renderHeadings,
    links: renderLinks,
    images: renderImages,
    schema: renderSchema,
    social: renderSocial,
    robots: renderRobots,
    speed: renderSpeed,
  };

  function render(root, ctx) {
    CTX = ctx;
    root.textContent = "";

    if (!ctx.scan) {
      screenNoScan(root, ctx);
      return;
    }

    var sub = tag("div", "subtabs");
    SUB.forEach(function (s) {
      var b = tag("button", ui.sub === s.id ? "active" : "");
      b.textContent = ctx.msg(s.key);
      b.addEventListener("click", function () {
        ui.sub = s.id;
        render(root, ctx);
      });
      sub.appendChild(b);
    });
    root.appendChild(sub);

    var pane = tag("div", "subpane");
    root.appendChild(pane);
    SUB_RENDER[ui.sub](pane, ctx);
  }

  Panel.register({
    id: "page",
    labelKey: "tabPage",
    order: 10,
    applies: function () { return true; },
    render: render,
  });
})();
