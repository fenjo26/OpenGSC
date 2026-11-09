// OpenGSC extension — panel tab "Donor" (wave-ext E3): for someone else's page, when you are
// deciding whether to buy a link here or take the site into Outreach. The local half (signals,
// outbound table) works without any server; the host half needs ONE POST /api/ext/hosts call
// (page host + up to 99 outbound hosts), cached 10 minutes per URL.

(function () {
  "use strict";

  var HOSTS_TTL = 10 * 60 * 1000;

  var ui = { filter: "all", hostData: null, note: "" };

  function tag(name, className, text) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function chip(label, value) {
    return tag("span", "chip", label + " " + value);
  }

  function yearsMonths(months) {
    if (typeof months !== "number") return "—";
    var y = Math.floor(months / 12);
    var m = months % 12;
    return ctxMsgSafe("donorAgeValue", [String(y), String(m)]);
  }

  var CTX = null;
  function ctxMsgSafe(key, subs) {
    try { return CTX.msg(key, subs); } catch { return key; }
  }

  function hostOfUrl(url) {
    try { return new URL(url).host; } catch { return ""; }
  }

  // ─── the hosts call ────────────────────────────────────────────────────────────

  function loadHosts(ctx, scan) {
    var pageHost = hostOfUrl(ctx.url);
    var uniq = {};
    (scan.donor && scan.donor.outbound || []).forEach(function (l) {
      if (Object.keys(uniq).length < 99) uniq[l.host] = 1;
    });
    var hosts = [pageHost].concat(Object.keys(uniq)).filter(Boolean);
    var key = "donorhosts:" + ctx.url;
    return ctx.cache.get(key).then(function (cached) {
      if (cached) return cached;
      return ctx.api.hosts({ hosts: hosts }).then(function (res) {
        if (res.status === 200 && res.data && res.data.hosts) {
          void ctx.cache.set(key, res.data, HOSTS_TTL);
          return res.data;
        }
        return null;
      }).catch(function () { return null; });
    });
  }

  // ─── blocks ────────────────────────────────────────────────────────────────────

  function hostBlock(root, ctx, scan, data) {
    var pageHost = hostOfUrl(ctx.url);
    var intel = data && data.hosts && data.hosts[0] && data.hosts[0].host === pageHost
      ? data.hosts[0]
      : (data && data.hosts ? data.hosts[0] : null);

    if (!data) {
      // the tab works locally; the host half needs the instance
      root.appendChild(tag("div", "hint-card", ctx.msg("panelConnectHint")));
    } else if (!intel) {
      root.appendChild(tag("div", "muted small", pageHost + " — " + ctx.msg("donorNotInDb")));
    } else {
      // links to OUR sites first — the headline fact
      (intel.linksToUs || []).forEach(function (l) {
        var line = tag("div", "row-line ok-inline");
        line.appendChild(tag("span", null, ctx.msg("donorLinksToUs") + ": "));
        line.appendChild(tag("b", null, ctx.msg("donorLinksToUsRow", [l.label, String(l.links), String(l.live)])));
        root.appendChild(line);
      });

      var factsRow = tag("div", "chips");
      var dr = tag("span", "chip", ctx.msg("donorDr") + " " + (intel.dr == null ? "—" : String(intel.dr)));
      if (intel.dr == null) {
        dr.title = ctx.msg("donorNotInDb");
      } else if (intel.drCheckedAt) {
        dr.title = String(intel.drSource || "") + " · " + intel.drCheckedAt.slice(0, 10);
      }
      factsRow.appendChild(dr);
      factsRow.appendChild(chip(ctx.msg("donorAge"), yearsMonths(intel.ageMonths)));
      var rd = chip(ctx.msg("donorRefdomains"), intel.refdomains == null ? "—" : String(intel.refdomains));
      if (intel.refdomains == null) rd.title = ctx.msg("donorNotInDb");
      factsRow.appendChild(rd);
      if (intel.ownPbn) factsRow.appendChild(chip(ctx.msg("donorOwnPbn"), ""));
      if (intel.asset) factsRow.appendChild(chip(ctx.msg("donorAsset"), ""));
      root.appendChild(factsRow);

      if (intel.outreach) root.appendChild(tag("div", "muted small", ctx.msg("donorInOutreach", [intel.outreach.stage])));
      if (intel.drops) {
        root.appendChild(tag("div", "muted small", ctx.msg("donorInDrops", [intel.drops.stage]) +
          (intel.drops.watched ? " · " + ctx.msg("donorWatched") : "")));
      }
    }

    // actions — always available, they need no hosts data
    var row = tag("div", "row-line");
    var outreach = tag("button", "btn", ctx.msg("donorToOutreach"));
    outreach.type = "button";
    outreach.addEventListener("click", function () {
      outreach.disabled = true;
      ctx.api.outreach(ctx.url, "").then(function (res) {
        outreach.disabled = false;
        ui.note = res.status === 200 && res.data && res.data.ok
          ? (res.data.created ? ctx.msg("sentProspect") : ctx.msg("sentProspectExisting"))
          : ctx.msg("sendFailed");
        paint(ui.root, ctx);
      });
    });
    row.appendChild(outreach);

    if (intel && intel.host) {
      var watch = tag("button", "btn", ctx.msg("donorWatchDrop"));
      watch.type = "button";
      watch.addEventListener("click", function () {
        watch.disabled = true;
        ctx.api.serpAction({ kind: "drops_watch", host: intel.host }).then(function (res) {
          watch.disabled = false;
          ui.note = res.status === 200 && res.data && res.data.ok
            ? ctx.msg("donorWatched") : ctx.msg("sendFailed");
          paint(ui.root, ctx);
        });
      });
      row.appendChild(watch);
    }

    if (data && data.missing && data.missing.age + data.missing.dr > 0 && intel && intel.host) {
      var enrich = tag("button", "btn", ctx.msg("donorEnrich"));
      enrich.type = "button";
      enrich.addEventListener("click", function () {
        enrich.disabled = true;
        ctx.api.enrichHosts([intel.host]).then(function () {
          void ctx.cache.set("donorhosts:" + ctx.url, null, 1); // drop the stub — next paint re-asks
          enrich.disabled = false;
          paint(ui.root, ctx);
        });
      });
      row.appendChild(enrich);
    }
    root.appendChild(row);
  }

  function signalsBlock(root, ctx, scan) {
    sectionHead(root, ctx, "donorSignals");
    var donor = scan.donor;
    if (!donor) {
      root.appendChild(tag("div", "muted small", ctx.msg("donorVerdictUnknown")));
      return;
    }
    var signals = ExtDonor.deriveSignals(donor);
    var v = ExtDonor.verdict(signals, true);
    var key = { restored_drop: "donorVerdictRestored", suspicious: "donorVerdictSuspicious", clean: "donorVerdictClean", unknown: "donorVerdictUnknown" }[v];
    var head = tag("div", v === "clean" || v === "unknown" ? "muted" : "warn-inline", "⚠ " + ctx.msg(key));
    root.appendChild(head);
    signals.forEach(function (s) {
      var line = tag("div", "row-line small");
      line.appendChild(tag("span", s.severity === "hard" ? "bad" : "warnv", "●"));
      line.appendChild(tag("span", null, ctx.msg("donorSig_" + s.id)));
      line.appendChild(tag("span", "muted", s.evidence));
      root.appendChild(line);
    });

    var hl = tag("button", "btn", ctx.msg("donorHighlightTop"));
    hl.type = "button";
    hl.addEventListener("click", function () {
      chrome.scripting.executeScript(
        {
          target: { tabId: ctx.tabId },
          func: function (spec) {
            if (globalThis.ExtHighlight) return ExtHighlight.apply(spec);
            return 0;
          },
          args: [{ top_links: true }],
        },
        function () { void chrome.runtime.lastError; }
      );
    });
    root.appendChild(hl);
  }

  function sectionHead(root, ctx, key) {
    root.appendChild(tag("div", "group-head", ctx.msg(key)));
  }

  function outboundBlock(root, ctx, scan, data) {
    sectionHead(root, ctx, "donorOutbound");
    var donor = scan.donor || {};
    var links = donor.outbound || [];
    var dofollow = links.filter(function (l) { return (l.rel || []).indexOf("nofollow") === -1; }).length;
    var hosts = {};
    links.forEach(function (l) { hosts[l.host] = 1; });

    var summary = tag("div", "chips");
    summary.appendChild(tag("span", "chip", ctx.msg("donorOutboundSummary", [String(links.length), String(Object.keys(hosts).length), String(dofollow)])));
    root.appendChild(summary);

    // which outbound hosts are ours? — hosts[].own from the hosts call
    var ownHosts = {};
    if (data && data.hosts) {
      data.hosts.forEach(function (h) {
        if (h.own) ownHosts[h.host] = h.own.label;
        if (h.registrable) {
          // apex-level own marks the host too (a link to sub.page.own-site.gr counts)
          if (h.own) ownHosts[h.registrable] = h.own.label;
        }
      });
    }

    var bar = tag("div", "filterbar");
    var mode = tag("select");
    [["all", "—"], ["dofollow", ctx.msg("donorFilterDofollow")], ["content", ctx.msg("donorFilterContent")], ["mine", ctx.msg("donorFilterMine")]].forEach(function (o) {
      var opt = tag("option", null, o[1]);
      opt.value = o[0];
      mode.appendChild(opt);
    });
    mode.value = ui.filter;
    mode.addEventListener("change", function () { ui.filter = mode.value; repaint(); });
    bar.appendChild(mode);
    root.appendChild(bar);

    var box = tag("div", "table-wrap");
    root.appendChild(box);

    function isOwn(l) {
      return !!ownHosts[l.host];
    }

    function repaint() {
      box.textContent = "";
      var rows = links.filter(function (l) {
        if (ui.filter === "dofollow" && (l.rel || []).indexOf("nofollow") !== -1) return false;
        if (ui.filter === "content" && l.area !== "content") return false;
        if (ui.filter === "mine" && !isOwn(l)) return false;
        return true;
      });
      if (!rows.length) { box.appendChild(tag("div", "muted small", "—")); return; }
      var table = tag("table", "tbl");
      var thead = tag("tr");
      [ctx.msg("donorOutbound"), "rel", ""].forEach(function (h) { thead.appendChild(tag("th", null, h)); });
      var head = tag("thead");
      head.appendChild(thead);
      table.appendChild(head);
      var tbody = tag("tbody");
      rows.slice(0, 400).forEach(function (l) {
        var tr = tag("tr");
        var c1 = tag("td", "clip");
        var a = tag("a", null, l.text || l.host);
        a.href = l.href;
        a.target = "_blank";
        a.rel = "noopener";
        c1.appendChild(a);
        if (isOwn(l)) {
          c1.appendChild(tag("div", "ok-inline small", ctx.msg("donorAlreadyLinks", [ownHosts[l.host]])));
          tr.className = "own";
        }
        tr.appendChild(c1);
        var c2 = tag("td", "small");
        (l.rel || []).forEach(function (r) { c2.appendChild(tag("span", "pill", r)); });
        tr.appendChild(c2);
        tr.appendChild(tag("td", "small muted", ctx.msg("pageArea" + l.area.charAt(0).toUpperCase() + l.area.slice(1))));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      box.appendChild(table);
    }
    repaint();

    // CSV export of the outbound table
    var exportBtn = tag("button", "btn", ctx.msg("exportLinks"));
    exportBtn.type = "button";
    exportBtn.addEventListener("click", function () {
      var rows = [["anchor", "url", "host", "rel", "area"]];
      links.forEach(function (l) {
        rows.push([l.text, l.href, l.host, (l.rel || []).join(" "), l.area]);
      });
      ExtExport.csv(hostOfUrl(ctx.url), "outbound", rows);
    });
    root.appendChild(exportBtn);
  }

  // ─── the tab ───────────────────────────────────────────────────────────────────

  function paint(root, ctx) {
    CTX = ctx;
    ui.root = root;
    root.textContent = "";
    var scan = ctx.scan;

    if (scan && scan.donor) hostDataBlock(root, ctx, scan);

    if (ui.note) root.appendChild(tag("div", "ok-inline small", ui.note));
  }

  function hostDataBlock(root, ctx, scan) {
    var local = tag("div", "subpane");
    root.appendChild(local);
    signalsBlock(local, ctx, scan);
    outboundBlock(local, ctx, scan, ui.hostData);

    // the server half renders after the hosts call lands (or immediately from cache)
    var serverBox = tag("div", "subpane");
    root.insertBefore(serverBox, local);
    serverBox.appendChild(tag("div", "muted small", "…"));
    loadHosts(ctx, scan).then(function (data) {
      ui.hostData = data;
      serverBox.textContent = "";
      hostBlock(serverBox, ctx, scan, data);
    });
  }

  Panel.register({
    id: "donor",
    labelKey: "tabDonor",
    order: 30,
    applies: function (ctx) { return !!(ctx.scan && !(ctx.summary && ctx.summary.inPortfolio)); },
    render: function (root, ctx) {
      ui = { filter: ui.filter || "all", hostData: ui.hostData, note: "" };
      paint(root, ctx);
    },
  });
})();
