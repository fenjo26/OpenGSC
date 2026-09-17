# Rank Tracker on A-Parser (SE::Google::Position)

Rank Tracker (the **Positions** tab of a site) can check positions through your own A-Parser
instead of a metered SERP API. It uses `SE::Google::Position`, not a full `SE::Google` scan:
the parser stops at the results page where your site is found, so a keyword in the top 10 costs
one page, a keyword on position 35 costs four, and only a keyword that is not in the top 100
costs all ten.

## Setup

1. Connect A-Parser in **Settings → API Keys** (or `OPENGSC_APARSER_BASE_URL` /
   `OPENGSC_APARSER_PASSWORD`). The instance needs `SE::Google::Position` and proxies that
   Google accepts. The **SERP Monitor** probe is a good way to check those proxies.
2. Run the probe on the server, from the OpenGSC directory:

   ```
   npx tsx scripts/aparser-position-probe.ts your-site.com "a keyword you rank for" gr el
   ```

   It prints the live preset's option ids, the raw answer for your site, a not-found control, the
   exact-domain variant and a full `SE::Google` scan for comparison. If an id reads
   `NOT in preset`, or the Position and SE::Google numbers differ, don't switch yet.
3. **Settings → SEO Tools → Rank Tracker provider → A-Parser.**
4. Optional: **Fallback provider** (e.g. ScrapingRobot). Only checks A-Parser could not answer
   go there.

## What counts as your site

Every tracked host is asked as exact domains — itself plus its `www.` twin, best position wins:

| Tracked site | Query sent | `matchtype` |
|--------------|------------|-------------|
| `site.gr`    | `site.gr,www.site.gr <keyword>` | `domain` |
| `blog.site.gr` | `blog.site.gr,www.blog.site.gr <keyword>` | `domain` |

The documented `tld` mode (any host under a registrable name) is deliberately not used: on
A-Parser 1.2.3643 it was probed missing a site that sat at #2 of a page the parser itself
grabbed, while the same keyword in `domain` mode answered 2. The cost of exact mode: hosts
UNDER the tracked name are not counted (a tracked apex ranking on `blog.site.gr` reads as
"not found" — a miss, never a false hit). If A-Parser reports a position whose link is on
another host, the check is stored as an error (`aparser_position_mismatch`), not as a position.

## Errors, retries, fallback

- **Captcha solving is inherited from SE::Google.** The solvers a deployment configures live in
  util-parser presets SE::Google names (here: `Util::ReCaptcha2` preset `captcha`), while the
  Position preset usually points at the bare `default`, which solves nothing — every cold-session
  parse then exhausts its retries and reads as a burnt proxy. The tracker reads SE::Google's own
  presets (`my`, then `default`), keeps the names whose util preset really exists on the instance,
  and sends them along with every Position request. No Position-specific setup is needed; if you
  change the solving service for SE::Google, the tracker follows within ten minutes.

- `0` from the parser means "not found": it is stored as not found only if the parse went
  through all ten pages. If A-Parser logged `No more pages` and Google's total does not explain it,
  the check is `aparser_partial_serp` (an error), because a "not in the top 100" from one page
  would draw a false drop.
- `none`, `success: 0`, captchas: `aparser_blocked_or_empty` / `aparser_parser_failed`.
- A transient error (those above, timeouts, 5xx, ScrapingRobot's "try again later") is retried
  once after 10 s on the same provider, then sent to the fallback provider if one is set. If both
  fail, the error names both and the last known position stays on screen.
- Each stored check records which provider answered (`RankCheck.provider`). Hover over the
  position to see it.

## Deploy note

This adds the nullable column `RankCheck.provider`, so run `npx prisma db push` when you deploy.
