# SERP Monitor

`/serp-monitor` watches whole SERPs, not positions. Every check snapshots the **entire top-100**
for each keyword in a project (one market = engine · country · language · device + a keyword
set), and every comparison answers three questions a rank tracker cannot: **who entered the
top-100 and who dropped out of it**, **how hard the whole market shook** (storms), and **who
these new domains are** — first seen when, registered when, what DR.

The source in v1 is your own A-Parser running `SE::Google`, so a 944-keyword check costs the
same as a 9-keyword check: proxy traffic. There is no per-request bill.

## Requirements

- **A-Parser** with the `SE::Google` parser, configured in **Settings → API keys** (base URL +
  password). The module reads the option ids from your live `SE::Google` preset; without
  A-Parser the projects page shows a banner instead of a broken table.
- **Proxies** that hold up for the volume you configure. This module is far hungrier than rank
  tracking (see the load math below), and a burned proxy shows up here as `failed` snapshots —
  never as silent "mass exits".
- Google **desktop** only in v1. `SE::Google` is the only parser wired up.

## Sizing the load

The unit of work is **queries × pages**. Depth 100 means 10 Google result pages per query
(≈ 10 organic results per page), so:

> 944 queries × 10 pages = ~9,440 page fetches per run, once a day, per project.

Two consequences:

1. **Depth is the real lever.** Depth 20 (2 pages) is ten times cheaper than depth 100. If you
   only care about entrances into the top-30, take depth 50.
2. **Wall time is A-Parser's thread count**, not OpenGSC's. The collector runs keywords in
   parallel up to your configured A-Parser concurrency limit and then queues; a 944-keyword
   project with 20 threads is a few tens of minutes, and a run interrupted by a restart
   resumes where it stopped (keywords that already have a snapshot in this run are skipped).

Storage at the reference size (944 keywords × depth 100, once a day): ≈ 1.2 MB/day of snapshot
rows, ≈ 450 MB/year before retention thins old snapshots (see below).

## The tabs

**Market** — one row per keyword: current leaders, host-level changes with positions
(`+host #34` entered at 34, `−host` dropped out, `↑ host 12→5` moved up), volatility, and your
own position if the project lists your domains. Click a row for the full SERP history of that
keyword and to diff any two snapshots side by side.

**Storms** — one point per run: the project's median volatility against its own baseline, the
storm verdict, which keywords shook hardest and which hosts entered/exited the most. Until the
baseline exists the tab says "calibrating" — see below.

**Domains** — the catalogue: who holds how many keywords, who is rising/falling run-over-run,
who is **new** (first seen after the project's first run), **young** (registered less than N
months ago — RDAP/WHOIS lookup via "Load registration dates"), **bounced** (entered and exited
within 7 runs), with DR where the free Ahrefs lookup has run. CSV export included.

Social networks, app stores and Wikipedia are hidden from change lists by default (a
`facebook.com` "entrance" is not news), but they still count toward volatility — the SERP
really did change. Add your own hidden hosts per project.

## Snapshot statuses: ok / partial / failed

Every snapshot carries one of three statuses, and the distinction is the module's core:

| Status | Meaning | Enters comparisons |
| --- | --- | --- |
| `ok` | The engine answered and returned at least 80% of the expected rows | yes |
| `partial` | A short answer (below the 80% bar) — usable, but compared only down to what it actually got | yes |
| `failed` | Empty answer, proxies blocked or captcha, parser failure, provider error, timeout | **never** |

Two rules follow from the table and are worth internalising:

- **A `failed` snapshot never produces exits.** An empty response is recorded as a failure
  with its reason (`aparser_blocked_or_empty`, `short_result`, `no_creds`, …), not as "100
  results vanished". Without this rule one dead proxy would manufacture a fake storm across
  every keyword at once.
- **Comparison respects common depth.** Previous snapshot 100 rows, current one 60
  (`partial`) → the first 60 are compared. A host sitting at position 80 was *not* "dropped
  out" — the comparison simply does not see that far this run.

Because comparison always targets the last `ok`/`partial` snapshot, a keyword can survive any
number of failed runs without losing its history.

Changes themselves are host-level: a domain has one best position and one change, however many
of its URLs are on the page (the URL count is a side number). Position moves only count as
changes above a noise threshold that grows with depth: ±3 in the top-10 is an event, ±3 at
position 70 is noise.

## Storms: measured against the project's own baseline

Volatility per keyword is `1 − RBO` (rank-biased overlap) between the previous and current host
lists — 0 means identical, 1 means disjoint — computed over all hosts and separately for the
top-10. A run's volatility is the median over its compared keywords.

A **storm** is a run whose volatility is extreme *for this project*, not by an absolute bar.
The verdict needs three things:

1. **A baseline**: the previous 20 done runs of the same project.
2. **Enough data in the run**: at least 10 compared keywords *and* at least 30% of the run's
   keywords actually compared.
3. **Both signals at once**: a robust z-score of the run's median volatility against the
   baseline of at least 3, **and** at least 30% of keywords running above their own usual
   churn (each keyword's current volatility above its own p90 over its last 20 snapshots).

While the project has fewer than **7 done runs**, the tab and the API say **calibrating** —
that is not "no storms", it is "no baseline yet". A gambling market in LatAm churns daily at a
level that would look like a permanent storm for a boring B2B niche; only the project's own
history can say what "too much" means for it. Unit tests cover the detector itself, so there
is no need to wait 7 days to convince yourself it works.

When a storm fires, the project sends **one** Telegram/Slack message (channels from
**Settings → Notifications**): the storm score, the share of keywords above their usual churn,
the 5 most shaken keywords and the 5 hosts with the most entrances+exits in that run. The
button "Send a test storm alert" in the project settings delivers the same message on
fabricated data so you can see exactly what arrives. Per project the notifications have an
on/off switch ("Notify about storms"); they are on by default.

## Storage and thinning

Full snapshots (every URL of every run) are kept for the project's retention window — 180
days by default. After that, old snapshots are thinned to one per ISO week per keyword, so the
long-term shape of the market survives without paying for every daily capture. The snapshot a
keyword is currently compared against is never deleted. Domain/host and URL rows live for the
life of the project.

## MCP

The contour is exposed to agents as six tools: `serpmon_projects`, `serpmon_market`,
`serpmon_keyword_history`, `serpmon_storms`, `serpmon_domains` (all free, local reads) and
`serpmon_run` (starts an asynchronous check — see `docs/MCP-SETUP.md`).

## Limitations in v1

- **Google desktop only.** Mobile, Bing and Yandex are planned (the schema already carries
  `engine` and `device`).
- **MySQL deployments: long URLs.** On MySQL every string column is `VARCHAR(191)`; a URL
  longer than that cannot be stored and its row fails to write. SQLite (the default) has no
  such limit — this is the same project-wide caveat as `RankCheck.url`, not a module bug. Run
  SERP Monitor on SQLite for now.
- **Serial A-Parser tasks.** Each run submits keywords one batch at a time through the normal
  transport. A-Parser's batch mode (`addTask`) for projects beyond ~2,000 keywords is phase 2.
- **One storm verdict per run**, computed when the run finishes — there is no intraday
  re-evaluation.

## Phase 2 (not built yet)

- **Grids**: clustering hosts by shared name servers /24 and similar page titles — catching a
  network of sites, not just a domain.
- **Mobile SERP, Bing, Yandex.**
- **A-Parser batch mode** (`addTask`) for very large keyword sets.
- **Paid SERP providers on a schedule** (e.g. DataForSEO) with a monthly budget — every
  scheduled provider run would use the `spend` capability.
- **"Send this SERP to the generator"** — hand a keyword's top-N URLs to the existing SERP
  analysis tooling as material.
- **Garbage collection** of orphaned URL/host rows.
