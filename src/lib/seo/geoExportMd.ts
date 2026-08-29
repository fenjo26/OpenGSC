import type { GeoReport } from "@/lib/seo/geo";

// Markdown rendering of a GEO audit report. The on-screen report (GeoAuditReport.tsx) is for
// reading; this is the "feed the conclusions somewhere" path — hand it to a brief, a client or
// a doc. Mirrors the screen's sections in the same order, deterministic and dependency-free.
// The yourPage block only appears when the audit ran with a page URL that could be fetched.

export function buildGeoMarkdown(r: GeoReport): string {
  const L: string[] = [];

  L.push(`# GEO Audit: ${r.query}`);
  L.push("");
  L.push(`- Date: ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  L.push(`- Model: ${r.model}`);
  L.push(`- Language: ${r.language} · Country: ${r.country.toUpperCase()}`);
  L.push(`- Intent: ${r.classification.intent} (${r.classification.intentConfidence.toFixed(2)}) · Stage: ${r.classification.stage} · Topic: ${r.classification.topic}`);
  if (r.pageUrl) L.push(`- Your page: ${r.pageUrl}`);
  L.push("");

  L.push("## Metrics");
  L.push("");
  L.push("| Metric | Value |");
  L.push("| --- | --- |");
  L.push(`| Search batches | ${r.metrics.searchBatches} (${r.metrics.uniqueQueries} unique queries) |`);
  L.push(`| Pages opened | ${r.metrics.pagesOpened} |`);
  L.push(`| Sources scanned | ${r.metrics.sourcesScanned} (${r.metrics.uniqueDomains} unique domains) |`);
  L.push(`| Citations | ${r.metrics.citations} (${r.metrics.scannedToCitedPct}% of scanned) |`);
  L.push(`| Top-3 concentration | ${r.metrics.top3ConcentrationPct}% |`);
  L.push(`| Dominant source type | ${r.metrics.dominantType.label} (${r.metrics.dominantType.pct}%) |`);
  L.push("");

  if (r.yourPage) {
    L.push("## Your page");
    L.push("");
    L.push(`**${r.yourPage.cited ? "Cited in this answer." : "Not cited in this answer."}** ${r.yourPage.summary}`.trim());
    L.push("");
    if (r.yourPage.gaps.length) {
      L.push("### Gaps vs cited pages");
      L.push("");
      for (const g of r.yourPage.gaps) L.push(`- ${g}`);
      L.push("");
    }
    if (r.yourPage.fixes.length) {
      L.push("### Recommended fixes");
      L.push("");
      for (const f of r.yourPage.fixes) L.push(`- ${f}`);
      L.push("");
    }
    if (r.yourPage.citedCompetitors.length) {
      L.push(`Competitors cited instead: ${r.yourPage.citedCompetitors.join(", ")}`);
      L.push("");
    }
  } else if (r.pageUrl) {
    L.push("## Your page");
    L.push("");
    L.push("The page could not be fetched, so no page-level comparison was made.");
    L.push("");
  }

  if (r.brands.length) {
    L.push("## Brands cited");
    L.push("");
    L.push("| # | Brand | Domain | Tags | Pricing | Support | Features |");
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const b of r.brands) {
      L.push(`| ${b.rank} | ${b.name} | ${b.domain} | ${b.tags.join(", ")} | ${b.pricing} | ${b.support} | ${b.featureBreadth} |`);
    }
    L.push("");
  }

  if (r.keyEntities.length) {
    L.push("## Key entities");
    L.push("");
    for (const cat of r.keyEntities) {
      L.push(`**${cat.category}**: ${cat.items.map(i => `${i.name} (${i.count})`).join(", ")}`);
      L.push("");
    }
  }

  if (r.sourceTypes.length) {
    L.push("## Source types");
    L.push("");
    L.push("| Type | Share of citations | Citations | Domains |");
    L.push("| --- | --- | --- | --- |");
    for (const s of r.sourceTypes) L.push(`| ${s.label} | ${s.pct}% | ${s.cites} | ${s.domains} |`);
    L.push("");
  }

  L.push("## Insights");
  L.push("");
  L.push(`- **Search behavior:** ${r.insights.userSearchBehavior}`);
  L.push(`- **Dominant source:** ${r.insights.dominantSource}`);
  L.push(`- **Highest-leverage action:** ${r.insights.strategicEngagement}`);
  L.push(`- **Opportunity gaps:** ${r.insights.opportunityGaps}`);
  L.push("");

  if (r.coverageGaps.missingFactors.length || r.coverageGaps.missingEntities.length) {
    L.push("## Coverage gaps");
    L.push("");
    for (const f of r.coverageGaps.missingFactors) L.push(`- Missing factor: ${f}`);
    for (const e of r.coverageGaps.missingEntities) L.push(`- Missing entity: ${e}`);
    L.push("");
  }

  L.push("## Answer");
  L.push("");
  L.push(r.answer.text.split("\n").map(l => `> ${l}`).join("\n"));
  L.push("");
  if (r.answer.citations.length) {
    L.push("### Citations");
    L.push("");
    for (const c of r.answer.citations) L.push(`${c.n}. [${c.title || c.domain}](${c.url}) — ${c.domain}`);
    L.push("");
  }

  return L.join("\n");
}
