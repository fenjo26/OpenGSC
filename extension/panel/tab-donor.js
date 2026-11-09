// OpenGSC extension — panel tab "Donor": outbound links + restored-drop signals for someone
// else's page. E0 registers the stub; E3 owns the file.

Panel.register({
  id: "donor",
  labelKey: "tabDonor",
  order: 30,
  applies: function (ctx) { return !!(ctx.scan || ctx.scanError) && !(ctx.summary && ctx.summary.inPortfolio); },
  render: function (root, ctx) {
    var box = document.createElement("div");
    box.className = "soon";
    box.textContent = ctx.msg("panelSoon");
    root.appendChild(box);
  },
});
