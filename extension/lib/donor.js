// OpenGSC extension — donor-mode facts (wave-ext E3): what a person deciding "buy a link
// here?" needs from someone else's page. Runs inside the page (part of PANEL_INJECT); the
// facts travel to the panel, never to the server.
//
// MARKERS is a copy of the restored-site list from src/lib/pbn/clean.ts (the
// data-wf-reconstructed … line) plus the Wayback Machine leftovers. donor.test.ts extracts
// the clean.ts list from source text and fails when the copy drifts — same trick audit.test.ts
// uses for META_LIMITS.
//
// collect is the DOM half (verified by hand); deriveSignals and verdict are pure and tested.

var ExtDonor = (function () {
  "use strict";

  // Copy of residualFootprints()'s list in src/lib/pbn/clean.ts (wave-ext CONTRACT §4.6):
  // "data-wf-reconstructed", "data-wf-healed", "data-wf-injected", "data-wf-domain",
  // "data-wf-media-healer", "wf-footer-partner" — plus the Wayback leftovers below.
  var MARKERS = [
    "data-wf-reconstructed", "data-wf-healed", "data-wf-injected", "data-wf-domain",
    "data-wf-media-healer", "wf-footer-partner",
    "wm-ipp", "__wm", "wombat", "archive.org/static/",
  ];

  // Generator values that name a site-restore tool (checked case-insensitively as substrings).
  var RESTORE_GENERATORS = ["Archivarix", "WayForge", "Wayback Machine Downloader", "r-tools", "waybackpack"];

  var MAX_OUTBOUND = 500;

  function markerIsWayforge(m) {
    return m.indexOf("data-wf-") === 0 || m === "wf-footer-partner";
  }

  /** Where to look for one marker: DOM queries for attribute/class/id shapes, script/link
   *  text for URL-ish shapes. Returns { count, sample } or null when the marker is absent. */
  function findMarker(doc, m) {
    var found = null;
    var els = null;
    try {
      if (m === "wm-ipp") {
        els = doc.querySelectorAll("#wm-ipp, [id^='wm-ipp']");
      } else if (m === "wf-footer-partner") {
        els = doc.querySelectorAll("[class*='wf-footer-partner'], [wf-footer-partner]");
      } else if (markerIsWayforge(m)) {
        els = doc.querySelectorAll("[" + m + "]");
      }
    } catch { els = null; }
    if (els && els.length) found = { count: els.length, sample: String(els[0].outerHTML || "").slice(0, 120) };
    if (found) return found;

    // text/url markers: <script src|text>, <link href>, <style> text
    if (m === "__wm" || m === "wombat" || m === "archive.org/static/") {
      var count = 0;
      var sample = "";
      var nodes = doc.querySelectorAll("script, link, style");
      for (var i = 0; i < nodes.length && count < 500; i++) {
        var n = nodes[i];
        var src = String(n.getAttribute && (n.getAttribute("src") || n.getAttribute("href")) || "");
        var text = String(n.textContent || "").slice(0, 20000);
        if (src.indexOf(m) !== -1 || text.indexOf(m) !== -1) {
          count++;
          if (!sample) sample = String(n.outerHTML || "").slice(0, 120);
        }
      }
      if (count) return { count: count, sample: sample };
    }
    return null;
  }

  /** DonorFacts of the page (CONTRACT §4.5). Reads only; throws nothing. */
  function collect(doc) {
    var view = doc.defaultView || {};
    var loc = view.location || { href: "", host: "" };
    var pageReg = "";
    try { pageReg = ExtensionAudit.registrableOf(loc.host); } catch { pageReg = ""; }

    var facts = {
      host: loc.host || "",
      outbound: [],
      markers: [],
      archiveRefs: 0,
      generator: "",
      firstTextBlockIndex: -1,
    };

    try {
      var gen = doc.querySelector('meta[name="generator" i]');
      if (gen) facts.generator = String(gen.getAttribute("content") || "").trim().slice(0, 200);
    } catch { /* */ }

    // first text block: ordinal of the first body descendant whose own text ≥ TEXT_BLOCK_MIN
    try {
      var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, null);
      var el;
      var ordinal = 0;
      while ((el = walker.nextNode())) {
        if (ExtensionAudit.ownText(el).trim().length >= ExtensionAudit.TEXT_BLOCK_MIN) {
          facts.firstTextBlockIndex = ordinal;
          break;
        }
        ordinal++;
      }
    } catch { /* */ }

    // outbound links: external registrable domains only
    try {
      var firstBlock = ExtensionAudit.firstTextBlock(doc);
      var anchors = doc.querySelectorAll("a[href]");
      for (var i = 0; i < anchors.length && facts.outbound.length < MAX_OUTBOUND; i++) {
        var a = anchors[i];
        var href = a.href || "";
        if (!/^https?:/i.test(href)) continue;
        var host = "";
        try { host = new URL(href).host.toLowerCase(); } catch { continue; }
        var reg = ExtensionAudit.registrableOf(host);
        if (!reg || reg === pageReg) continue; // internal or junk
        var relRaw = String(a.getAttribute("rel") || "").toLowerCase();
        facts.outbound.push({
          href: String(href).slice(0, 500),
          host: host,
          text: String(a.textContent || "").trim().slice(0, 120),
          rel: relRaw ? relRaw.split(/\s+/).filter(Boolean) : [],
          area: ExtensionAudit.linkArea(a, firstBlock),
          index: i,
        });
      }
    } catch { /* */ }

    // markers
    for (var m = 0; m < MARKERS.length; m++) {
      var hit = findMarker(doc, MARKERS[m]);
      if (hit) facts.markers.push({ id: MARKERS[m], count: hit.count, sample: hit.sample });
    }

    // archiveRefs: src/href/srcset/poster + inline style url() pointing at web.archive.org
    try {
      var count2 = 0;
      var withUrl = doc.querySelectorAll("[src], [href], [srcset], [poster], [style]");
      for (var u = 0; u < withUrl.length; u++) {
        var node = withUrl[u];
        var attrs = ["src", "href", "srcset", "poster"];
        for (var at = 0; at < attrs.length; at++) {
          var v = String(node.getAttribute && node.getAttribute(attrs[at]) || "");
          if (v && /web\.archive\.org/i.test(v)) count2++;
        }
        var st = String(node.getAttribute && node.getAttribute("style") || "");
        if (st && /url\([^)]*web\.archive\.org/i.test(st)) count2++;
      }
      facts.archiveRefs = count2;
    } catch { /* */ }

    return facts;
  }

  // ── pure ──

  /** Signals → [{ id, severity, evidence }]. Pure: fixtures in donor.test.ts. */
  function deriveSignals(donorFacts) {
    var out = [];
    if (!donorFacts) return out;

    var wf = [];
    var wb = [];
    (donorFacts.markers || []).forEach(function (m) {
      if (markerIsWayforge(m.id)) wf.push(m);
      else wb.push(m);
    });
    if (wf.length) {
      out.push({
        id: "wayforge_marker",
        severity: "hard",
        evidence: wf.map(function (m) { return m.id + " ×" + m.count; }).join(", "),
      });
    }
    if (wb.length) {
      out.push({
        id: "wayback_toolbar",
        severity: "hard",
        evidence: wb.map(function (m) { return m.id + " ×" + m.count; }).join(", "),
      });
    }

    var refs = Number(donorFacts.archiveRefs) || 0;
    if (refs >= 5) out.push({ id: "archive_refs", severity: "hard", evidence: String(refs) });
    else if (refs >= 1) out.push({ id: "archive_refs", severity: "soft", evidence: String(refs) });

    var top = (donorFacts.outbound || []).filter(function (l) { return l.area === "top"; })[0];
    if (top) {
      out.push({
        id: "link_above_content",
        severity: "soft",
        evidence: (top.text || top.href || "").slice(0, 60) + " → " + top.host,
      });
    }

    var contentHosts = {};
    (donorFacts.outbound || []).forEach(function (l) {
      if (l.area === "content") contentHosts[l.host] = 1;
    });
    var contentCount = Object.keys(contentHosts).length;
    if (contentCount >= 25) {
      out.push({ id: "many_outbound_hosts", severity: "soft", evidence: String(contentCount) });
    }

    var footerHosts = {};
    (donorFacts.outbound || []).forEach(function (l) {
      if (l.area === "footer") footerHosts[l.host] = 1;
    });
    var footerCount = Object.keys(footerHosts).length;
    if (footerCount >= 3) {
      out.push({ id: "sitewide_footer_links", severity: "soft", evidence: Object.keys(footerHosts).slice(0, 5).join(", ") });
    }

    var gen = String(donorFacts.generator || "").toLowerCase();
    for (var g = 0; g < RESTORE_GENERATORS.length; g++) {
      if (gen && gen.indexOf(RESTORE_GENERATORS[g].toLowerCase()) !== -1) {
        out.push({ id: "generator_restore_tool", severity: "hard", evidence: donorFacts.generator });
        break;
      }
    }

    return out;
  }

  /**
   * "restored_drop" on any hard signal; "suspicious" on ≥ 2 soft; "clean" when the scan
   * happened and nothing fired (scanOk false — the collect failed — reads "unknown").
   * A verdict is a hint, never a sentence: the UI always lists the evidence under it.
   */
  function verdict(signals, scanOk) {
    var list = signals || [];
    if (list.some(function (s) { return s.severity === "hard"; })) return "restored_drop";
    var soft = list.filter(function (s) { return s.severity === "soft"; }).length;
    if (soft >= 2) return "suspicious";
    if (scanOk === false) return "unknown";
    return "clean";
  }

  return {
    MARKERS: MARKERS,
    RESTORE_GENERATORS: RESTORE_GENERATORS,
    collect: collect,
    deriveSignals: deriveSignals,
    verdict: verdict,
  };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtDonor;
