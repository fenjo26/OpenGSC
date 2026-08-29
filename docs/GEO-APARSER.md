# GEO Audit on A-Parser (FreeAI::ChatGPT)

A fourth GEO engine alongside `openai`, `kie` and `gemini`. Instead of paying an API per token,
stage 1 of a GEO audit runs `FreeAI::ChatGPT` inside an A-Parser instance you run yourself.

## Why it exists

GEO stage 1 is the most expensive request in the app and the only one with no output-token
ceiling: the tool loop runs on the provider's side and the sole limit is our own abort. A run
that hits it bills in full and returns nothing. This engine removes that bill entirely and, on
top of that, reaches the public ChatGPT surface a person would actually use rather than the
Responses API — geolocation follows the proxy's exit IP instead of a sentence in the prompt.

The citations are also better than the kie.ai path: `$sources` is typed and carries a snippet per
source, where OpenAI-compatible relays print bare links in the answer body with no metadata at
all (see `extractLinksFromText` in `src/lib/seo/geo.ts`).

## Setup

1. Configure the A-Parser connection in **Settings → SEO Tools** (base URL + API password), or
   set `OPENGSC_APARSER_BASE_URL` / `OPENGSC_APARSER_PASSWORD` on the instance. The env var wins:
   an instance that never fetches a URL typed into a browser is the safer deployment.
2. Make sure `FreeAI::ChatGPT` is installed in that build (the `/aparser` screen lists what the
   instance reports).
3. Open **SEO Tools → GEO Audit** and pick the **A-Parser** engine.

**Web search must be on.** It is OFF by default in this parser, and with it off the answer comes
out of the model's weights, which is exactly what the GEO module exists to say is not evidence
about search visibility. OpenGSC therefore sends it as an explicit `override` on every request;
if your build rejects that option id, the request is retried once without it and your preset has
to carry the setting instead.

**Docker:** `127.0.0.1` inside the container is the container. Use the host's LAN IP or
`host.docker.internal`.

## What the report loses, and why

| RawTrace field | On this engine |
| --- | --- |
| `answerText` | the parser's `answer` |
| `citations[]` | `$sources` where `type = citation` |
| `scannedAll[]` | every `$sources` entry — the scanned-but-uncited set the analysis prompt asks for |
| `opened[]` | empty — no open-page equivalent exists, same as the Gemini engine |
| `batches[]` | one synthetic batch holding the audit's own query and the sources actually seen |

The parser reports what the answer used, not the steps that found it. The synthetic batch exists
because an empty batch list is not just a missing panel: it zeroes `uniqueQueries` and blanks
every brand's coverage bar in the leaderboard, which reads as "surfaced for nothing" rather than
"the queries were not observable".

**The model is reported, not chosen.** The free session serves what it serves (`gpt-4o`,
`i-mini`, …), so the report names the model that actually ran rather than one you picked. Compare
a run against the OpenAI engine side by side before treating this as a replacement rather than an
alternative.

**Stage 2 still costs money.** Only the search stage moves to A-Parser; the analysis pass that
turns the trace into the qualitative half of the report runs on your `utility` task provider as
usual. With no `utility` credentials configured this engine skips analysis entirely and the audit
ships with the deterministic half only — it will never fall back to sending your A-Parser
password to a vendor endpoint.

## Trade-offs to state plainly

Reliability becomes your proxy pool rather than a vendor SLA, and driving a free consumer surface
with browser automation is your call to make against that service's terms. OpenGSC talks only to
the A-Parser instance you point it at.
