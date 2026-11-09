// OpenGSC extension — panel tab "OpenGSC": the GSC layer for portfolio pages (main query,
// sitemap, meta fit, footprint). E0 registers the stub; E2 owns the file.

Panel.register({
  id: "opengsc",
  labelKey: "tabOpengsc",
  order: 20,
  applies: function (ctx) { return !!(ctx.summary && ctx.summary.inPortfolio); },
  render: function (root, ctx) {
    var box = document.createElement("div");
    box.className = "soon";
    box.textContent = ctx.msg("panelSoon");
    root.appendChild(box);
  },
});
