# Backlinks

Site → **Backlinks** tab. Three different questions, three parts of the tab:

| Part | Question | Data comes from |
|---|---|---|
| **Your link list** (inventory) | Did the links *I* built or bought survive, and are they indexed? | URLs you paste or import, checked from your server |
| **Backlink profile** | What does a link index see pointing at my site, and what was lost? | Ahrefs, Semrush, Majestic, DataForSEO, Keys.so, Crawlgraph, or a free CSV import |
| **Toxicity · Disavow · Recovery** | Which donors are bad *for this site*, what goes into the disavow file, which lost link to win back first? | Local math over the profile rows |

Competitor backlinks are a separate tool: [SEO Tools → Link Monitor](SEO-Tools#link-monitor).

## Your link list (inventory)

Paste backlink URLs, one per line → **Add**. Then:

- **Check 404 (ALL)**: liveness check from your server: is the page up and does it still link to you? Transient failures (5xx, rate limits, network drops) are retried. A WAF/bot-protection refusal (Cloudflare 403) is reported as **Blocked**, not Dead.
- **Index XMLRIVER**: is the donor page indexed in Google? Needs an XMLRiver account (Settings → SERP & scraping).
- **Index 2index**: push donor pages for indexing (2index.ninja, Settings → Indexing).
- Counters: total / alive / dead / blocked / indexed. **Operations history** and **Links Export**.

Links published from [Publishing](Publishing-and-Magic-Links) and bought through [Magic links](Publishing-and-Magic-Links#magic-links) enter the same pipeline as donors automatically.

## Backlink profile

Referring domains, live and lost, with stored history of counts.

- **Provider pills**: **All (merged)** combines every provider into unique domains, with DR from Ahrefs, TF/CF from Majestic and AS from Semrush in their own columns. Each provider tab keeps that source's own live/lost verdicts and refreshes from its own key. Keys.so shows a separate `DR·KS` (Yandex/Runet index), DataForSEO its own `Rank·DFS` (0–100) and Crawlgraph its own `Auth·CG` (a Common Crawl centrality percentile). These scales aren't comparable with Ahrefs DR.
- **Refresh profile** pulls from the API, priced before it runs and counted against your monthly unit cap.
- **No key?** Import a *Referring domains* export from Ahrefs or Semrush (Settings → SEO Metrics → Import, or the site's Settings tab). It fills exactly the same table.
- **Lost links come from diffing pulls.** The first pull has no lost rows. A filtered, partial or truncated pull marks nothing as lost, because it can't prove a link is gone. The UI says when a provider returned only a sample.
- **Lost-backlink alert** (Settings → Notifications): fires when a referring domain above a DR threshold disappears. It reads stored rows only, so enabling it costs nothing; it can only fire after a refresh.
- **DataForSEO weekly auto-refresh** (optional) keeps profiles current within your monthly cap; a small site costs about $0.05 a week. It also offers a 12-month history backfill and a weekly new/lost table.
- **Crawlgraph's tab** adds a between-releases changes panel (added / removed / authority-moved domains, one call) and a competitor gap job (one call, paid tier). The data is quarterly snapshots: every answer names its release, and "absent from the newer snapshot" is never treated as a lost link. Domain-level only — no anchors, so it feeds neither toxicity nor the per-link export.

Which provider to use: see [SEO Metrics Providers](SEO-Metrics-Providers). In short, Majestic and DataForSEO are the budget picks for links, Ahrefs is the reference, and Semrush's backlinks API is about 10× Ahrefs' price.

## Toxicity

Free: local math over rows you already loaded, plus optional "deep checks" (plain HTTP from your server to donors).

**Your niche matters.** A casino anchor from a casino donor is a normal topical link for a gambling site. So each site has an **own niche** setting (e.g. `gambling`). Marker groups in your niche aren't toxic for that site; everything else (pharma, adult, replicas, essay mills, foreign-script spam, hacked pages) is. If no niche is set, OpenGSC *suggests* one from your homepage, but you save it yourself.

Each donor gets a verdict from its signals (marker words in title/snippet/anchors, DR, content quality, anchor over-optimization at profile level), applied to all rows of that donor. With a Keys.so key you can pull Runet backlinks with anchors and re-score.

## Disavow

The Google Disavow file is built **only from links you marked by hand**, never automatically, each with its reason as a comment:

```
# OpenGSC disavow file for example.com — generated 2026-11-02
# Upload: https://search.google.com/search-console/disavow-links
# toxic · pharma, anchor_adult · 14 links
domain:spam-donor.example
```

Download it and upload it in Search Console's disavow tool yourself.

## Recovery

Lost links ranked by how much they were worth, so you know which one to win back first.

## MCP

`get_backlinks`, `get_backlink_profile`, `get_backlink_toxicity`, `get_disavow_file`. All are free local reads; agents never trigger a paid refresh.
