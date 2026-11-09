// OpenGSC extension — panel tab "Page": the local page breakdown (headings/links/images/
// schema/social/robots/speed). E0 registers the stub; E1 owns the file.

Panel.register({
  id: "page",
  labelKey: "tabPage",
  order: 10,
  applies: function () { return true; },
  render: function (root, ctx) {
    var box = document.createElement("div");
    box.className = "soon";
    box.textContent = ctx.msg("panelSoon");
    root.appendChild(box);
  },
});
