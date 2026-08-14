<div align="center">

<img src="logo.svg" alt="OpenGSC" width="88" />

# OpenGSC

**Your Google Search Console, all in one place — plus an AI SEO content suite and a private indexing network.**

Self-hosted on your own VPS. No subscriptions, no seat limits, no third party touching your data.

[![Version 1.4.1](https://img.shields.io/badge/version-1.4.1-brightgreen)](https://github.com/fenjo26/opengsc/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
![Self-hosted](https://img.shields.io/badge/deploy-self--hosted%20VPS-2ea44f)
[![GitHub stars](https://img.shields.io/github/stars/fenjo26/opengsc?style=flat)](https://github.com/fenjo26/opengsc/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/fenjo26/opengsc)](https://github.com/fenjo26/opengsc/issues)

[Русская версия](README.ru.md) · [English version](README.md)

[Website](https://opengsc.org) · [Install](#-installation) · [Features](#-features) · [SEO Tools](#-ai-seo-content-suite-seo-tools) · [Indexer](#-private-indexer-network) · [Docs](docs/)

</div>

<br/>

```bash
curl -fsSL https://raw.githubusercontent.com/fenjo26/opengsc/main/install.sh | sudo bash
```

<br/>

<div align="center">
<img src="screenshot/main%20dashbord.png" alt="OpenGSC main dashboard" width="90%" />
</div>

<br/>

## 🌍 Supported languages

OpenGSC's interface is available in **seven languages** — pick one from the language switcher on the login screen or in **Settings → Preferences**:

| Code | Language | Native name |
|------|----------|-------------|
| `en` | English | English 🇬🇧 |
| `ru` | Russian | Русский 🇷🇺 |
| `uk` | Ukrainian | Українська 🇺🇦 |
| `fr` | French | Français 🇫🇷 |
| `es` | Spanish | Español 🇪🇸 |
| `de` | German | Deutsch 🇩🇪 |
| `zh` | Simplified Chinese | 简体中文 🇨🇳 |

Telegram/Slack alerts and digests are sent in the same language you pick. SEO and Search Console terms that have no native equivalent (CTR, SEO, GSC, sitemap, canonical…) stay in English, the way practitioners use them.

<br/>

## Why OpenGSC

Tools like seogets.com charge **$19–$79/month** to show you the Google Search Console data you already own, aggregated across sites. OpenGSC gives you the same core analytics — clicks, impressions, CTR, position, striking-distance keywords, content decay, cannibalization — for the cost of a $5/month VPS, because it *is* the VPS: one install script, your own SQLite database, your own domain, your own Google OAuth app. Nothing about your Search Console data ever passes through a third-party server.

On top of that dashboard, OpenGSC ships two things most GSC tools don't: a full **AI-powered SEO content generation suite** (`/seo-tools` — competitor research, entity-driven outlines, full articles, GEO/AI-search-citation audits, brand sentiment tracking) and a **private indexing network** (`/indexer` — your own doorway-domain infrastructure with cloaked bot verification, for operators who need fast, free indexing outside of Search Console's normal discovery flow).

| | OpenGSC | Typical SaaS GSC dashboard |
|---|---|---|
| Price | Free forever | $19–$79/month |
| Hosting | Your own VPS | Their cloud |
| Data privacy | 100% private | Stored on their servers |
| Sites / Google accounts | Unlimited | Plan-limited |
| AI SEO content suite | ✓ included, your own API key | Rarely included |
| Private indexing network | ✓ included | Not offered |
| Open source | ✓ | ✗ |
| Setup time | ~5 minutes, one command | Instant sign-up |

**Trade-offs, honestly:** you need a VPS and a domain (Google OAuth won't work against a bare IP), you run your own updates (`git pull && npm run build && pm2 restart`), and there's no built-in team/white-label layer. If that's an acceptable trade for owning your data and never paying a subscription, read on.

**Signing in:** identity and data are separate. You sign in with an email and a password —
create the first account from the server console with `npm run create-owner -- --email you@example.com`
— while Google OAuth stays what it should be: the grant that pulls Search Console and Analytics
data in. The owner can also keep signing in with Google — after setting a password both work — while a
Google account that is not the owner's is refused rather than quietly attached. Lost the password? `npm run set-password -- --email you@example.com`
from the server.

**Support contract:** OpenGSC is a single-workspace application. One owner connects the Google
accounts and pays for every API key; team members are invited into that workspace with a role
(viewer, editor or admin) and sign in with an email and a password rather than Google, so nobody's
personal Search Console properties are pulled in. There is no multi-tenancy: one instance serves one
workspace. SQLite is the only fully supported production database; the MySQL/MariaDB notes are an
experimental porting guide with no promise of feature parity — see [`docs/TESTING-MYSQL.md`](docs/TESTING-MYSQL.md).

<br/>

## 📑 Table of Contents

- [Features](#-features)
  - [Unified GSC Dashboard](#unified-gsc-dashboard)
  - [Site Detail & Advanced SEO Analytics](#site-detail--advanced-seo-analytics)
  - [Google Analytics 4 & Microsoft Clarity](#google-analytics-4--microsoft-clarity)
  - [Rank Tracker](#rank-tracker)
  - [AEO Tracker — AI Answer Engine Visibility](#aeo-tracker--ai-answer-engine-visibility)
  - [Backlinks Checker](#backlinks-checker)
  - [Keyword Weights, Backlinks & Competitors](#keyword-weights-backlinks--competitors)
  - [Demand — Keyword Research & Domain Overview](#demand--keyword-research--domain-overview)
  - [Site Health Checks](#site-health-checks)
  - [Indexing Status Tools](#indexing-status-tools)
- [🧠 AI SEO Content Suite (`/seo-tools`)](#-ai-seo-content-suite-seo-tools)
  - Keyword Clustering · Outline Generator · Text Generator · Content Rewriter · **AI-Fingerprint Lab** · Googlebot View · Content Gap · Landing Builder · GEO Audit · Citations · Link Monitor · Editorial Policy · History
- [🕸️ Private Indexer Network](#-private-indexer-network)
- [Requirements](#requirements)
- [Installation](#-installation)
- [Manual Installation](#manual-installation)
- [Environment Variables](#environment-variables)
- [Managing the App](#managing-the-app)
- [Connecting Google Analytics 4](#connecting-google-analytics-4)
- [Setting Up the Indexer](#setting-up-the-indexer)
- [Troubleshooting](#troubleshooting)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Disclaimer](#disclaimer)
- [Contributing](#contributing)
- [License](#license)

<br/>

## ✨ Features

### Unified GSC Dashboard

- **One dashboard, every account** — every site from every connected Google account, on one screen, with a sparkline traffic chart per site.
- **Google · Bing · Yandex portfolio dashboards** — switch the entire dashboard between search engines with one click. Google reads from your local store; **Bing** and **Yandex** pull live from their Webmaster APIs across every connected account — showing *their own* verified sites (not just the Google list), the same KPI cards, per-site sparkline cards, sorting, search, tags, and CSV. Live engine results are cached server-side, so a tab opens instantly after the first build; the **Sync** button refreshes all three engines at once.
- **Fast period controls** — inline 7d / 28d / 3m / 6m / 12m / 16m buttons, plus Previous-period, Year-over-Year, or a fully custom range comparison.
- **Clicks / Impressions / CTR / Position** shown as labeled toggles, with an aggregate summary across every visible site that recalculates instantly when you filter by tag.
- **Tags, favorites, sorting, hiding** — organize hundreds of sites, remember your last sort order between sessions, pin the important projects, hide the dead ones.
- **Quick engine site search** — next to each site name, a small badge opens a `site:domain.com` search in a new tab for instant manual indexing checks; it follows the active tab (**G** → Google, **b** → Bing, **Я** → Yandex).
- **Portfolio SEO Analytics** — view aggregated Striking Distance keywords, Cannibalization, and Content Decay reports across your entire site network on the main dashboard.
- **Privacy Blur** — one click blurs every account name, email, domain, and metric — safe to screen-share or screenshot.
- **Ahrefs DR badges** — every site card (and the site detail header) shows the domain's Domain Rating, pulled from Ahrefs' free public endpoint and cached server-side for 7 days. No API key needed. *Domain Rating by [Ahrefs](https://ahrefs.com/).*
- **CSV export** with selectable dimensions, and **right-click → open in new tab** on any site card.

<div align="center">
<img src="screenshot/site%20dashbord.png" alt="Site dashboard" width="80%" />
</div>

### Site Detail & Advanced SEO Analytics

Every site gets its own deep-dive page with clicks/impressions/CTR/position trends, and four analyses that a stock GSC UI doesn't give you:

- **Striking Distance Keywords** — queries ranking position 4–20 with real impression volume: your fastest wins to page 1.
- **Keyword Cannibalization** — the original exact-query winner/loser report plus a separate **Related Intent** mode that finds different query formulations splitting visibility across your pages. It explains ranking-URL overlap, page roles, position gaps and daily winner changes, then suggests what to review—never an automatic merge, canonical or redirect.
- **Content Decay Map** — a heatmap of pages losing traffic over time, so you catch decay before it's a crisis.
- **CTR Benchmark** — your actual click-through rate vs. industry-standard CTR curves by position, surfacing pages where a better title/meta could unlock clicks you're currently leaving on the table.

<div align="center">
<img src="screenshot/data%20on%20site%20dashbord.png" alt="Site detail analytics" width="80%" /><br/>
<img src="screenshot/full%20analitics%20for%20contres.png" alt="Country breakdown analytics" width="80%" />
</div>

### Google Analytics 4 & Microsoft Clarity

Link a GA4 property to any site (sessions, engagement, key events, revenue with period-over-period deltas) and a Microsoft Clarity project (session recordings / heatmap stats, aggregated over 30 days) — both optional, both configured once per Google account, both fully documented in [`docs/GA4-SETUP.md`](docs/GA4-SETUP.md).

<div align="center">
<img src="screenshot/integration%20GA4%20and%20Clarity.png" alt="GA4 and Clarity integration" width="80%" />
</div>

### Rank Tracker

Track keyword rankings (country/language/device-aware) via your configured SERP provider (Serper, DataForSEO, or ScrapingRobot), checked on demand or daily, overlaid against real GSC average position, clicks, and impressions for the same query — so you can see whether a rank change actually moved traffic.

### AEO Tracker — AI Answer Engine Visibility

"Answer Engine Optimization": tracks whether **your site gets cited when real questions are asked to AI assistants**. All four engines — ChatGPT, Perplexity, Claude, Grok — are asked with **live web search on**, because an answer from a model's weights is not evidence about search visibility. Needs the API key(s) of whichever engines you want to track.

The check **shows its work**, which matters because you can always open ChatGPT in another tab and disagree with it. Expanding a question gives you the full answer the engine produced, every domain it cited with yours highlighted, your rank among them, the model that ran and whether a live search actually happened — so "not cited" is something you can read rather than a claim to take on faith. Verdicts are three-state: **cited** (linked), **mentioned** (named in the prose, no link) and absent. **"Cited instead of you"** counts the domains that came back across all your tracked questions — the pages your answer has to displace.

Per-site settings cover the model, country, city and answer language. Location is not decoration: answers to local questions are geolocated, so asking from the wrong country measures a market you don't sell in. Automatic daily checking is **off by default** — each question costs four billed calls on your own key, so a large portfolio never enrols itself.

Underneath it sits a **second source** with a different job. The tracker asks *your* questions live on *your* keys today; **Brand visibility** reads DataForSEO's index of what models have actually been answering — including questions you never thought to track. It shows how often the brand comes up, in which questions, which of your pages get cited, and **share of voice against up to 9 competitors**, which the live tracker structurally cannot produce because it only ever asks on your own behalf. Matching by domain finds answers that linked to you; matching by brand name finds answers that named you without a link. The index covers ChatGPT and Google AI Overview and refreshes roughly monthly, so the two panels are kept side by side and labelled rather than merged — a zero here is not evidence of invisibility to Claude.

### Backlinks Checker

A curated backlink inventory per site with liveness checks (is the link still there?) and indexed-status checks via XML River, rolled up into total / alive / dead / blocked / indexed counts. Liveness checks retry transient failures (5xx, rate limits, network drops) and distinguish a genuinely dead link from one a WAF/bot-protection layer refused to answer — so a Cloudflare 403 no longer reads as a dead backlink.

### Keyword Weights, Backlinks & Competitors

Search Console tells you how you are performing. It cannot tell you how much demand exists, how hard a keyword is to win, or who is winning instead of you. This module brings Ahrefs/Semrush data in and crosses it with your GSC data — which is where the value is, because neither source has the other half.

- **Keyword weights** in Striking Distance and Rank Tracker — search volume, KD, CPC, and a **Potential** column: what a keyword could bring near the top of page one minus what it brings now. Impressions are demand filtered through your current visibility; volume is the market itself.
- **Competitors** — pull a competitor's keywords and the join with your GSC data splits every row into three verdicts: *within reach* (you rank in the top 30 — improve that page, the URL is right there), *wrong page* (impressions but nothing wins — intent mismatch), *no content* (write it).
- **Backlink profile** — referring domains, live and lost, with stored history and a lost-link alert. Sits alongside the manual backlink list, which answers a different question: did the link *you* built survive.
- **Demand check in Content Decay** — clicks falling with demand flat is a ranking problem; clicks falling *with* demand is the market, and no rewrite fixes that.
- **Domain health in the Indexer** — DR and referring domains per network domain, before you build on a burnt drop.

**None of it requires an API key.** A CSV export from Ahrefs or Semrush fills exactly the same cache the API does (`SEO Tools → Import metrics`) — the report type is detected from the column headers. If you have a browser subscription, your exports are already paid for; the API is for what should refresh without a human.

When you do use an API key, every button prices itself before you press it, Keyword Difficulty is an opt-in checkbox (it roughly doubles the cost per keyword), and a monthly unit cap is enforced server-side. Nothing ever fetches on page load.

Setup and cost details: **[docs/METRICS-SETUP.md](docs/METRICS-SETUP.md)**. How the layer works
internally — provider routing, the price model, caching and where it is wired:
**[docs/METRICS.md](docs/METRICS.md)**.

### Demand — Keyword Research & Domain Overview

Every other screen in OpenGSC starts from queries you already appear for. **Demand** starts from the market, and it is the only place that can return a keyword Search Console has never heard of. It runs on the DataForSEO key you may already have configured for SERP — no new provider, no new subscription.

- **By keyword** — a seed goes to DataForSEO Labs and comes back as what people actually search, with volume, difficulty, CPC, intent and a 12-month trend sparkline. Then every row is answered by *your* GSC history: **within reach** (top 30 — improve that page, the URL is in the row), **wrong page** (you appear but nothing wins — intent mismatch), **no content** (write it). Ahrefs knows the first half of each row and Search Console knows the second; this is the only screen that holds both.
- **By domain** — type any domain and get its estimated organic traffic, keyword count, the distribution of those keywords across position bands, the terms actually bringing the traffic, and the pages carrying them. Works on domains you do not own — a competitor, a client you have not onboarded, a drop you are thinking of buying. Passing one of your sites adds a comparison column instead of being required.
- **Three discovery modes, one billed call.** `related` finds semantic neighbours, `suggestions` the long tail containing your seed, `ideas` the same meaning in different words. **Auto** walks them in order and stops at the first source with enough terms — it does not merge all three, because each one is a separate charge and the overlap is mostly duplicates.
- **Everything is cached and priced up front.** Searches are kept for 14 days and domain overviews for 7, so returning to a question you already paid for costs nothing. Every button shows its price before you press it, refined "clickstream" volumes are an opt-in checkbox that says it doubles the cost, and a monthly cap is enforced server-side.
- **Discovered keywords land in the shared metric cache**, so weights appear in Striking Distance and Rank Tracker for free — nobody pays twice for the same number.
- **Agents can use it too**: `get_keyword_demand` (free, reads what has been researched) and `research_keywords` (paid, gated behind `confirm: true`), plus a ready-made `keyword-research` skill in [`.agents/skills/`](.agents/skills/).

Without a DataForSEO key the tab still opens and shows whatever is already stored — the same "nothing is required" rule the rest of the app follows.

### Site Health Checks

One panel per site combining SSL certificate inspection (expiry, issuer, grade), a **Google Safe Browsing** blacklist check, a **VirusTotal** reputation check, and **Core Web Vitals** via the PageSpeed Insights API (mobile) — the latter three need their own free API keys, configured once in Settings.

### Site Audit — Built-in Crawler

A free technical audit with **zero external APIs**: OpenGSC crawls your site from your own VPS (up to 500 pages, BFS from the root) and reports broken internal links, missing/too-long/duplicate titles, missing meta descriptions, H1 problems, `noindex` pages, canonical mismatches, thin content, images without alt, slow responses, and client-rendered (JS) pages where static-HTML signals can't be trusted — rolled up into a health score with a filterable per-page table. Each audit also runs an **AI Crawlability** check: whether AI crawlers (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended, CCBot, Bytespider) are blocked in your `robots.txt`, and whether `/llms.txt` exists — a root `Disallow` on GPTBot is a silent reason an answer engine never cites you, surfaced here as a fixable diagnosis rather than just the symptom. Runs as a background job in the site's **Audit** tab; results are kept as audit history and exportable as Markdown.

### Alerts & Digests — Telegram Notifications

Bring your own Telegram bot (one-time @BotFather setup, token pasted in **Settings → Notifications**) and OpenGSC pushes what matters straight to your chat — free, no third-party service:

- **Alerts** (checked hourly, each event fires once): a tracked keyword fell N+ positions, a site's clicks dropped X%+ week-over-week, an SSL certificate is about to expire, a site audit came back with a low health score. Thresholds are configurable per rule.
- **Digests** (the **Digest** tab): a portfolio report over all sites *or one tag* — so a site network you care about gets its own summary. The on-screen view is **rich and full** (explicit date range, portfolio KPIs, biggest gainers/losers by site, rising/falling queries, *all* striking-distance queries, sites needing attention, rank movements — each section with "show all" and CSV), while **Telegram receives a shorter capped summary** (4 000-char safe). **Google / Bing / Yandex tabs** split the report per engine (engine tabs reuse the cached engine portfolio). An optional **AI conclusion** (your own AI key) is written on top and is **on by default when any AI key is configured**. Preview on screen, send on demand, or schedule daily/weekly delivery.
- A **Slack Incoming Webhook** can be connected alongside (or instead of) Telegram — alerts and digests go to every configured channel.

### Shared Dashboards — Read-Only Guest Links

Share a site's dashboard with a client without giving them an account: **site → Settings → Public Link** generates a tokenized read-only URL (`/share/…`). Guests see that one site's analytics and nothing else; the link can be regenerated or revoked at any time. Pairs well with Privacy Blur for screenshots.

### MCP Server — Connect AI Agents

OpenGSC ships a built-in **MCP (Model Context Protocol) server** at `/api/mcp` with **45 tools**, so Claude Code, Claude Desktop, Cursor, Codex, or any MCP client can work with your SEO data directly: sites, search performance, striking-distance keywords, cannibalization, content decay, CTR benchmarks, content groups, rank tracking and history, AEO visibility, GEO audits, backlinks, Link Monitor mentions and the manual Outreach Workspace, stored Source Audit findings, keyword demand and difficulty, competitor gaps, site health, indexing status, audit results, GA4, Clarity, Bing/Yandex portfolios, the indexer network, fired alerts, digests, generation history, and arbitrary read-only SQL. Generate a token under **Settings → API & MCP**, then:

```bash
claude mcp add --transport http opengsc https://your-domain.com/api/mcp \
  --header "Authorization: Bearer <token>"
```

Agents can also **optimize pages**, not just read about them. `get_optimization_brief` returns everything known about one URL in a single call — its queries, striking-distance keywords, CTR gaps, decay trend, cannibalization conflicts, audit issues and current content — the agent writes the new version itself, and `analyze_text` verifies it deterministically: uniqueness, heading-structure drift, and any number or brand that appears in the draft but not the source. No model is called for that check, so it costs nothing and always returns the same answer.

Every tool declares what calling it costs, and `get_capabilities` reports the grouping: **local** (free and instant, 37 of the 45; four Outreach actions are explicitly marked as local writes), **quota** (calls Google on your own OAuth), **net** (fetches a page), and **paid** (spends your own credits). The three paid tools — the app's own Content Rewriter, the full article pipeline, and keyword discovery — refuse to run without an explicit `confirm: true`, so an agent exploring the registry can never bill you by accident. The two AI ones are asynchronous: they return a job id and save each finished page as it completes, so a client timeout or a server restart can never discard work you have already paid for. Keyword discovery is synchronous because it does not need to be — it writes its result to the cache before returning, so an abandoned call still leaves a search that replays for free.

The repo also ships ready-made **agent skills** in [`.agents/skills/`](.agents/skills/) (performance review, page optimization, article production, link prospecting, AEO review, site triage) — copy them into your agent's skills folder for guided SEO workflows. Details: [`docs/MCP-SETUP.md`](docs/MCP-SETUP.md).

### Indexing Status Tools

Inside each site's "Indexing" tab: a persistent **Sitemap Inventory** (recursive sitemap indexes, gzip and image/video/news extensions, up to 20k URLs) with source sitemap, `lastmod`, first/last seen, added/changed/disappeared diff, explicit page-metadata verification and Site Audit coverage. A URL is only called disappeared after two complete syncs miss it; a failed or partial child-sitemap run never advances that state. The same table keeps genuine **Google URL Inspection API** checks through your own OAuth token and three optional paid accelerators for URLs that need a push — **2index.ninja** submission, **NeuralIndexer** (queued slow/fast/Yandex indexing with balance/job polling), and **XML River** index-status verification. Each accelerator is opt-in and needs its own account/API key. A separate, explicit “Audit from sitemap” action seeds the existing Site Audit crawler with active inventory URLs so orphan candidates can be found without merging the two tools.

It also includes built-in free integrations:
- **IndexNow Integration** — push new or updated URLs dynamically to the IndexNow API protocol in one click for instant crawler notification (supported by Bing, Yandex, etc.).
- **Bing Webmaster Tools** — an engine switcher on the site dashboard shows a full live Bing view next to your GSC data: clicks, impressions, CTR, weighted avg position, traffic chart, top queries, top pages, pages in the Bing index and crawl errors — plus sitemap submission (API or ping) from the Indexing tab.
- **Yandex.Webmaster** — the same switcher shows the full live Yandex view: SQI (ИКС), pages in search/excluded, clicks/impressions chart, top queries with positions, and Yandex's own site diagnostics (FATAL/CRITICAL problems) — plus sitemap submission and quota-aware URL recrawl via your own OAuth token. The Sync button refreshes every connected engine at once. Setup: [`docs/SEARCH-ENGINES-SETUP.md`](docs/SEARCH-ENGINES-SETUP.md).
- **Smart Sitemap URL inspection fallback** — if a newly added site has no Search Console traffic or ranking query history, the inspection tool automatically crawls and retrieves up to 20 URLs from the site's `sitemap.xml` (or custom sitemap location) to inspect them.

<br/>

## 🧠 AI SEO Content Suite (`/seo-tools`)

A full competitor-research-to-published-article pipeline, plus AI-search-visibility auditing — all under one settings screen for your AI/SERP/scraping keys. Everything here is optional and needs **your own** API key (Anthropic, Z.AI, OpenAI, Gemini, OpenRouter, Kimi/Moonshot, kie.ai, or any custom OpenAI-compatible endpoint) — pay-per-use at cost, no markup. Each provider card in Settings lets you pick the exact model from a live list fetched from the provider's API.

**Which model runs where is yours to decide, and visible while you decide it.** Every AI job in the suite is a named *task* — article structure, body text, landing copy, content analysis, editorial policy, and the short utility passes whose output is parsed rather than read. Each one can take its own provider and model, chosen from your account's live model list, or inherit the suite-wide default. The header of every tool names the model that will actually run and expands to show each task it performs, what that task does, and **which settings level the value came from** — so an override that appears not to have taken can be diagnosed from the screen instead of by reading the source. Nothing is pinned to a model id inside the code: defaults are expressed as an intention (best available / everyday / cheap) and resolved against what your account currently offers, so they don't quietly go a generation stale when a provider ships something new.

<div align="center">
<img src="screenshot/seo%20tools.png" alt="SEO Tools suite" width="80%" />
</div>

<details open>
<summary><b>Keyword Clustering</b> — SERP-based topic grouping</summary>
<br/>

Paste a keyword list and OpenGSC pulls a live TOP-10 SERP for each keyword, then hard-clusters keywords whose results share N+ overlapping URLs (threshold selectable, with an in-context guide) — the classic "one cluster = one page" planning method, grounded in what Google actually ranks together rather than semantic guesswork. Optional DataForSEO search volumes per keyword, CSV export, and a one-click handoff of any cluster straight into the Outline Generator. Runs as a background job — close the tab, the result lands in History.
</details>

<details open>
<summary><b>Outline Generator</b> — competitor-grounded content briefs</summary>
<br/>

Enter a keyword, target country/language, and search engine (Google or Bing). OpenGSC runs a live SERP query, classifies every ranking page by site type (official store, monobrand, aggregator, forum/UGC, editorial) and intent (buy / info / review / listicle / use-case), lets you pick which competitors to analyze, scrapes them (direct fetch, falling back to Firecrawl on anti-bot pages), and runs a multi-pass pipeline:

1. **MAP** — extract compact, verified facts from each competitor separately (specs, prices, entities, headings covered).
2. **REDUCE** — build one Entity-Attribute-Value (EAV) outline from those facts: headings, per-section word budgets, weighted entities with roles, keywords, FAQ, visual-element suggestions (tables/infographics/checklists).
3. **Fact-scrub** — an LLM pass actively corrects fabricated-looking specifics (wrong screen size, invented colors, wrong dates) *before* they can leak into the article.
4. **Structure-expand** — grafts extra H3 subsections under headings that came back too flat.
5. **Heading-localize** — translates/styles template headings into the article's actual language and narration voice.
6. **Volume-normalize** — rescales every section's word budget so they actually sum to your target length.
7. **Section-enrich** — deepens every section's entities/summary/copywriter-notes in parallel batches, so the outline reads like a real creative brief, not a skeleton.

Optional: a **Casino RAG** toggle grounds igaming-niche outlines (slots, casino brands) against a verified knowledge base of RTP/volatility/provider/launch-date facts, virtually eliminating hallucinated specs in that niche.
</details>

<details open>
<summary><b>Text Generator</b> — full articles from an outline</summary>
<br/>

Takes any outline from History and writes the complete article as a background job (close the tab, come back later). Long outlines are written in small chunks (3–5 sections per model call, run in parallel) rather than one giant prompt — this keeps prose quality consistent instead of degrading into bullet-point sludge halfway through a 3,000-word article. Supports tone/persona, an editorial Policy, a table of contents, and three source-grounding modes: off, facts-only (real numbers, no competitor names/links), or cited (real numbers with inline source links, rate-limited to one link per 1-2 paragraphs).

A **volume guard** keeps the final word count within your target (±15%): expand thin drafts, iteratively trim bloated ones — and it runs as the *very last* step, after fact-checking, so a fact-correction pass can never silently re-inflate an article that was already trimmed to length. Failures surface a real reason (e.g. a provider's content-policy rejection) instead of a bare "generation failed."

Optional **sampling controls** (both off by default, so existing runs are unchanged): a **temperature** field — warned above 1.2 and flagged red at 1.5, where output degrades into nonsense — and a **ban-markers** toggle that injects the vocabulary from your AI-Fingerprint model as forbidden words. Because chunks are separate model calls, the temperature is nudged per chunk by a small deterministic offset, so the finished article isn't the product of one uniform sampling pass. On the Outline step temperature is capped at 0.8 and the parse-retry drops to 0 — outlines must return valid JSON, and sampling randomness is exactly what breaks that.
</details>

<details open>
<summary><b>Content Rewriter</b> — refresh & de-duplicate pages into unique variants</summary>
<br/>

Paste text or a **page URL** (auto-scraped) and get **N unique variants** (1–5) that keep the exact meaning, facts, numbers, entities, and links while rewording everything — same format in, same format out (HTML→HTML, Markdown→Markdown). Each variant shows a **uniqueness score** (word-trigram similarity vs. the source), a word count, and — when a fingerprint model is trained — an **AI score**, with copy / download. Optional target **language**, **tone**, **temperature**, and a **ban-markers** toggle that forbids the AI-leaning vocabulary from your fingerprint model. A **"mask AI patterns"** toggle strips common machine tells (em-dashes, "furthermore", "it is important to note", unicode bullets…) — scoped honestly at readability for a human editor, not as anti-detection: substituting phrases in a finished text does not move a statistical detector.

Every variant is checked for **fact drift** — a deterministic diff of numbers, amounts, percentages and identifier-shaped names (RTP, MegaWays, iPhone) between source and rewrite. Values that **appeared** but weren't in the source are flagged red (an invented number is what ships and gets published); values that were **dropped** are flagged amber. Currencies are normalized, so `$50`, `50 USD` and `50 долларов` count as the same amount and locale digit separators never register as a false alarm. No model call, no cost. It verifies values, not claims — and says so.

Runs on **your own** multi-provider AI (Anthropic / OpenAI / Kimi / …). Wired into **Content Decay**: every decaying page has a one-click **Rewrite** action that opens the tool with its URL prefilled — spot a page losing traffic, refresh it in seconds. Built for large affiliate networks where duplicate content across sites is a real risk.
</details>

<details open>
<summary><b>AI-Fingerprint Lab</b> — measure how machine-written your text reads, and fix it at the source</summary>
<br/>

Modern statistical AI detectors don't read style — they score the **token frequency distribution over ~300-word windows**. That makes the signal reproducible locally, so this tool trains a bag-of-words discriminator **on your own two corpora**: competitor pages pulled from the SERP as the human reference, your own generation History as the machine reference. No third-party detector API, no subscription, no text leaving your server. Pure TypeScript, zero dependencies, works in any alphabet.

Three tabs:

- **Analyze** — score any text or a saved article: an averaged score, a **per-window heatmap** (an average hides a piece that's half clean and half obvious), the **marker vocabulary** that actually moved the score, and the human-leaning words your text never uses. A **Humanize** action rewrites the text with those markers banned, scores three variants, and shows the before → after delta.
- **Corpus** — harvest the human reference by keyword or URL list, train, and keep several named models. A model is bound to its niche and language, so train one per niche; the UI reports a held-out **separation** score so a weak model is visibly weak rather than quietly wrong.
- **Bench** — run the same prompt across your configured models and temperatures and rank the results. This is the point of the tool: model choice dominates every prompt-side trick, and published model comparisons go stale within months, so the useful move is measuring the models *you* hold keys for.

The score is the least interesting output. The **marker list is the payload**: exporting it bans that vocabulary at generation time, which is where a word list actually changes anything — reworking a finished text barely moves a statistical detector, and the tool says so, in context, when a rewrite underdelivers.

Two safeguards, because this vocabulary goes straight into a generation prompt. Words used by **40%+ of competitor pages** are treated as niche terminology and never suggested — banning terms the whole niche uses doesn't make text human, it makes the model talk around words the article needs. And the full list is **reviewable before it applies**: click any word to keep it allowed, and the exclusion sticks to that model across retraining.
</details>

<details open>
<summary><b>Googlebot View</b> — cloaking & PBN inspector for competitors</summary>
<br/>

"See" any page the way Google's crawler does and catch what a normal browser visit hides. The tool fetches the same URL with several **User-Agents** (Googlebot smartphone, Googlebot desktop, a real browser, optionally Googlebot + SERP `Referer`), manually walks each **redirect chain** hop-by-hop, and **diffs** the responses to flag **cloaking, hidden redirects, and PBN schemes** — with a clear verdict banner (*clean / suspicious / cloaking*) and a comparison table of final status, final URL, canonical (HTML vs `X-Robots-Tag`), meta robots, hreflang, JS redirects (`meta refresh` / `window.location`), content volume, and indexability. For your **own** GSC-verified sites it adds a **True Google View** — Google's real verdict via the URL Inspection API (`googleCanonical` vs `userCanonical`, robots state, last crawl) — plus an optional Wayback snapshot. Honest technical model: it compares User-Agents (nobody can send requests "from Google's IPs"). Spec: [`docs/GOOGLEBOT-VIEW-SPEC.md`](docs/GOOGLEBOT-VIEW-SPEC.md).
</details>

<details open>
<summary><b>Content Gap Analysis</b> — what your page is missing</summary>
<br/>

Point it at a keyword and (optionally) your existing URL. It pulls the SERP, scrapes the competitors you pick, and returns a structured gap report: topics, entities, and whole sections competitors cover that your page doesn't — each gap tagged with a recommendation (add / expand / merge / skip) and the specific competitor URLs that justify it. For improving a page you already have, rather than starting from zero.
</details>

<details open>
<summary><b>Landing Page Builder</b> — briefs, wireframes, and text for commercial pages</summary>
<br/>

The same SERP → select → scrape research flow as Outline, aimed at conversion pages instead of articles. Four structuring strategies: mirror the SERP consensus, copy your own existing page 1:1, a hybrid of both, or an "SEO-block" layout (conversion blocks up top, a deep SEO text block underneath). Generates a technical brief (ТЗ), the brief plus full text, or a complete block-by-block wireframe (hero / USP bar / comparison table / FAQ / CTA, etc.). Distinctive: you can import your own page's structure either from its live HTML or — for non-technical users — from **a screenshot**, read by a vision-capable model.
</details>

<details open>
<summary><b>GEO Audit</b> — Generative Engine Optimization</summary>
<br/>

Traditional rank tracking tells you nothing about whether an AI assistant recommends you. GEO Audit sends a real user question to an AI model with **live web-search tool-use enabled** and mines the model's own search trace and citations to answer: which brands/domains actually get surfaced and cited for this query, what "selection factors" drove the answer (pricing, support, feature breadth…), which source types dominate (official sites, marketplaces, review aggregators, forums, Wikipedia, editorial), and where your own coverage gaps are. Output is a brand leaderboard, a per-domain trust-signal table, a source-type breakdown, and narrative insight into what a brand needs to do to get cited. Runs on OpenAI or kie.ai only — no separate SERP key needed, since search happens inside the model's own tool call. Full history is persisted server-side.
</details>

<details open>
<summary><b>Citation & Sentiment Tracker</b> — brand mentions across the web</summary>
<br/>

Not to be confused with GEO's AI-citation tracking — this tracks classic web-wide brand/keyword mentions and their sentiment, via DataForSEO's Content Analysis API: polarity (positive/neutral/negative), six emotion dimensions (anger, happiness, love, sadness, share, fun), a monthly mention trend, and the top citing domains. Needs only a DataForSEO key.
</details>

<details open>
<summary><b>Link Monitor</b> — competitor backlink watchlist (Ahrefs API)</summary>
<br/>

Watch any set of competitor brand domains and pull their **fresh quality backlinks** through your own Ahrefs API v3 key, filtered the way link-building pros do (the [detailed.com](https://detailed.com/ai-backlinks-api/) workflow): in-content links only, live, DR ≥ 50 (configurable), first seen within the last 3 months, one per referring domain. The report surfaces **multi-linker domains** — sites that link to two or more of your watched brands, i.e. your highest-probability outreach targets — plus an AI insights pass over the data: which content types earn links, in what context authors mention the brands, anchor patterns, and concrete content/PR opportunities. Save any result into the built-in **Outreach Workspace** to track campaigns, evidence, contacts, follow-ups, stage history, conversion and the backlink eventually won. OpenGSC can prepare a localized pitch draft, but never sends it automatically. Not to be confused with the per-site **Backlinks Checker** above, which tracks *your own* curated link inventory.
</details>

<details open>
<summary><b>Competitor Crawler</b> — X-ray any site on the internet, and find out who else owns it</summary>
<br/>

Point it at a competitor and get their homepage judged by the same rule registry your own audits use, plus what the site is built with (CMS, framework, WordPress theme and plugin slugs, exposed usernames, a reachable `xmlrpc.php`), where it runs (A/AAAA, nameservers, MX, CDN), how big it is (sitemap URL count, hreflang languages), and whether AI crawlers are allowed in.

Then the part a single-site checker cannot do. Every scan records the identity signals a site leaks — **GA4, Universal Analytics, Tag Manager, AdSense, Yandex Metrica, Meta Pixel, Hotjar, Clarity, nameservers, IPs** — and matches each new scan against every earlier one. An analytics property or an ads publisher id is billed to one person, so an overlap there is reported as **strong** evidence that two domains share an owner; a shared nameserver or IP only means a shared host and is marked **weak**. Redirect targets are stored as well, which is how a dropped domain merged into another gives itself away. Build up a scan history and a private network stops being invisible.

One page per scan, plus the paths every site publishes anyway (robots.txt, sitemap, llms.txt). Nothing is brute-forced and no credential is tried — the WordPress paths are requested only when the page already looks like WordPress.
</details>

<details open>
<summary><b>Content Operations & Source Audit</b> — review drafts, ship PRs, check code before deployment</summary>
<br/>

*New in 1.4.0 — the first release where OpenGSC writes to a system outside itself. Connect a scratch repository first and watch one item go through end to end.*

Move an existing draft through an explicit idea → approval → review workflow, preview a deterministic diff, and create a GitHub branch and pull request only after confirmation. OpenGSC never writes to the base branch and never auto-merges. The same connected repository has a separate, **read-only Source Audit** tab: choose a branch and run bounded Next.js SEO, performance, correctness, security and architecture checks against its immutable commit snapshot. Up to 80 files / 4 MB are inspected in memory; source bodies and secret values are not stored, and any safety-limit truncation is visible in the report.

Source Audit checks repository code before deployment. It does **not** replace or merge data with the runtime **Site Audit**, **AI Visibility**, or **SEO Tools → GEO** — those remain separate tools with their own settings, reports and logic.

After the merge the loop actually closes. A merged pull request is not a deployment, so OpenGSC fetches the target URL itself and starts measuring only on a real HTTP 200 — then links the page into **Indexing** and, when the item has a keyword, into the **Rank Tracker**. Outcome windows open on the live date and close at **7, 30 and 90 days**, each captured once from your own Search Console rows against a 28-day baseline, with the reporting lag accounted for: an empty row means *not measured yet*, never zero traffic. Nothing is auto-submitted to a paid indexer, and nothing is merged for you.
</details>

<details open>
<summary><b>Editorial Policy</b> — one style guide, applied everywhere</summary>
<br/>

Define — or have AI draft, grounded in your own brand pages — a reusable editorial policy: brand description and values, audience profile, voice/tone/formality, structural rules (headings, paragraph length, lists vs. tables), quality bar (citation style, E-E-A-T notes, fact-checking behavior), and hard restrictions (banned words/topics, compliance rules like "never fabricate a license — leave a placeholder instead"). Save up to 10, mark one active, and it's applied automatically across Outline, Text, and Landing generation. The AI-Fingerprint Lab can push its marker vocabulary straight into a policy's banned-words list.

One thing these prompts deliberately **do not** contain: instructions on *how* to write ("sound natural", "vary your sentence length", "avoid AI clichés"). A/B testing shows such directives backfire — the model applies them as formal rules, which narrows its output distribution and makes the text read *more* machine-typical, not less. Naming concrete words to avoid carries none of that failure mode, which is why the banned-word list is the mechanism here.
</details>

<details open>
<summary><b>History</b> — every generation, resumable</summary>
<br/>

A unified log across Cluster, Outline, Text, Analysis, and Landing runs. Generation jobs run server-side and fire-and-forget, so you can close the tab; History polls for completed jobs, auto-imports them, and auto-fails anything stuck "processing" for more than 20 minutes so nothing spins forever. When an AI-Fingerprint model is active, every stored article carries its **AI score** right in the list, so you can see which generations read machine-written without opening them. History — along with your API keys, provider/model choices, and Editorial Policies — is **automatically backed up server-side**, so clearing browser data or switching browsers no longer loses your generations or settings: everything is restored on the next page load.
</details>

<br/>

## 🕸️ Private Indexer Network

A self-hosted **doorway-domain network** for operators who need pages indexed fast and for free, outside the normal discovery flow Search Console relies on. You bring the domains; OpenGSC gives you the management console, the cloaking script, and the crawl-analytics to run them safely.

- **Domains** — register a doorway domain, pick a generated-content template (Ecommerce / Directory / Blog / Portfolio), set the real "money site" redirect target, choose which bots are allowed in (Google / Bing / Yandex), and get a unique API key per domain.
- **Queue** — bulk-paste the money-site URLs that should be woven as internal links into the next batch of generated doorway pages.
- **Dictionary** — a keyword pool that seasons generated content, built manually or AI-generated per niche (ecommerce / crypto / finance / general).
- **Links** — a visual cross-linking planner: pick a topology (ring / mesh / pyramid) across your owned domains, see an SVG node graph, export the HTML link snippet.
- **Settings** — the deployment hub: generates ready-to-paste code in four flavors — dynamic PHP doorway, static PHP wrapper, an Astro SSR middleware, or an Nginx config that routes bots to `index.php` while serving humans static files directly.
- **Stats** — a 30-day dashboard: hits by bot (Google / Yandex / Bing / Mail.ru / other / redirected humans), a stacked area chart, per-domain Google-hit-share, and a `304 Not Modified` breakdown that tells you how efficiently each bot is re-checking pages without burning crawl budget. CSV export included.
- **Logs** — a raw, filterable, optionally live-polling crawl log (time, domain, path, IP, detected bot, HTTP status).

**How the cloaking works:** the deployed script identifies bots by user-agent, then — if strict verification is on — runs a **double DNS lookup**: a reverse lookup of the visitor's IP must resolve to a known suffix (`googlebot.com`, `yandex.ru`, `search.msn.com`, `mail.ru`), and a forward lookup of *that* hostname must resolve back to the exact same IP. This defeats spoofed user-agents, since an attacker can't fake a PTR record inside Google's or Yandex's own IP ranges. Verified bots get a generated page (with ETag-based `304` short-circuiting on repeat crawls) and a logging ping; everyone else — humans and fake bots alike — gets redirected straight to the real site, so the doorway is invisible to anyone outside the whitelisted crawlers. Full setup walkthrough: [`docs/INDEXER-SETUP.md`](docs/INDEXER-SETUP.md).

> ⚠️ See [Disclaimer](#disclaimer) — doorway/cloaking techniques sit outside major search engines' webmaster guidelines. This is a power-user tool; understand the risk to a domain before pointing it at anything you can't afford to lose.

<br/>

## Requirements

| Parameter | Minimum | Recommended |
|---|---|---|
| **OS** | Ubuntu 22.04 LTS | Ubuntu 22.04 / 24.04 LTS |
| **CPU** | 1 vCPU | 2 vCPU |
| **RAM** | 1 GB | 2 GB |
| **Disk** | 10 GB SSD | 20 GB SSD |
| **Domain** | **Required** | With SSL (Let's Encrypt) |
| **Node.js** | 22 LTS | 24 LTS (installed for you) |

> Node.js, PM2, Nginx, and every dependency are installed **automatically** by the script — nothing to set up by hand.

> ⚠️ **A domain is required.** Google OAuth does not work against a bare IP address. Point a domain at your server's IP before installing.

Tested on **Ubuntu 22.04 LTS**; other Debian-based distros also work. CentOS/RHEL and Windows are not supported.

<br/>

## 🚀 Installation

> **Prefer Docker?** `cp .env.template .env`, fill it in, `docker compose up -d` — full guide in [`docs/DOCKER-SETUP.md`](docs/DOCKER-SETUP.md). The steps below cover the recommended one-line VPS install.

### 1. Create a Google OAuth app (~5 minutes)

Every step below is a direct link that opens exactly the right page in Google Cloud Console. Sign in with the Google account that owns your Search Console sites.

1. **Create a project** (or reuse one): [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate). Any name works, e.g. `opengsc`. Make sure this project stays selected in the top bar for all following steps.
2. **Enable the Search Console API**: open [console.cloud.google.com/apis/library/searchconsole.googleapis.com](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com) and click **Enable**.
3. **Configure the OAuth consent screen** (required once before creating credentials): open [console.cloud.google.com/auth/branding](https://console.cloud.google.com/auth/branding). Choose **External**, fill in the app name and your email — defaults are fine everywhere else. Then open [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience) and add your own Google account (plus any accounts whose GSC sites you'll connect) under **Test users**.
4. **Create the OAuth client**: open [console.cloud.google.com/auth/clients/create](https://console.cloud.google.com/auth/clients/create) (the same page is reachable via **Credentials → Create Credentials → OAuth client ID** at [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)). Application type: **Web application**. Fill in:

   | Field | Value |
   |---|---|
   | Authorized JavaScript origins | `https://your-domain.com` |
   | Authorized redirect URIs | `https://your-domain.com/api/auth/callback/google` |

   > **Note:** Google does not accept bare IP addresses here — a domain is required (the only exception is `http://localhost` for local development). Any subdomain you control works fine, e.g. `gsc.your-domain.com`.
5. Copy the **Client ID** and **Client Secret** from the confirmation dialog — the installer asks for both. You can always find them again at [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).

> **Tip:** if sign-in later fails with `access_denied`, your account isn't in Test users (step 3) — either add it there, or publish the app on the same page (**Publish app**).

### 2. Run the one-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/fenjo26/opengsc/main/install.sh | sudo bash
```

The script clones the repo into `/root/opengsc`, then asks for: your domain, whether to install Nginx (recommended), whether to set up SSL via Let's Encrypt (recommended), an email for the SSL cert, and your Google Client ID/Secret. It then automatically installs Node.js 24 LTS, installs PM2 and runs the app as a managed service, configures Nginx as a reverse proxy, issues an SSL certificate via Certbot, and configures the UFW firewall (ports 22/80/443).

### 3. Open it

```
https://your-domain.com
```

Sign in with Google — the **first account becomes the dashboard owner**. Add more Google accounts under **Settings → My Google Accounts**; their sites appear on the dashboard automatically.

<br/>

## Manual Installation

<details>
<summary>Prefer to set everything up yourself? Click to expand.</summary>
<br/>

```bash
# Clone
git clone https://github.com/fenjo26/opengsc.git
cd opengsc

# Node.js 24 (Active LTS — Node 20 reached end of life in April 2026)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs

# PM2
npm install -g pm2

# Project dependencies
npm install

# .env — copy the template and fill it in
cp .env.template .env
nano .env

# Database & build
npx prisma generate
npx prisma db push
npm run build

# Run
pm2 start npm --name opengsc -- start
pm2 save
pm2 startup
```
</details>

<br/>

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Path to the SQLite database | `file:/root/opengsc/data/prod.db` |
| `NEXTAUTH_SECRET` | Random secret used to encrypt sessions | `openssl rand -base64 32` |
| `CONTENT_OPS_SECRET` | Optional stable key for Content Operations GitHub-token encryption; falls back to `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `OPENGSC_ALLOW_PRIVATE_TARGETS` | Optional. Allows owner-driven audits of localhost/LAN targets, which are blocked by default as SSRF protection. The public Free SEO Checker ignores it | `1` |
| `NEXTAUTH_URL` | The app's full URL, including domain | `https://your-domain.com` |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console | `123...apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console | `GOCSPX-...` |

> `NEXTAUTH_URL` must **exactly match** the Authorized redirect URI in Google Console, down to `http://` vs `https://`. A mismatch causes `redirect_uri_mismatch`.

Generate a secret:
```bash
openssl rand -base64 32
```

If Content Operations is connected to GitHub, keep `CONTENT_OPS_SECRET` (or the fallback
`NEXTAUTH_SECRET`) stable across restarts and upgrades. Repository tokens are encrypted with it;
the token is never returned by the API or exposed to MCP.

<br/>

## Managing the App

```bash
pm2 logs opengsc       # view logs
pm2 restart opengsc    # restart
pm2 stop opengsc       # stop
pm2 status             # status of all processes
```

### Updating to a new version

**From the UI (easiest):** when a newer version is on `main`, a **"New version available"** bar appears at the top of the dashboard. Click **Update** → **Start update** and OpenGSC runs the whole upgrade on your server (fetch, install, migrate, rebuild, restart), streaming the log live; when it's done it prompts a page reload. The update button is owner-only and never shown to guests.

**By hand (or for Docker):**

```bash
cd /root/opengsc
bash update.sh
```
`update.sh` is the same script the UI button runs: it backs up the SQLite database first (before touching the working tree), fetches and hard-resets to `origin/main`, installs deps with `--include=dev` (plain `npm install` silently skips Tailwind/TypeScript when `NODE_ENV=production`, which PM2 sets — the build then fails on the first stylesheet), pushes the Prisma schema, builds, and restarts PM2.

**If the update hangs or fails (UI or SSH):** the SQLite backup step has a hard 10-minute ceiling — a normal backup finishes in well under a second (`VACUUM INTO` on the live db), so if it's stuck there for minutes, the database has likely grown large because `IndexerLog` (raw indexer/crawler request logs) is never rolled up automatically. Roll it up by hand before retrying:
```bash
cd /root/opengsc
node scripts/rollup-logs.ts
```
⚠️ This permanently deletes all raw `IndexerLog` rows except the latest 5,000 (the aggregated daily stats in `IndexerDailyStat` are kept, so charts aren't affected).

If `update.sh` itself is unavailable, the equivalent steps by hand are:
```bash
cd /root/opengsc
git fetch origin
node scripts/backup-sqlite.mjs   # back up before touching the working tree
git reset --hard origin/main
npm i --include=dev
npx prisma db push
npm run build
pm2 restart opengsc --update-env
```

<br/>

## Connecting Google Analytics 4

The **GA4** tab on a site card shows real Google Analytics data — sessions, engagement, key events, and revenue, with period-over-period trends. It's fully optional: the dashboard and GSC work without it. If the GA4 tab is empty, the app shows an in-context step-by-step guide with buttons to enable the right APIs — the same steps are detailed in [`docs/GA4-SETUP.md`](docs/GA4-SETUP.md), including common errors like `insufficient authentication scopes` and `API has not been used in project ... or it is disabled`.

Short version: enable the **Google Analytics Data API** and **Google Analytics Admin API** in the same Google Cloud project as your OAuth client, reconnect your Google account under **Settings → My Google Accounts** so it picks up the new `analytics.readonly` scope, make sure that account has at least Viewer access to the GA4 property in question, then link the property from the site's **GA4** tab.

<br/>

## Setting Up the Indexer

The Indexer ships disabled by default — it's an advanced, opt-in module. Full walkthrough (domain setup, script deployment for PHP/Astro/Nginx, DNS verification behavior, and safe operating practices) lives in [`docs/INDEXER-SETUP.md`](docs/INDEXER-SETUP.md).

<br/>

## Troubleshooting

<details>
<summary><b>GA4 tab is empty with <code>... API has not been used in project ... or it is disabled</code></b></summary>
<br/>
The required Google API isn't enabled. Enable <b>Google Analytics Data API</b> and <b>Google Analytics Admin API</b> in the same Google Cloud project as your OAuth Client ID (links in <a href="#connecting-google-analytics-4">Connecting Google Analytics 4</a>), wait 1–2 minutes, and refresh.
</details>

<details>
<summary><b>GA4 tab shows <code>insufficient authentication scopes</code></b></summary>
<br/>
The account hasn't been granted Analytics access. Reconnect it under <b>Settings → My Google Accounts</b> — after re-authenticating, the account shows a <b>GA4 ✓</b> badge.
</details>

<details>
<summary><b>GA4 property list is empty even though the APIs are enabled and access is granted</b></summary>
<br/>
That Google account doesn't have access to the GA4 property itself. Add its email under <b>Google Analytics → Admin → Property Access Management</b> with at least the Viewer role.
</details>

<details>
<summary><b><code>redirect_uri_mismatch</code> when signing in with Google</b></summary>
<br/>
<code>NEXTAUTH_URL</code> in <code>.env</code> doesn't match the Authorized redirect URI in Google Console. They must be identical, including <code>http://</code> vs <code>https://</code>. The redirect URI must be <code>https://your-domain.com/api/auth/callback/google</code>.
</details>

<details>
<summary><b>Infinite redirect to <code>/login</code> after signing in</b></summary>
<br/>
Check <code>NEXTAUTH_URL</code> in <code>.env</code> — it must match your domain and protocol exactly, and the SSL certificate must be valid.
</details>

<details>
<summary><b>Database disappeared after a restart</b></summary>
<br/>
Use an absolute path in <code>DATABASE_URL</code>, not a relative one. The installer sets this automatically (<code>file:/root/opengsc/data/prod.db</code>); on a manual install, set it explicitly.
</details>

<details>
<summary><b><code>pm2 restart opengsc</code> doesn't pick up changes after <code>git pull</code></b></summary>
<br/>
Rebuild first:

```bash
npm run build && pm2 restart opengsc
```
</details>

<details>
<summary><b>Text generation fails with <code>generation_failed</code></b></summary>
<br/>
Check <code>pm2 logs opengsc</code> for a line starting with <code>[LLM]</code> — it carries the real provider status/error (invalid key, exhausted quota, a context-length limit on a very large outline, or the provider's own content-policy filter rejecting the topic). As of the latest version this reason is also surfaced directly in the job's error in History, so you shouldn't need to check server logs for most failures.
</details>

<br/>

## Tech Stack

- **[Next.js 16](https://nextjs.org/)** (App Router) + **React 19** + **TypeScript**
- **Prisma 7** + **SQLite** (single-file database, zero external DB server)
- **NextAuth v4** — Google OAuth authentication
- **Recharts** — charts and graphs
- **Google Search Console API** / **Google Analytics Data & Admin APIs** — first-party data sources
- **Anthropic / Z.AI / OpenAI / Gemini / OpenRouter / Kimi (Moonshot) / kie.ai** — pluggable AI providers for the SEO Tools suite
- **MCP server** (`/api/mcp`) — connect Claude Code / Claude Desktop / Cursor / any MCP client to your data
- **Serper / DataForSEO / ScrapingRobot** — SERP data providers; **Firecrawl** — scraping fallback; **Ahrefs API** — Domain Rating badges & Link Monitor backlinks
- **PM2** — process manager · **Nginx** — reverse proxy · **Let's Encrypt** — SSL · **UFW** — firewall

<br/>

## Project Structure

```
src/
  app/
    page.tsx                     # Main dashboard — every site, every account
    site/[id]/page.tsx           # Site detail: analytics, indexing status, health, backlinks, GA4, Clarity
    login/page.tsx
    settings/page.tsx            # Global settings — Google accounts, AI/SERP/API keys
    seo-tools/                   # AI SEO Content Suite
      demand/page.tsx            # Demand — keyword research + domain overview (DataForSEO)
      competitors/page.tsx       # Competitor keyword gap vs your own GSC data
      cluster/page.tsx           # Keyword Clustering (SERP URL-overlap)
      outline/page.tsx           # Outline Generator
      text/page.tsx              # Text Generator
      analysis/page.tsx          # Content Gap Analysis
      landing/page.tsx           # Landing Page Builder (TZ / wireframe / text)
      geo/page.tsx                # GEO Audit (Generative Engine Optimization)
      citations/page.tsx         # Citation & Sentiment Tracker
      links/page.tsx             # Link Monitor (Ahrefs competitor backlinks)
      policy/page.tsx            # Editorial Policy builder
      history/page.tsx           # Unified generation history (server-backed)
      settings/page.tsx          # Redirects to global Settings
    indexer/                     # Private Indexer Network
      domains/page.tsx           # Doorway domain management
      queue/page.tsx             # Internal-link queue
      dictionary/page.tsx        # Content keyword pools
      links/page.tsx             # Cross-linking topology planner
      stats/page.tsx             # 30-day crawl analytics
      logs/page.tsx              # Raw crawl log
      settings/page.tsx          # Script generator (PHP / Astro / Nginx)
    api/
      auth/                      # NextAuth
      gsc/                       # Sites, accounts, sync, striking distance, cannibalization,
                                  # decay, CTR benchmark, URL inspection, health, branded keywords
      ga4/                       # Property linking & reporting
      clarity/                   # Microsoft Clarity snapshots
      rank/                      # Rank Tracker
      aeo/                       # AEO Tracker (AI answer-engine citations)
      backlinks/                 # Backlink inventory & liveness/index checks
      dr/                        # Ahrefs Domain Rating proxy (7-day SQLite cache)
      linkwatch/                 # Link Monitor: brands, Ahrefs v3 pull, AI insights
      audit/                     # Site Audit: built-in crawler (start/poll/results)
      mcp/                       # MCP server endpoint (Streamable HTTP, token auth)
      indexing/                  # Sitemap sync/inspection + 2index.ninja / NeuralIndexer / XML River
      indexer/                   # Doorway domains, queue, dictionary, stats, logs, webhook
      seo/                       # Outline, text, analysis, landing, geo, citations, policy,
                                  # background jobs, images, keyword data, model lists,
                                  # aidetect/ (fingerprint corpus harvest + model bench probe)
  lib/
    auth.ts                      # NextAuth configuration
    prisma.ts                    # Prisma client
    llm.ts                       # Multi-provider LLM client (retry/backoff, error surfacing)
    seo/
      generate.ts                # Outline/text/analysis generation pipelines, volume guard
      prompts.ts                 # All LLM prompt builders
      rag.ts                     # Casino RAG knowledge base lookups
      serp.ts / scrape.ts        # SERP + competitor scraping providers
      aidetect.ts                # Local AI-fingerprint classifier (bag-of-words, no LLM, no deps)
      aidetectStore.ts           # Trained models + per-model ban-list edits (localStorage)
      factDrift.ts               # Deterministic number/identifier diff for rewrites
      history.ts / jobs.ts       # Client-side History + server-side background jobs
    PrivacyContext.tsx / ThemeContext.tsx / LayoutContext.tsx
  components/
    StrikingDistanceKeywords.tsx / KeywordCannibalization.tsx / ContentDecayMap.tsx / CtrBenchmark.tsx
    RankTracker.tsx / AeoTracker.tsx / ClarityPanel.tsx / SiteSettingsTab.tsx
  lib/
    mcp/shared.ts                # MCP helpers: site resolution, key lookup, paid-tool gate
    mcp/tools.ts                 # MCP tool registry — GSC core + the flattened MCP_TOOLS array
    mcp/toolsData.ts             # MCP tools: decay, CTR, GEO, indexer, digests, alerts, GA4…
    mcp/toolsOptimize.ts         # MCP tools: optimization brief, text analysis, rewrite
    audit/crawler.ts             # Site Audit crawler (BFS, regex extraction, issue detection)
prisma/
  schema.prisma                  # Full data model
.agents/skills/                  # Ready-made agent skills for the MCP server
install.sh                       # One-command VPS installer (Ubuntu/Debian)
Dockerfile / compose.yaml        # Docker deployment (docs/DOCKER-SETUP.md)
docs/
  GA4-SETUP.md
  INDEXER-SETUP.md
  MCP-SETUP.md
  DOCKER-SETUP.md
  ARCHITECTURE.md
```

<br/>

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the app is built: the background job system, the multi-pass SEO generation pipeline, the multi-provider LLM abstraction, the MCP server, the audit crawler, the indexer's cloaking/verification mechanism, and the full data model.
- **[docs/GA4-SETUP.md](docs/GA4-SETUP.md)** — connecting Google Analytics 4, step by step.
- **[docs/METRICS-SETUP.md](docs/METRICS-SETUP.md)** — keyword weights, backlink profiles and the competitor gap: importing exports for free, configuring an Ahrefs/Semrush key, and what each action costs.
- **[docs/METRICS.md](docs/METRICS.md)** — the metrics layer from the inside: three-layer routing (cache → reseller API → live), the unit price model, the two caches and how conflicts are resolved, and where it is wired in the UI.
- **[docs/MCP-SETUP.md](docs/MCP-SETUP.md)** — connecting AI agents (Claude Code, Claude Desktop, Cursor, Codex) to your instance.
- **[docs/SEARCH-ENGINES-SETUP.md](docs/SEARCH-ENGINES-SETUP.md)** — Bing Webmaster, Yandex.Webmaster and IndexNow: getting the keys/tokens and what data each engine provides (site + portfolio dashboards, digests, and the site-search badge).
- **[docs/GOOGLEBOT-VIEW-SPEC.md](docs/GOOGLEBOT-VIEW-SPEC.md)** — the Googlebot View cloaking/PBN inspector: how the multi-UA fetch, redirect-chain walk, and cloaking diff work.
- **[docs/PRODUCT-ROADMAP.md](docs/PRODUCT-ROADMAP.md)** — prioritized product and engineering plan: product truth, durable jobs, verified audits and the OSS ideas worth adapting.
- **[docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md)** — Private Indexer and reseller API risks, in English and Russian.
- **[docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)** — the version, migration, tag and GitHub Release gate.
- **[docs/DOCKER-SETUP.md](docs/DOCKER-SETUP.md)** — running OpenGSC with Docker instead of the VPS installer.
- **[docs/INDEXER-SETUP.md](docs/INDEXER-SETUP.md)** — deploying and operating the private indexer network.

<br/>

## Disclaimer

The **Get key** button on the Ahrefs and Semrush cards in Settings is a referral link to a reseller. Saying so here rather than leaving you to notice the `affiliate_key` in the URL: it is the only referral link in the project, it does not change how anything works, and nothing in OpenGSC depends on that reseller. The official API hosts are the defaults, the base-URL field accepts any gateway, and the whole metrics module works with no API key at all through CSV import. Note also that reselling Ahrefs/Semrush API access is against those vendors' terms of service and can be withdrawn without notice — that risk is yours to weigh.

The **Private Indexer Network** implements doorway pages and user-agent/DNS-based cloaking — techniques that sit outside the webmaster guidelines of Google, Bing, and Yandex, and can result in penalties up to and including deindexing for domains that use them. This module is provided as infrastructure tooling for users who understand and accept that risk; it is **not** enabled or required for any other part of OpenGSC. You are solely responsible for how you use it and for compliance with the terms of service of any search engine, hosting provider, or jurisdiction that applies to you. See also [opengsc.org/disclaimer](https://opengsc.org/disclaimer/).

<br/>

## Contributing

Issues and PRs are welcome — this is a self-hosted, community-run project with no roadmap gatekeeping. If you're adding a feature, a short description of the use case in the issue/PR helps a lot; if you're fixing a bug, a `pm2 logs opengsc` excerpt or a reproduction is the fastest way to get it looked at.

<br/>

## License

[MIT](LICENSE) — free for personal and commercial use. Attribution appreciated but not required.

<div align="center">
<sub>Built with ❤️ — free forever. Self-host it on your own VPS.</sub>
</div>
