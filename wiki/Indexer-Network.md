# Private Indexer Network

**Top menu → Monitoring → Indexer** (`/indexer`).

> ⚠️ **Read this first.** The Indexer builds **doorway pages** and serves search-engine crawlers different content from humans (User-Agent + DNS **cloaking**). Both are against the webmaster guidelines of Google, Bing and Yandex and can get every participating domain penalized or deindexed. The module is optional, isolated from the rest of OpenGSC, and does nothing until you configure domains and deploy the script yourself. **Use only domains you can afford to lose.** You're responsible for complying with the rules of search engines, hosts and your jurisdiction. See [RESPONSIBLE-USE.md](https://github.com/fenjo26/OpenGSC/blob/main/docs/RESPONSIBLE-USE.md).

## What it is

A self-hosted doorway-domain network for getting pages crawled fast and for free, outside Search Console's normal discovery flow. You bring the domains (drops or new registrations). OpenGSC provides the management console, the deployable script and the crawl analytics.

Verified crawlers get generated pages that link to your target URLs. Humans and fake bots are redirected (302) to your real site.

## Sections

| Section | What it does |
|---|---|
| **Domains** | Add a doorway domain, pick a content template (E-commerce / Directory / Blog / Portfolio), set the redirect target, choose allowed bots (Google / Bing / Yandex). Each domain gets its own API key, plus a DR / referring-domains chip |
| **Queue** | Paste money-site URLs to be woven as links into the next generated pages; per-doorway chips show where the queue piles up, with a redistribute action |
| **Dictionary** | Keyword pools that flavour generated content, manual or AI-generated per niche |
| **Links** | Cross-linking planner across your domains: ring / mesh / pyramid, SVG graph, HTML snippet export |
| **Settings** | Deployment hub: generates code for a dynamic PHP doorway, a static PHP wrapper, Astro SSR middleware, or an Nginx config that routes bots to `index.php` and serves humans static files |
| **Stats** | 30 days of hits by bot (Google / Yandex / Bing / Mail.ru / other / redirected humans), per-domain Google share, `304 Not Modified` breakdown, CSV |
| **Logs** | Raw crawl log (time, domain, path, IP, bot, status), filterable, optionally live |

## Bot verification

When strict verification is on, the deployed script runs a **double DNS lookup**:

1. **Reverse DNS** of the visitor's IP must end in a known suffix: `googlebot.com` / `google.com`, `yandex.ru` / `.net` / `.com`, `search.msn.com`, `mail.ru`.
2. **Forward DNS** of that hostname must resolve back to the **same IP**.

A spoofed User-Agent can't fake a PTR record inside Google's or Yandex's IP ranges, so only real crawlers pass. Verified bots get the generated page (with ETag-based `304` on repeat visits) and a logging ping goes to your panel.

## Setting up a domain

1. **Indexer → Domains → Add Domain**: the domain without `http(s)`, a template, and the **Redirect Target URL** (where humans go). Save it to get the domain's API key.
2. Point the domain at a server with PHP (Apache or Nginx). Add a **wildcard DNS** record (`*` → server IP) so any subdomain reaches it.
3. Route every request to `index.php`. Apache `.htaccess`:
   ```apache
   RewriteEngine On
   RewriteCond %{REQUEST_FILENAME} !-f
   RewriteCond %{REQUEST_FILENAME} !-d
   RewriteRule ^(.*)$ index.php [L,QSA]
   ```
4. **Indexer → Settings**: set **OpenGSC Public Deployment URL** to your panel's public address (no trailing slash), pick the domain (fills its key and target), **Copy Code**, save it as `index.php` in the doorway's root.
5. Feed targets: paste URLs into **Queue**, or from any site's **Indexing** tab use **Private Bot Farm → Submit Sitemap URLs**.

## Reading the stats

- The **304** columns show how often Google and Yandex re-checked pages without re-downloading them, a sign that bots actively monitor the domain.
- Domains that are **never crawled** are worth replacing. The MCP tool `get_indexer_stats` lists them.

## Redistribution

Each queue row lives on exactly one doorway, and the webhook serves only the rows of the domain a bot actually hits. When a doorway stops being crawled (dropped from the index, script broken, domain expired), its rows hang pending forever.

**Indexer → Queue** fixes this two ways:

- The per-doorway chips (`domain · count`) show the pile-up; the shuffle button on a chip empties **that** doorway onto the other active ones.
- The **Redistribute** button reshuffles the whole queue across the active doorways.

Moved rows are re-created as fresh `PENDING` (rotation starts over, `crawled` state is reset). The spread is even and never onto a domain the URL already sits on; a URL that already exists on the target keeps that row (`merged`), extra copies across doorways are collapsed (`deduped`). The MCP mirror is `indexer_redistribute_queue`.

> The drops → Activation trail (`DropDonorPlacement`) records which doorway a donor page was queued on at activation time — it is a historical log, not a join key, and may go stale after a redistribution.

## Housekeeping

Raw `IndexerLog` rows aren't rolled up automatically and can bloat the database, which slows backups and updates. Roll them up when needed:

```bash
cd /root/opengsc && node scripts/rollup-logs.ts   # keeps the latest 5,000 raw rows; daily stats stay
```

## Related

- [Drops → Activation](Drops#activation-reviving-a-bought-domain): the donor accelerator uses doorways with proven Google crawl, and links to donor pages, never to the asset itself.
- Full walkthrough (Russian): [docs/INDEXER-SETUP.md](https://github.com/fenjo26/OpenGSC/blob/main/docs/INDEXER-SETUP.md).
