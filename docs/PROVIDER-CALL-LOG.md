# Per-request provider call log — design

Status: design approved, not yet implemented. Branch `provider-log`. Implements issue
`fenjo26/OpenGSC#9`.

## The gap

OpenGSC bills real money to a dozen providers and keeps almost no record of it.

`ApiUsage` (`prisma/schema.prisma:1391`) is a monthly aggregate keyed
`(userId, provider, month)` holding `units` and `requests`. Exactly one writer touches it —
`metricsStore.ts:325` — and it writes *before* the request, because it exists to enforce a
monthly cap rather than to describe what happened. SERP providers never write to it. AI calls
write nothing at all: `llm.ts` never reads a `usage` block, and the word appears in that file
only inside gateway error text.

So today three questions have no answer:

- **What did a run cost?** A GEO audit that timed out was billed by the provider and left no
  record — the failure this repo fixed in `1e92657` was invisible in the data even after it was
  understood.
- **Which provider actually served this?** Multi-provider routing (task-level overrides,
  gateway base URLs, fallbacks) is decided at runtime and never written down.
- **What did we send?** Debugging a wrong-model or wrong-token problem means reverse-engineering
  it from behaviour.

## What is logged

One append-only row per outbound provider request. Not per user action, not per retry ladder —
per request, so a ladder of three attempts is three rows and the retry count is visible as
three rows rather than asserted in one.

| field | source |
|---|---|
| `at` | clock |
| `userId` | ambient context (below); null is allowed and visible |
| `feature` | ambient context — the route path, or a job type like `outline_auto` |
| `provider`, `model` | call site |
| `endpoint` | the URL, minus query string and credentials |
| `status` | HTTP status, or a synthetic one for a transport failure |
| `ms` | measured around the call |
| `attempt` | which attempt in a retry ladder |
| `promptTokens`, `completionTokens` | the provider's own `usage` block, when it sends one |
| `costUsd` | **only what the provider reported.** Never computed |
| `error` | the classified message already produced today |
| `requestBody`, `responseBody` | only when body capture is on. Redacted and truncated |

### Cost is reported, never computed

A price table per model is the obvious way to always have a number, and it is the wrong way. It
goes stale silently, and a wrong cost on screen is indistinguishable from a right one — the same
argument this codebase already makes for refusing to turn GoAnyAPI's volume buckets into numbers
(`goanyapi.ts:8-11`) and for refusing to substitute US volumes for an unknown country
(`demand.ts:76-83`). So `costUsd` is filled only where the provider states it (gateways, kie,
DataForSEO) and is left null everywhere else. Null means "not stated", which is a fact; an
invented number is not.

Tokens are different: `promptTokens`/`completionTokens` come from the response's own `usage`
block, so they are measurements too. Twelve provider branches spell that block differently, and
each is read where its response is already parsed.

## Where the context comes from

The hard part of this feature is not the table. It is that `llm.ts` — where every AI call
funnels — has no idea who it is calling for. The word `userId` does not appear in it. A log row
that cannot say whose call it was is not worth writing.

Context therefore travels out of band, in an `AsyncLocalStorage` store holding `{ userId,
feature }`, so no function signature between the entry point and the socket has to change.
Threading it explicitly was the alternative and was rejected: it would alter `fetchLLM*`,
`runSerp` and roughly twenty more signatures plus every caller — around a hundred edits in code
that has nothing to do with logging, each one a chance to break something — and half those
callers do not have a `userId` either, so the threading would continue several levels up.

There are exactly three kinds of entry point, and all three are enumerable:

1. **API routes — 122 of the 147 already call `workspaceUserId()`.** That single function is the
   one place that already resolves who the caller is, at the top of every route that matters. It
   establishes the context itself, with `enterWith`, covering all 122 in one file.
2. **Schedulers — 7 of them** (`aeo`, `alert`, `clarity`, `digest`, `rank`, `sync`, `warmup`),
   each running on a timer with no request around it. Each tick wraps its per-user work in the
   context explicitly.
3. **Detached jobs.** `api/seo/jobs/route.ts` starts work that outlives the request, so the
   context is established inside the runner rather than inherited from the route.

**The one risk this design accepts, and how it is checked.** `enterWith` sets the store for the
current execution and its continuations rather than wrapping a callback, which is what makes the
one-file hook possible — and it is the part of `AsyncLocalStorage` that can leak between
contexts if the runtime reuses one. A test therefore issues concurrent requests as two different
users and asserts no row is attributed to the wrong one. If that test cannot be made to pass,
the design falls back to wrapping the 122 routes, which is more work and not more risk.

A missing context is not an error: the row is written with a null `userId`, which is visible in
the log as a gap rather than lost as a silent mis-attribution. A test asserts that a call made
with no context still produces a row.

## How the data is captured

A thin wrapper around `fetch` that provider modules call instead of the global. It measures
duration, records status, catches the transport failure, and writes the row — without knowing
anything about the provider it is wrapping. The alternative is hand-written timers at ~45 call
sites, which is both more code and more places to forget.

Two things stay out of the wrapper because they are provider-specific and belong where the
response is already parsed: the `usage` block, and any provider-stated cost. Both are handed
back to the logger by the caller after parsing.

## Coverage

Everything that leaves the process for a paid provider, in this order — each step independently
useful, so the work can stop at any point without leaving a half-wired system:

1. **AI** — `fetchLLMOnce` and `fetchLLMVision` (`llm.ts`). Twelve providers, one chokepoint
   each. This is the largest current blind spot: no record of any kind exists today.
2. **SERP** — `runSerp` (`serp.ts`): serper, dataforseo, scrapingrobot and goanyapi.
3. **The long tail** — metrics/backlinks (`backlinksApi.ts`, `metrics.ts`), demand
   (`demand.ts`), AEO (`aeo.ts`, `llmMentions.ts`), images (`kieImages.ts`, `zaiImages.ts`) and
   scraping (`scrape.ts`). Roughly twenty files, one or two calls each — the tedious part, not
   the difficult one.

Internal `fetch` calls to our own API (`geoClient.ts`, `jobs.ts`, `history.ts`) are not provider
calls and are not logged.

## Bodies

Off by default, switched on in Settings while a problem is being chased, and never a silent
default. When on:

- Authorization headers and any key-shaped value are redacted before the row is written. A log
  that captures the operator's own API keys is a worse problem than the one it was enabled to
  solve.
- Each body is truncated to a fixed ceiling, so one large generation cannot write megabytes.
- Rows carrying bodies are the first thing retention removes.

## Retention

The table grows with every request forever, on SQLite. A retention sweep keeps a bounded window
— bodies dropped sooner than metadata — and runs on the same schedule machinery the other
sweeps already use. The window is a setting, with a default that is honest about the trade
rather than unbounded.

## Surfacing

A read-only view listing recent calls with the fields above, filterable by provider and feature,
and one row expandable to its bodies when they were captured. Its first job is answering "what
did this run cost and who served it", so the default sort is newest first and the default filter
is nothing.

## Verification

Unit-testable without a network: the redactor, the truncation, the token extractors for each
provider response shape, and the retention window arithmetic. Each gets a test.

Two behaviours need real tests rather than unit tests, because they are the reasons this design
could be wrong: concurrent requests from two users must never cross-attribute, and a call with
no established context must still produce a row.

The rest needs live verification against real providers, because the token block and any stated
cost only exist in a real response. That is the slow part of this work — every provider has to
be called for real, once, and the row it produces read.
