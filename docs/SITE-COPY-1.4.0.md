# opengsc.org — what to change for 1.4.0

The public site is not in this repository, so this file is the hand-off: what is now wrong, what is
missing, and the exact claims that are safe to make. Every statement below is true of the code in
this release — nothing here is aspirational.

## 1. Corrections (the site currently states something false)

| Where | Says | Should say |
|---|---|---|
| Stack / tech section | Next.js 15, Prisma 5 | Next.js 16, Prisma 7, React 19 |
| Version references | 1.2.x | 1.4.1 |
| Database | "SQLite / MySQL" without qualification | SQLite is the supported path; MySQL/MariaDB is experimental |
| Team features, if implied | multi-user / teams | one instance belongs to one operator; Team/Members/Super Sites screens are prototypes behind a flag |

## 2. Missing from the site (shipped, undocumented publicly)

Short blurbs, in the order they matter for a first-time visitor:

- **Competitor Crawler** — X-ray any domain from inside the console: technical state, platform,
  hosting, scale, and cross-scan matching of analytics and ads identifiers to expose which domains
  share an owner. (The public no-signup checker that shipped briefly in 1.4.0 was removed in 1.4.1;
  do not advertise it.)
- **Demand** — keyword research joined against the site's own Search Console positions, so each row
  says reach / wrong page / nothing rather than a bare volume number.
- **AEO Tracker / AI Visibility** — whether AI answer engines cite the site, with the stored answer
  and citations behind every verdict.
- **AI-Fingerprint Lab** — a local statistical model of machine-written text, trained on the
  operator's own two corpora, with no third-party detector involved.
- **Audit Verification** — re-crawl after a fix and get resolved / still present / regression /
  inconclusive, instead of a fresh report that cannot be compared to the old one.
- **Outreach Workspace** — the pipeline on top of Link Monitor. Say plainly that it prepares
  outreach and never sends it.
- **Content Operations + post-deploy outcome** — approval, deterministic checks, an explicit pull
  request, and then 7/30/90-day measurement against a 28-day baseline. This is the strongest single
  differentiator on the list: most tools stop at "here is your draft".
- **Source Audit** — repository code checked before deployment, read-only, separate from the
  runtime site audit.
- **Sitemap Inventory** — recursive sitemaps with a disappearance rule that does not fire on a
  failed fetch.
- **Ahrefs / Semrush metrics, site archiving, seven UI languages.**

## 3. Disclaimer (the important one)

`opengsc.org/disclaimer/` is currently generic — Google affiliation, API quota, security, no
professional advice. The README is more honest than the public site, which is the wrong way round.
Bring the page in line with the README's Disclaimer section and add, explicitly:

1. The Private Indexer builds doorway domains. Name the risk: manual action, deindexing, and that
   the module is optional and isolated from every other feature.
2. Googlebot View performs UA/DNS-based comparison for cloaking detection, and using the same
   technique to serve different content is a policy violation.
3. Reseller/referral API cards are referral links; link the official provider API next to each.
4. Using third-party data APIs must respect those providers' terms — Ahrefs and Semrush included.
5. Update the date of last change, in every language the site is published in.
6. Put a short "Risks and responsible use" link next to the Indexer, Googlebot View and reseller
   settings — not only in the footer. The repository's version of that text is
   [`RESPONSIBLE-USE.md`](RESPONSIBLE-USE.md).

## 4. Claims that must stay out

- No "unlimited AI" — every AI feature runs on the operator's own keys, at their cost.
- No implied multi-user or agency seat model.
- No guaranteed indexing, ranking or "AI-detector-proof" wording. The app itself refuses to make
  that claim (see the AI-Fingerprint Lab copy) and the site should not undercut it.
- Do not describe MySQL as supported.
