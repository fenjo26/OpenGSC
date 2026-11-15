# ccrank — Common Crawl web-graph rank directory

A small read-only HTTP service that answers one question: **where does this domain stand in
Common Crawl's web graph?** OpenGSC's AI Readiness check (site → Audit tab) asks it for the
"authority" part of the score.

It exists because the source file — harmonic centrality and PageRank for ~118 M registered
domains — is 2.2 GB gzipped and sorted by rank, not by domain. It cannot be read with a range
request and is too large for every self-hosted OpenGSC instance to download each month. One
copy of this service does that work once; instances ask it for one domain at a time.

No dependencies beyond Node 20+, `curl` and GNU `sort`. No database, no user data, no keys.

## Run it

```bash
cd sidecar/ccrank

# 1. Build the lookup files from the newest release (30–60 min, mostly the sort).
#    Disk: ~2.2 GB download + ~5 GB result + ~5 GB sort temp. RAM: sort is capped at 1 GB.
CCRANK_DATA=/var/lib/ccrank node build.mjs

# 2. Serve it (127.0.0.1:8787 by default).
CCRANK_DATA=/var/lib/ccrank CCRANK_TRUST_PROXY=1 pm2 start server.mjs --name ccrank

# 3. Check.
curl 'http://127.0.0.1:8787/v1/health'
curl 'http://127.0.0.1:8787/v1/rank?d=wikipedia.org,blog.example.co.uk'
```

Put it behind TLS. nginx:

```nginx
server {
    server_name ccrank.example.org;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, do not append
    }
}
```

`CCRANK_TRUST_PROXY=1` makes the rate limit count the address nginx passes. Leave it unset if
the port is reachable directly — the header would then be the visitor's to forge.

## Monthly update

Common Crawl publishes a new graph every month. The build is a no-op when the newest release is
already live, so it is safe to run daily:

```cron
17 4 * * *  cd /root/opengsc/sidecar/ccrank && CCRANK_DATA=/var/lib/ccrank node build.mjs >> /var/log/ccrank-build.log 2>&1
```

The switch is atomic (`current.json` is renamed into place); the running server picks the new
release up within a minute, no restart. A failed build leaves the live release untouched. The
previous release is kept as a fallback, older ones are removed.

## API

`GET /v1/rank?d=<domain>[,<domain>…]` — up to 50 domains.

```json
{ "release": "cc-main-2026-may-jun-jul", "total": 118000000,
  "results": [
    { "query": "blog.example.co.uk", "found": true, "domain": "example.co.uk",
      "hcRank": 12345, "hcVal": 19000000, "prRank": 23456, "prVal": 0.0000011, "hosts": 3 },
    { "query": "nope.example", "found": false } ] }
```

The graph is keyed by registered domain. A subdomain is looked up as given, then with its left
labels removed one at a time, so `blog.example.co.uk` resolves to `example.co.uk`; `domain` says
which name matched. URLs, `www.` and IDNs in `d` are normalised.

`GET /v1/health` → `{ "ok": true, "release": "…", "total": 118000000 }` (503 before the first build).

Errors: `400 missing_d | too_many_domains`, `429 rate_limited`, `503 no_data`.

## Settings

| Variable | Default | |
|---|---|---|
| `CCRANK_DATA` | `./data` | where releases live |
| `CCRANK_PORT` / `CCRANK_HOST` | `8787` / `127.0.0.1` | listen address |
| `CCRANK_RATE_LIMIT` | `120` | requests per minute per address |
| `CCRANK_TRUST_PROXY` | unset | `1` = take the client address from `X-Forwarded-For` |

`build.mjs` flags: `--release <id>` (a specific release instead of the newest), `--data <dir>`,
`--force` (rebuild the live release), `--keep-download`, `--source <url>` and `--allow-small`
(build from another file — used by the self-test with a `file://` URL).

## Pointing OpenGSC at it

Instances use the project's public directory by default. To use your own, set in OpenGSC's `.env`:

```
OPENGSC_CCRANK_URL=https://ccrank.example.org
```

`OPENGSC_CCRANK_URL=off` disables the authority part; the score is then built from the other two.

## Data and attribution

Ranks come from the [Common Crawl](https://commoncrawl.org) host- and domain-level web graphs
(`projects/hyperlinkgraph/<release>/domain/`), used under Common Crawl's terms of use.
