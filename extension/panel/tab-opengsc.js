// OpenGSC extension — panel tab "OpenGSC" (wave-ext E2): what no third-party extension can
// show — the page's own GSC data. Everything GSC/index/audit/ranks comes from ctx.summary
// (GET /api/ext/page, already fetched by core); the main-query verdict, sitemap membership,
// meta suggestion and footprint come from ONE POST /api/ext/insights call, cached 5 minutes
// per URL+title in the session cache.

(function () {
  "use strict";

  var INSIGHTS_TTL = 5 * 60 * 1000;

  function tag(name, className, text) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtNum(n) {
    return typeof n === "number" ? n.toLocaleString() : "—";
  }

  function fmtPos(p) {
    return typeof p === "number" ? p.toFixed(1) : "—";
  }

  function sectionHead(root, ctx, key) {
    root.appendChild(tag("div", "group-head", ctx.msg(key)));
  }

  /** One POST /api/ext/insights per render, cached 5 min by url+title. */
  function loadInsights(ctx) {
    var facts = ctx.scan && ctx.scan.facts;
    var key = "insights:" + ctx.url + ":" + (facts ? facts.title : "");
    return ctx.cache.get(key).then(function (cached) {
      if (cached) return cached;
      return ctx.api.insights({
        url: ctx.url,
        title: (facts && facts.title) || "",
        description: (facts && facts.description) || "",
        h1: (facts && facts.h1Text) || "",
      }).then(function (res) {
        if (res.status === 200 && res.data && !res.data.error) {
          void ctx.cache.set(key, res.data, INSIGHTS_TTL);
          return res.data;
        }
        return null;
      }).catch(function () { return null; });
    });
  }

  function baseUrl(ctx) {
    return ctx.api.getSettings().then(function (s) { return s.baseUrl || ""; });
  }

  // ─── pieces ────────────────────────────────────────────────────────────────────

  function renderGsc(root, ctx, summary) {
    sectionHead(root, ctx, "ogGsc28");
    var m = summary.metrics;
    var row = tag("div", "chips");
    row.appendChild(chip(ctx.msg("metricClicks"), fmtNum(m && m.clicks)));
    row.appendChild(chip(ctx.msg("metricImpressions"), fmtNum(m && m.impressions)));
    row.appendChild(chip(ctx.msg("metricPosition"), fmtPos(m && m.avgPosition)));
    root.appendChild(row);
    (summary.topQueries || []).slice(0, 5).forEach(function (q) {
      var line = tag("div", "row-line");
      line.appendChild(tag("span", "clip", q.query));
      line.appendChild(tag("span", "muted small", fmtNum(q.clicks) + " · " + ctx.msg("posShort") + " " + fmtPos(q.position)));
      root.appendChild(line);
    });
  }

  function chip(label, value) {
    return tag("span", "chip", label + " " + value);
  }

  function renderMainQuery(root, ctx, insights) {
    sectionHead(root, ctx, "ogMainQuery");
    if (!insights || !insights.mainQuery) {
      root.appendChild(tag("div", "muted small", ctx.msg("ogNoMainQuery")));
      return;
    }
    var q = insights.mainQuery;
    root.appendChild(tag("div", "row-line", q.query + " · " + fmtNum(q.clicks) + " " + ctx.msg("metricClicks").toLowerCase()));
    if (insights.titleMatchesMainQuery === true) {
      root.appendChild(tag("div", "ok-inline", "✓ " + ctx.msg("ogMatchOk")));
    } else if (insights.titleMatchesMainQuery === false) {
      root.appendChild(tag("div", "warn-inline", ctx.msg("ogMatchBad")));
    }
  }

  function renderIndex(root, ctx, summary, insights) {
    sectionHead(root, ctx, "indexStatus");
    var idx = summary.index;
    if (idx) {
      var verdict = idx.indexed === true ? ctx.msg("indexIndexed")
        : idx.indexed === false ? ctx.msg("indexNotIndexed") : ctx.msg("indexUnknown");
      var line = tag("div", "row-line", verdict);
      if (idx.indexed == null) line.title = ctx.msg("indexUnknownTitle");
      root.appendChild(line);
    }
    if (insights && insights.inSitemap != null) {
      var sitemapRow = tag("div", "row-line");
      sitemapRow.appendChild(tag("span", "muted", ctx.msg("ogInSitemap") + ":"));
      sitemapRow.appendChild(tag("span", insights.inSitemap ? "ok-inline" : "warn-inline",
        insights.inSitemap ? ctx.msg("ogSitemapYes") : ctx.msg("ogSitemapNo")));
      root.appendChild(sitemapRow);
    } else if (insights) {
      root.appendChild(tag("div", "muted small", ctx.msg("ogInSitemap") + ": " + ctx.msg("ogSitemapUnknown")));
    }

    var btn = tag("button", "btn", ctx.msg("ogCheckIndex"));
    btn.type = "button";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: ExtProtocol.MSG_SEND, url: ctx.url }, function () {
        void chrome.runtime.lastError;
        btn.disabled = false;
      });
    });
    root.appendChild(btn);
  }

  function metaBlock(root, ctx, which, current, suggestion) {
    var limits = ExtensionAudit.META_LIMITS[which];
    var len = ExtensionAudit.metaLength(current);
    var box = tag("div", "lenbar");
    var head = tag("div", "lenbar-head");
    head.appendChild(tag("span", "len-label", which === "title" ? "Title" : "Description"));
    var state = len === 0 ? "empty" : len < limits.auditMin ? "short" : len > limits.auditMax ? "long" : "ok";
    head.appendChild(tag("span", "len-num", String(len)));
    head.appendChild(tag("span", "len-" + state, state === "ok" ? ctx.msg("pageLenOk") : state === "short" ? ctx.msg("pageLenShort") : state === "long" ? ctx.msg("pageLenLong") : "—"));
    box.appendChild(head);
    var bar = tag("div", "bar");
    var fill = tag("div", "bar-fill " + state);
    fill.style.width = Math.min(100, (len / limits.auditMax) * 100) + "%";
    bar.appendChild(fill);
    box.appendChild(bar);
    root.appendChild(box);

    if (suggestion && suggestion.after) {
      var sRow = tag("div", "row-line");
      sRow.appendChild(tag("span", "muted small", ctx.msg("ogSuggestion", [String(suggestion.length)])));
      var text = tag("div", "clip small");
      text.textContent = suggestion.after;
      text.title = suggestion.after;
      sRow.appendChild(text);
      var copy = tag("button", "btn slim", ctx.msg("ogCopy"));
      copy.type = "button";
      copy.addEventListener("click", function () {
        navigator.clipboard.writeText(suggestion.after).then(function () {
          copy.textContent = ctx.msg("ogCopied");
        });
      });
      sRow.appendChild(copy);
      root.appendChild(sRow);
    }
  }

  function renderMeta(root, ctx, insights, state) {
    sectionHead(root, ctx, "ogMeta");
    var facts = ctx.scan && ctx.scan.facts;
    // The LLM result (state.llm) wins over the free local suggestion when present.
    var pick = function (which) {
      if (state && state.llm && state.llm[which] && state.llm[which].after) return state.llm[which];
      return insights && insights.meta && insights.meta[which] || null;
    };
    metaBlock(root, ctx, "title", (facts && facts.title) || "", pick("title"));
    metaBlock(root, ctx, "description", (facts && facts.description) || "", pick("description"));

    if (!insights || !insights.mainQuery) {
      root.appendChild(tag("div", "muted small", ctx.msg("ogNoMainQueryFit")));
      return;
    }

    var ai = tag("button", "btn", ctx.msg("ogFitAi"));
    ai.type = "button";
    ai.addEventListener("click", function () {
      if (!window.confirm(ctx.msg("ogFitAiConfirm"))) return;
      ai.disabled = true;
      ctx.api.metaFit({
        url: ctx.url,
        title: (facts && facts.title) || "",
        description: (facts && facts.description) || "",
        language: (ctx.scan && ctx.scan.facts && ctx.scan.facts.detail && ctx.scan.facts.detail.lang) || "",
        allowLlm: true,
        confirm: true,
      }).then(function (res) {
        ai.disabled = false;
        if (res.status === 403) {
          aiState.note = ctx.msg("ogNoSpendRight");
          paint(aiState.root, ctx); // repaint to surface the note
          return;
        }
        if (res.status === 400 && res.data && res.data.error === "no_main_query") {
          aiState.note = ctx.msg("ogNoMainQueryFit");
          paint(aiState.root, ctx);
          return;
        }
        if (res.status === 200 && res.data && !res.data.error) {
          aiState.llm = res.data; // renderMeta prefers the LLM suggestion over the free one
          paint(aiState.root, ctx);
        }
      });
    });
    root.appendChild(ai);
    if (aiState.note) root.appendChild(tag("div", "warn-inline small", aiState.note));
  }

  function renderFootprint(root, ctx, insights, base) {
    sectionHead(root, ctx, "ogFootprint");
    var hits = (insights && insights.footprint) || [];
    if (!hits.length) {
      root.appendChild(tag("div", "ok-inline", "✓ " + ctx.msg("ogFootprintClean")));
    } else {
      hits.forEach(function (hit) {
        var kindKey = hit.kind === "title" ? "ogFootprintKindTitle" : hit.kind === "description" ? "ogFootprintKindDescription" : "ogFootprintKindH1";
        root.appendChild(tag("div", "row-line", ctx.msg(kindKey)));
        root.appendChild(tag("div", "mono small muted", hit.skeleton));
        hit.matches.forEach(function (m) {
          var line = tag("div", "row-line");
          var a = tag("a", null, m.siteLabel);
          if (m.url && /^https?:/.test(m.url)) { a.href = m.url; a.target = "_blank"; a.rel = "noopener"; }
          line.appendChild(a);
          line.appendChild(tag("span", "muted small", ctx.msg("ogSimilarity", [String(Math.round(m.similarity * 100))])));
          root.appendChild(line);
        });
      });
    }
    if (base) {
      var all = tag("a", "link", ctx.msg("ogFootprintAll") + " →");
      all.href = base + "/footprint";
      all.target = "_blank";
      all.rel = "noopener";
      root.appendChild(all);
    }
  }

  function renderRanks(root, ctx, summary) {
    var ranks = summary.ranks || [];
    if (!ranks.length) return;
    sectionHead(root, ctx, "ogRanks");
    ranks.slice(0, 10).forEach(function (r) {
      var line = tag("div", "row-line");
      line.appendChild(tag("span", "clip", r.keyword));
      var pos = r.position == null ? "—" : String(r.position);
      if (r.localPack) pos += " + " + ctx.msg("localPackShort").trim();
      line.appendChild(tag("span", "small", pos));
      root.appendChild(line);
    });
  }

  function renderAudit(root, ctx, summary) {
    var audit = summary.audit;
    if (!audit || !Array.isArray(audit.issues) || !audit.issues.length) return;
    sectionHead(root, ctx, "ogServerAudit");
    audit.issues.slice(0, 10).forEach(function (issue) {
      var li = tag("div", "row-line small");
      li.textContent = String(issue.code || issue.id || issue.rule || "—") +
        (issue.severity ? " · " + issue.severity : "");
      root.appendChild(li);
    });
  }

  // ─── the tab ───────────────────────────────────────────────────────────────────

  var aiState = { note: "", llm: null, root: null };

  function paint(root, ctx) {
    aiState.root = root;
    root.textContent = "";
    var summary = ctx.summary;
    if (!summary || !summary.inPortfolio) {
      root.appendChild(tag("div", "block-msg", ctx.msg("notInPortfolio")));
      return;
    }
    renderBody(root, ctx);
  }

  function renderBody(root, ctx) {
    var summary = ctx.summary;
    baseUrl(ctx).then(function (base) {
      var link = tag("a", "link", ctx.msg("ogOpenInApp") + " →");
      link.href = base + (summary.site && summary.site.openPath ? summary.site.openPath : "/");
      link.target = "_blank";
      link.rel = "noopener";
      root.appendChild(link);
      if (summary.site) root.appendChild(tag("div", "muted small", summary.site.label + (summary.site.label === summary.site.id ? "" : "")));
    });

    renderGsc(root, ctx, summary);

    var async = tag("div");
    async.appendChild(tag("div", "muted small", "…"));
    root.appendChild(async);

    loadInsights(ctx).then(function (insights) {
      async.textContent = "";
      renderMainQuery(async, ctx, insights);
      renderIndex(async, ctx, summary, insights);
      renderMeta(async, ctx, insights, aiState); // aiState carries the LLM fit once it returns
      renderFootprint(async, ctx, insights);
      renderRanks(root, ctx, summary);
      renderAudit(root, ctx, summary);
    });
  }

  // The registry entry: apply only when the page belongs to the portfolio. The body renders
  // in two passes — the sync GSC part at once, the insights part when the request lands.
  Panel.register({
    id: "opengsc",
    labelKey: "tabOpengsc",
    order: 20,
    applies: function (ctx) { return !!(ctx.summary && ctx.summary.inPortfolio); },
    render: function (root, ctx) {
      aiState = { note: "", llm: null, root: root };
      paint(root, ctx);
    },
  });
})();
