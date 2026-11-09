// OpenGSC extension — the page audit (classic script).
//
// Two halves, on purpose:
//   collectFacts(document) — reads the live DOM of the active tab (content-script world);
//   deriveIssues(facts, vitals?) — PURE: turns a facts object into the issue list. No DOM, so
//                            the app's unit tests (src/lib/ext/audit.test.ts, auditDetail.test.ts)
//                            cover it without jsdom by feeding fixture facts.
//
// wave-ext E1: the N11 fields are untouched (their tests are the contract), and collectFacts
// now also fills `facts.detail` — the page breakdown the side panel renders (CONTRACT §4.3):
// headings, links with areas, images, JSON-LD types, social tags. Pure helpers shared with the
// donor tab (E3) live here too: registrableOf, linkArea, TEXT_BLOCK_MIN, robotsAllows.
//
// Everything is computed INSIDE the extension: the audit never sends page content to the
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

  // A "text block" is a block-level element whose own text reaches this many characters —
  // the threshold for a link to count as "in text" vs "above all content" (the WayForge
  // inject shape). E3's donor facts use the same constant through collectFacts.
  var TEXT_BLOCK_MIN = 150;

  // Caps that keep the executeScript answer bounded on giant pages; when hit, detail.truncated
  // says which list was cut so the panel can label "showing the first N".
  var MAX_HEADINGS = 500;
  var MAX_LINKS = 2000;
  var MAX_IMAGES = 1000;

  // Two-label public suffixes, copied by hand from TWO_LABEL_SUFFIXES in
  // src/lib/drops/registries.ts (not exported there; auditDetail.test.ts asserts the copy
  // stays identical). Anything not here is treated as a single-label TLD.
  var TWO_LABEL_SUFFIXES = [
    "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "net.nz", "org.nz",
    "com.br", "net.br", "org.br",
    "co.jp", "or.jp", "ne.jp", "ac.jp",
    "com.cn", "net.cn", "org.cn",
    "co.in", "net.in", "org.in",
    "com.tr", "net.tr", "org.tr", "gen.tr",
    "com.gr", "net.gr", "org.gr", "edu.gr", "gov.gr",
    "com.pl", "net.pl", "org.pl",
    "co.za", "org.za",
    "com.ua", "net.ua", "org.ua", "in.ua", "kiev.ua",
    "com.mx", "org.mx",
    "co.il", "org.il", "net.il", "ac.il",
    "com.ar", "net.ar", "org.ar", "gob.ar",
    "bet.ar", "tur.ar",
    "com.co", "net.co", "org.co", "gov.co",
    "com.pe", "net.pe", "org.pe", "gob.pe",
    "com.ec", "com.uy", "com.py", "com.bo", "com.ve",
    "com.cy", "com.sg", "com.my", "com.ph", "com.vn",
    "co.id", "co.th", "com.eg", "com.sa",
    "za.bz", "br.com", "cn.com", "de.com", "eu.com", "jpn.com", "mex.com", "ru.com",
    "sa.com", "uk.com", "us.com", "za.com", "com.de", "gb.net", "hu.net", "jp.net",
    "se.net", "uk.net", "ae.org", "com.se",
    "net.ru", "org.ru", "pp.ru", "za.net", "za.org",
  ];
  var SUFFIX_SET = {};
  for (var si = 0; si < TWO_LABEL_SUFFIXES.length; si++) SUFFIX_SET[TWO_LABEL_SUFFIXES[si]] = true;

  /** The registrable domain of a host ("www.a.example.co.uk" → "example.co.uk"); "" when the
   *  host is not a registrable-shaped name (an IP, a bare TLD…). */
  function registrableOf(host) {
    var clean = String(host || "").trim().toLowerCase().replace(/\.$/, "");
    if (!clean) return "";
    var parts = clean.split(".");
    if (parts.length < 2) return "";
    for (var i = 0; i < parts.length; i++) if (!parts[i]) return "";
    var last = parts[parts.length - 1];
    if (!/[a-z\u00a1-\uffff]/.test(last)) return ""; // IPv4-shaped — no registrable
    var two = parts.slice(-2).join(".");
    if (SUFFIX_SET[two]) return parts.length >= 3 ? parts.slice(-3).join(".") : "";
    return two;
  }

  function metaLength(s) {
    return Array.from(String(s == null ? "" : s).trim()).length;
  }

  // ─── link areas (CONTRACT §4.3) ────────────────────────────────────────────────

  var AREA_ROLES = { navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside" };

  /** Own text of an element: the concatenated text of its direct text nodes only. */
  function ownText(el) {
    var out = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue || "";
    }
    return out;
  }

  /** Where on the page does this element sit: nav/header/footer/aside by ancestor tag or ARIA
   *  role, else "content" (inside main/article or a text block ≥ TEXT_BLOCK_MIN), else "top"
   *  (before the first text block — the WayForge inject shape), else "other". */
  function linkArea(el, firstTextBlock) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var tag = String(node.tagName || "").toLowerCase();
      if (tag === "nav") return "nav";
      if (tag === "header") return "header";
      if (tag === "footer") return "footer";
      if (tag === "aside") return "aside";
      var role = node.getAttribute && node.getAttribute("role");
      if (role && AREA_ROLES[String(role).toLowerCase()]) return AREA_ROLES[String(role).toLowerCase()];
      node = node.parentElement;
    }
    // inside real content?
    node = el.parentElement;
    while (node && node !== document.body) {
      var t = String(node.tagName || "").toLowerCase();
      if (t === "main" || t === "article") return "content";
      if (ownText(node).trim().length >= TEXT_BLOCK_MIN) return "content";
      node = node.parentElement;
    }
    // before any real text → the classic "link at the top of body"
    if (firstTextBlock && el.compareDocumentPosition(firstTextBlock) & 4 /* DOCUMENT_POSITION_FOLLOWING */) {
      return "top";
    }
    return "other";
  }

  /** The first descendant of body (document order) whose own text reaches TEXT_BLOCK_MIN —
   *  the page's first real content block; null when there is none. */
  function firstTextBlock(doc) {
    var body = doc.body;
    if (!body || !doc.createTreeWalker) return null;
    var walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, null);
    var el;
    while ((el = walker.nextNode())) {
      if (ownText(el).trim().length >= TEXT_BLOCK_MIN) return el;
    }
    return null;
  }

  function isHidden(el, view) {
    try {
      var cs = view.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return true;
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
      return r.width === 0 && r.height === 0;
    } catch {
      return false;
    }
  }

  function linkText(el) {
    var text = String(el.textContent || "").trim();
    if (text) return text.slice(0, 120);
    // image-with-alt anchors and aria-labels are text for this purpose
    var img = el.querySelector ? el.querySelector("img[alt]") : null;
    if (img) {
      var alt = String(img.getAttribute("alt") || "").trim();
      if (alt) return alt.slice(0, 120);
    }
    var label = el.getAttribute ? el.getAttribute("aria-label") : "";
    return label ? String(label).trim().slice(0, 120) : "";
  }

  function imgExt(src) {
    var m = String(src || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
    var ext = m ? m[1].toLowerCase() : "";
    if (ext === "jpeg") ext = "jpg";
    return ext;
  }

  /** All @type values of a parsed JSON-LD node, @graph included. */
  function jsonLdTypes(value, out) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) jsonLdTypes(value[i], out);
      return;
    }
    var t = value["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) for (var j = 0; j < t.length; j++) if (typeof t[j] === "string") out.push(t[j]);
    var g = value["@graph"];
    if (g) jsonLdTypes(g, out);
    for (var k in value) {
      if (k !== "@graph" && value[k] && typeof value[k] === "object") jsonLdTypes(value[k], out);
    }
  }

  /** Everything the audit needs from the page, in one plain object. */
  function collectFacts(doc) {
    var view = doc.defaultView || {};
    var loc = view.location || { href: "", host: "" };
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

    try { facts.title = String(doc.title || "").trim(); } catch { /* frame doc */ }
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
      try { JSON.parse(raw); facts.jsonLdValid++; } catch { facts.jsonLdInvalid++; }
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

    // ─── wave-ext E1: facts.detail (CONTRACT §4.3) ───────────────────────────────

    var pageReg = registrableOf(loc.host);
    var firstBlock = firstTextBlock(doc);

    var detail = {
      lang: "",
      charset: "",
      viewport: "",
      robotsMeta: facts.robots || "",
      xRobots: null,
      canonical: facts.canonical || "",
      title: facts.title,
      description: facts.description,
      headings: [],
      links: [],
      images: [],
      jsonLd: [],
      microdataTypes: [],
      og: {},
      twitter: {},
      hreflang: facts.hreflang,
      counts: {
        words: facts.words,
        linksInternal: 0,
        linksExternal: 0,
        linksNofollow: 0,
        imagesNoAlt: 0,
        h1: 0,
      },
      truncated: {},
    };

    try { detail.lang = String(doc.documentElement.getAttribute("lang") || "").trim(); } catch { /* */ }
    try { detail.charset = String(doc.characterSet || ""); } catch { /* */ }
    var vp = doc.querySelector('meta[name="viewport" i]');
    if (vp) detail.viewport = String(vp.getAttribute("content") || "").trim();

    var heads = doc.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (var hi = 0; hi < heads.length && detail.headings.length < MAX_HEADINGS; hi++) {
      var h = heads[hi];
      var level = parseInt(String(h.tagName || "H1").slice(1), 10) || 1;
      var text = String(h.textContent || "").trim().slice(0, 200);
      detail.headings.push({ level: level, text: text, hidden: isHidden(h, view) });
      if (level === 1 && !detail.headings[detail.headings.length - 1].hidden) detail.counts.h1++;
    }
    if (heads.length > detail.headings.length) detail.truncated.headings = true;

    for (var ai = 0; ai < anchors.length && detail.links.length < MAX_LINKS; ai++) {
      var a = anchors[ai];
      var ahref = a.href || a.getAttribute("href") || ""; // a.href is absolute
      var rawHref = String(a.getAttribute("href") || "");
      var kind = null;
      if (/^(javascript|mailto|tel):/i.test(rawHref)) kind = "special";
      else if (rawHref.charAt(0) === "#") kind = "anchor";
      var ahost = "";
      try { if (/^https?:/i.test(ahref)) { ahost = new URL(ahref, loc.href).host.toLowerCase(); } } catch { /* */ }
      var internal = !!ahost && !!pageReg && registrableOf(ahost) === pageReg;
      if (!kind) {
        if (ahost) {
          if (internal) detail.counts.linksInternal++;
          else detail.counts.linksExternal++;
        } // scheme-less relative links are internal by construction but not counted per host
      }
      var relRaw = String(a.getAttribute("rel") || "").toLowerCase();
      var rel = relRaw ? relRaw.split(/\s+/).filter(Boolean) : [];
      if (rel.indexOf("nofollow") !== -1) detail.counts.linksNofollow++;
      detail.links.push({
        href: String(ahref || rawHref).slice(0, 500),
        text: linkText(a),
        rel: rel,
        internal: internal,
        area: linkArea(a, firstBlock),
        index: ai,
        kind: kind || "",
      });
    }
    if (anchors.length > detail.links.length) detail.truncated.links = true;

    for (var ii = 0; ii < imgs.length && detail.images.length < MAX_IMAGES; ii++) {
      var im = imgs[ii];
      var ialt = im.getAttribute("alt");
      var iw = parseInt(im.getAttribute("width") || "", 10);
      var ih = parseInt(im.getAttribute("height") || "", 10);
      var isrc = im.currentSrc || im.getAttribute("src") || "";
      if (ialt == null) detail.counts.imagesNoAlt++;
      detail.images.push({
        src: String(isrc).slice(0, 500),
        alt: ialt,
        width: iw || 0,
        height: ih || 0,
        hasDims: !!(iw > 0 && ih > 0),
        lazy: im.getAttribute("loading") === "lazy" || (!im.getAttribute("src") && !!im.getAttribute("data-src")),
        ext: imgExt(isrc || im.getAttribute("data-src") || ""),
        area: linkArea(im, firstBlock),
      });
    }
    if (imgs.length > detail.images.length) detail.truncated.images = true;

    for (var li = 0; li < ldBlocks.length; li++) {
      var ldraw = String(ldBlocks[li].textContent || "").trim();
      var entry = { types: [], valid: false, error: "" };
      if (!ldraw) {
        entry.error = "empty block";
      } else {
        try {
          var parsed = JSON.parse(ldraw);
          entry.valid = true;
          jsonLdTypes(parsed, entry.types);
        } catch (e) {
          entry.error = String(e && e.message ? e.message : e).slice(0, 120);
        }
      }
      detail.jsonLd.push(entry);
    }

    var mdTypes = doc.querySelectorAll("[itemtype]");
    for (var mi = 0; mi < mdTypes.length; mi++) {
      var t2 = String(mdTypes[mi].getAttribute("itemtype") || "");
      if (t2 && detail.microdataTypes.indexOf(t2) === -1) detail.microdataTypes.push(t2);
    }

    // script srcs (cap 500) — the mixed-content check needs them; superset of the contract
    // shape, the panel ignores the field elsewhere.
    detail.scripts = [];
    var scriptTags = doc.querySelectorAll("script[src]");
    for (var s1 = 0; s1 < scriptTags.length && s1 < 500; s1++) {
      detail.scripts.push(String(scriptTags[s1].getAttribute("src") || "").slice(0, 500));
    }

    var ogMetas = doc.querySelectorAll('meta[property^="og:" i]');
    for (var oi = 0; oi < ogMetas.length; oi++) {
      detail.og[String(ogMetas[oi].getAttribute("property") || "").toLowerCase()] =
        String(ogMetas[oi].getAttribute("content") || "");
    }
    var twMetas = doc.querySelectorAll('meta[name^="twitter:" i]');
    for (var ti = 0; ti < twMetas.length; ti++) {
      detail.twitter[String(twMetas[ti].getAttribute("name") || "").toLowerCase()] =
        String(twMetas[ti].getAttribute("content") || "");
    }

    facts.detail = detail;
    return facts;
  }

  // ─── robots.txt evaluation (PURE — the panel's robots tab) ─────────────────────

  /** Google's robots.txt matching for one user agent: groups by most-specific agent match,
   *  longest (Allow|Disallow) rule pattern wins, ties → Allow, `*` and `$` supported, an empty
   *  Disallow allows everything. Simplified on purpose: no crawl-delay, no sitemap effects. */
  function robotsAllows(robotsTxt, userAgent, path) {
    var groups = [];
    var current = null;
    var lines = String(robotsTxt || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/#.*$/, "").trim();
      if (!line) { current = null; continue; }
      var idx = line.indexOf(":");
      if (idx < 0) continue;
      var field = line.slice(0, idx).trim().toLowerCase();
      var value = line.slice(idx + 1).trim();
      if (field === "user-agent") {
        if (!current || current.ruleCount > 0) { current = { agents: [], rules: [], ruleCount: 0 }; groups.push(current); }
        current.agents.push(value.toLowerCase());
      } else if ((field === "allow" || field === "disallow") && current) {
        // An empty Disallow allows everything (Google's spec) — not a zero-length match.
        if (field === "disallow" && !value) continue;
        current.rules.push({ allow: field === "allow", pattern: value });
        current.ruleCount++;
      }
    }
    var ua = String(userAgent || "*").toLowerCase();
    // Only the MOST SPECIFIC matching group applies (Google semantics: a Googlebot group beats
    // the * group; "Google" matches "Googlebot" by prefix). "*" is the least specific.
    var chosen = null;
    var chosenSpec = -1;
    for (var gi = 0; gi < groups.length; gi++) {
      var grp = groups[gi];
      for (var ai = 0; ai < grp.agents.length; ai++) {
        var a = grp.agents[ai];
        var spec = a === "*" ? 0 : (ua.indexOf(a) === 0 ? a.length : -1);
        if (spec < 0) continue;
        if (spec === 0 && chosen != null) continue; // "*" loses to any named match
        if (spec > chosenSpec) { chosenSpec = spec; chosen = grp; }
      }
    }
    if (!chosen) return { allowed: true, rule: null };

    var matchLen = function (pattern, p) {
      // Longest-wins semantics use the pattern length, as Google documents.
      var anchored = pattern.charAt(pattern.length - 1) === "$";
      var body = anchored ? pattern.slice(0, -1) : pattern;
      if (body.indexOf("*") === -1) {
        // plain prefix match (an anchored one must match to the end)
        var hit = anchored ? p === body : p.indexOf(body) === 0;
        return hit ? pattern.length : -1;
      }
      var re = new RegExp("^" + body.split("*").map(function (s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }).join(".*") + (anchored ? "$" : ""));
      return re.test(p) ? pattern.length : -1;
    };

    var best = null; // { allow, pattern, len }
    var rules = chosen.rules;
    for (var r2 = 0; r2 < rules.length; r2++) {
      var len = matchLen(rules[r2].pattern, path);
      if (len < 0) continue;
      if (!best || len > best.len || (len === best.len && rules[r2].allow && !best.allow)) {
        best = { allow: rules[r2].allow, pattern: rules[r2].pattern, len: len };
      }
    }
    if (!best) return { allowed: true, rule: null };
    return { allowed: best.allow, rule: (best.allow ? "Allow: " : "Disallow: ") + best.pattern };
  }

  // ─── the verdicts (PURE) ───────────────────────────────────────────────────────

  function urlsSameEnough(a, b) {
    var norm = function (u) {
      var s = String(u || "").split("#")[0];
      if (s.charAt(s.length - 1) === "/" && s.split("/").length > 3) s = s.slice(0, -1);
      return s.toLowerCase();
    };
    return norm(a) === norm(b);
  }

  /**
   * The audit verdicts, PURE. N11 issues keep their exact bands and detail shapes; the wave-ext
   * E1 ids below read `facts.detail` / the optional `vitals` and simply don't fire when a facts
   * fixture has no detail (the N11 tests feed exactly such fixtures).
   */
  function deriveIssues(facts, vitals) {
    var issues = [];
    var add = function (id, severity, detail) {
      issues.push({ id: id, severity: severity, detail: detail == null ? "" : String(detail) });
    };
    var d = facts.detail;

    if (!facts.title) add("title_missing", "error");
    else if (facts.titleLength < META_LIMITS.title.auditMin) add("title_short", "warn", facts.titleLength);
    else if (facts.titleLength > META_LIMITS.title.auditMax) add("title_long", "warn", facts.titleLength);

    if (!facts.description) add("description_missing", "error");
    else if (facts.descriptionLength < META_LIMITS.description.auditMin) add("description_short", "warn", facts.descriptionLength);
    else if (facts.descriptionLength > META_LIMITS.description.auditMax) add("description_long", "warn", facts.descriptionLength);

    if (d) {
      var visibleH1 = d.counts ? d.counts.h1 : facts.h1Count;
      if (visibleH1 === 0) add("h1_missing", "error");
      else if (visibleH1 > 1) add("h1_multiple", "warn", visibleH1);

      var visible = (d.headings || []).filter(function (h2) { return !h2.hidden; });
      var prev = 0;
      for (var h3 = 0; h3 < visible.length; h3++) {
        if (prev && visible[h3].level - prev > 1) add("heading_skip", "info", "H" + prev + "→H" + visible[h3].level);
        if (!visible[h3].text) add("heading_empty", "warn", "H" + visible[h3].level);
        prev = visible[h3].level;
      }

      var noDims = 0;
      for (var im2 = 0; im2 < (d.images || []).length; im2++) if (!d.images[im2].hasDims) noDims++;
      if (noDims > 0) add("images_no_dims", "info", noDims);

      if (!d.lang) add("html_lang_missing", "warn");
      if (!d.viewport) add("viewport_missing", "warn");

      var emptyLinks = 0;
      for (var lk = 0; lk < (d.links || []).length; lk++) {
        if (!d.links[lk].text && !d.links[lk].kind) emptyLinks++;
      }
      if (emptyLinks > 0) add("link_empty_text", "warn", emptyLinks);

      if (d.canonical && facts.url && !urlsSameEnough(d.canonical, facts.url)) add("canonical_other", "info", d.canonical);

      if (/^https:/i.test(facts.url || "")) {
        var mixed = 0;
        for (var im3 = 0; im3 < (d.images || []).length; im3++) {
          if (/^http:\/\//i.test(d.images[im3].src)) mixed++;
        }
        for (var sc = 0; sc < (d.scripts || []).length; sc++) {
          if (/^http:\/\//i.test(d.scripts[sc])) mixed++;
        }
        if (mixed > 0) add("mixed_content", "warn", mixed);
      }
    } else {
      // N11 behavior for facts without detail (the original tests' fixtures).
      if (facts.h1Count === 0) add("h1_missing", "error");
      else if (facts.h1Count > 1) add("h1_multiple", "warn", facts.h1Count);
    }

    if (!facts.canonical) add("canonical_missing", "info");

    if (facts.noindex) add("robots_noindex", "error");

    if (facts.jsonLdInvalid > 0) add("jsonld_invalid", "error", facts.jsonLdInvalid);
    else if (facts.jsonLdBlocks === 0) add("jsonld_missing", "info");

    var ogPresent = facts.og.title || facts.og.description || facts.og.image || facts.og.url;
    if (ogPresent && (!facts.og.title || !facts.og.image)) add("og_incomplete", "warn");
    else if (!ogPresent) add("og_missing", "info");

    if (facts.images.noAlt > 0) add("images_no_alt", "warn", facts.images.noAlt + "/" + facts.images.total);

    if (vitals) {
      if (vitals.lcp != null && vitals.lcp > 4000) add("lcp_poor", "warn", Math.round(vitals.lcp) + " ms");
      if (vitals.cls != null && vitals.cls > 0.25) add("cls_poor", "warn", String(vitals.cls));
    }

    return issues;
  }

  function countSeverities(issues) {
    var counts = { error: 0, warn: 0, info: 0 };
    for (var i = 0; i < issues.length; i++) {
      if (counts[issues[i].severity] != null) counts[issues[i].severity]++;
    }
    return counts;
  }

  /** The transparent MineOrganic-style score: 100 − 10·error − 4·warn − 1·info, floor 0. */
  function pageScore(issues) {
    var c = countSeverities(issues);
    return Math.max(0, 100 - c.error * 10 - c.warn * 4 - c.info * 1);
  }

  return {
    META_LIMITS: META_LIMITS,
    TEXT_BLOCK_MIN: TEXT_BLOCK_MIN,
    TWO_LABEL_SUFFIXES: TWO_LABEL_SUFFIXES,
    metaLength: metaLength,
    registrableOf: registrableOf,
    linkArea: linkArea,
    firstTextBlock: firstTextBlock,
    ownText: ownText,
    robotsAllows: robotsAllows,
    collectFacts: collectFacts,
    deriveIssues: deriveIssues,
    countSeverities: countSeverities,
    pageScore: pageScore,
  };
})();

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtensionAudit;
