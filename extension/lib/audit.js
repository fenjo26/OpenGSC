// OpenGSC extension — the mini page audit (classic script).
//
// Two halves, on purpose:
//   collectFacts(document) — reads the live DOM of the active tab (content-script world);
//   deriveIssues(facts)    — PURE: turns a facts object into the issue list. No DOM, so the
//                            app's unit tests (src/lib/ext/audit.test.ts) cover it without
//                            jsdom by feeding fixture facts.
//
// Everything is computed INSIDE the extension: the mini audit never sends page content to the
// server (only the URL leaves, and only when a button says so).

var ExtensionAudit = (function () {
  "use strict";

  // Meta length bands, copied by hand from src/lib/seo/metaLimits.ts — THE source of truth.
  // If the app's bands move, move these with them (they are the same numbers):
  //   title       audit band 50..65 (target 50..60)
  //   description audit band 150..165 (target 150..160)
  // Lengths count Unicode code points after trimming, exactly like metaLength() there.
  var META_LIMITS = {
    title: { targetMin: 50, targetMax: 60, auditMin: 50, auditMax: 65 },
    description: { targetMin: 150, targetMax: 160, auditMin: 150, auditMax: 165 },
  };

  function metaLength(s) {
    return Array.from(String(s == null ? "" : s).trim()).length;
  }

  function text(el) {
    return el && el.getAttribute ? String(el.getAttribute("content") || el.textContent || "").trim() : "";
  }

  /** Everything the audit needs from the page, in one plain object. */
  function collectFacts(doc) {
    var loc = doc.defaultView ? doc.defaultView.location : { href: "", host: "" };
    var facts = {
      url: loc.href || "",
      host: loc.host || "",
      title: "",
      titleLength: 0,
      description: "",
      descriptionLength: 0,
      h1Count: 0,
      h1Text: "",
      canonical: null,
      robots: null,
      noindex: false,
      hreflang: [],
      jsonLdBlocks: 0,
      jsonLdValid: 0,
      jsonLdInvalid: 0,
      og: { title: false, description: false, image: false, url: false },
      links: { total: 0, internal: 0, external: 0 },
      images: { total: 0, noAlt: 0 },
      words: 0,
    };

    try { facts.title = String(doc.title || "").trim(); } catch (e) { /* frame doc */ }
    facts.titleLength = metaLength(facts.title);

    var desc = doc.querySelector('meta[name="description" i]');
    if (desc) facts.description = String(desc.getAttribute("content") || "").trim();
    facts.descriptionLength = metaLength(facts.description);

    var h1s = doc.querySelectorAll("h1");
    facts.h1Count = h1s.length;
    if (h1s.length) facts.h1Text = String(h1s[0].textContent || "").trim().slice(0, 200);

    var canonical = doc.querySelector('link[rel="canonical" i]');
    if (canonical) facts.canonical = canonical.getAttribute("href") || "";

    var robots = doc.querySelector('meta[name="robots" i]');
    if (robots) {
      facts.robots = String(robots.getAttribute("content") || "").toLowerCase();
      facts.noindex = facts.robots.indexOf("noindex") !== -1;
    }

    var alternates = doc.querySelectorAll('link[rel="alternate" i][hreflang]');
    for (var i = 0; i < alternates.length; i++) {
      facts.hreflang.push({
        hreflang: alternates[i].getAttribute("hreflang") || "",
        href: alternates[i].getAttribute("href") || "",
      });
    }

    var ldBlocks = doc.querySelectorAll('script[type="application/ld+json" i]');
    facts.jsonLdBlocks = ldBlocks.length;
    for (var j = 0; j < ldBlocks.length; j++) {
      var raw = String(ldBlocks[j].textContent || "").trim();
      if (!raw) { facts.jsonLdInvalid++; continue; }
      try { JSON.parse(raw); facts.jsonLdValid++; } catch (e) { facts.jsonLdInvalid++; }
    }

    facts.og.title = !!doc.querySelector('meta[property="og:title" i]');
    facts.og.description = !!doc.querySelector('meta[property="og:description" i]');
    facts.og.image = !!doc.querySelector('meta[property="og:image" i]');
    facts.og.url = !!doc.querySelector('meta[property="og:url" i]');

    var anchors = doc.querySelectorAll("a[href]");
    facts.links.total = anchors.length;
    for (var k = 0; k < anchors.length; k++) {
      var href = anchors[k].getAttribute("href") || "";
      if (/^(https?:)?\/\//i.test(href)) {
        var m = href.match(/^(?:https:)?\/\/([^/?#]+)/i);
        var linkHost = m ? m[1].toLowerCase() : "";
        if (linkHost && linkHost !== String(loc.host).toLowerCase()) facts.links.external++;
        else facts.links.internal++;
      } else if (href.charAt(0) === "#") {
        // anchor-only links count as neither
      } else {
        facts.links.internal++;
      }
    }

    var imgs = doc.querySelectorAll("img");
    facts.images.total = imgs.length;
    for (var g = 0; g < imgs.length; g++) {
      var alt = imgs[g].getAttribute("alt");
      if (alt == null || String(alt).trim() === "") facts.images.noAlt++;
    }

    var body = doc.body;
    var bodyText = body ? String(body.innerText || "").trim() : "";
    facts.words = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

    return facts;
  }

  /**
   * The audit verdicts, PURE. Same bands and same outside-the-band semantics as the app's
   * audit rules (src/lib/audit/rules.ts flags outside the audit band; an empty value is a
   * separate "missing" state, never a "short" one).
   */
  function deriveIssues(facts) {
    var issues = [];
    var add = function (id, severity, detail) {
      issues.push({ id: id, severity: severity, detail: detail == null ? "" : String(detail) });
    };

    if (!facts.title) add("title_missing", "error");
    else if (facts.titleLength < META_LIMITS.title.auditMin) add("title_short", "warn", facts.titleLength);
    else if (facts.titleLength > META_LIMITS.title.auditMax) add("title_long", "warn", facts.titleLength);

    if (!facts.description) add("description_missing", "error");
    else if (facts.descriptionLength < META_LIMITS.description.auditMin) add("description_short", "warn", facts.descriptionLength);
    else if (facts.descriptionLength > META_LIMITS.description.auditMax) add("description_long", "warn", facts.descriptionLength);

    if (facts.h1Count === 0) add("h1_missing", "error");
    else if (facts.h1Count > 1) add("h1_multiple", "warn", facts.h1Count);

    if (!facts.canonical) add("canonical_missing", "info");

    if (facts.noindex) add("robots_noindex", "error");

    if (facts.jsonLdInvalid > 0) add("jsonld_invalid", "error", facts.jsonLdInvalid);
    else if (facts.jsonLdBlocks === 0) add("jsonld_missing", "info");

    var ogPresent = facts.og.title || facts.og.description || facts.og.image || facts.og.url;
    if (ogPresent && (!facts.og.title || !facts.og.image)) add("og_incomplete", "warn");
    else if (!ogPresent) add("og_missing", "info");

    if (facts.images.noAlt > 0) add("images_no_alt", "warn", facts.images.noAlt + "/" + facts.images.total);

    return issues;
  }

  function countSeverities(issues) {
    var counts = { error: 0, warn: 0, info: 0 };
    for (var i = 0; i < issues.length; i++) {
      if (counts[issues[i].severity] != null) counts[issues[i].severity]++;
    }
    return counts;
  }

  return {
    META_LIMITS: META_LIMITS,
    metaLength: metaLength,
    collectFacts: collectFacts,
    deriveIssues: deriveIssues,
    countSeverities: countSeverities,
  };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtensionAudit;
