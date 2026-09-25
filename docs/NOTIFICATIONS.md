# Notifications & Delivery Channels

OpenGSC sends alerts, digests and status messages to whichever channels you configure in
**Settings → Notifications**. Every channel is optional, channels are independent (one failing
never blocks the others), and each has its own event filter — e.g. uptime alerts can go to
Discord while digests go only to e-mail.

All six channels:

| Channel | Where credentials live | Setup |
|---|---|---|
| Telegram | your own bot (`@BotFather`) | Settings → Notifications → Telegram |
| Slack | Incoming Webhook | Settings → Notifications → Slack |
| Discord | server webhook | Settings → Notifications → Delivery channels → Discord |
| Microsoft Teams | Teams "Workflows" webhook | Settings → Notifications → Delivery channels → Microsoft Teams |
| E-mail (SMTP) | your mail server | Settings → Notifications → Delivery channels → E-mail (SMTP) |
| Webhook | any HTTPS endpoint you control | Settings → Notifications → Delivery channels → Webhook |

The **Send test** button next to each channel delivers a real test message (it works even while
the channel's on/off switch is off). The collapsed row shows the last successful delivery time
or the last error.

## Event types

Each channel chooses which event types it receives. **No selection = everything.** The "Send
test" button bypasses every filter.

| Event | What triggers it |
|---|---|
| `alert` | Rank drops, traffic drops, SSL expiry, low audit score, lost links, provider trouble, SERP storms, watched domains becoming free |
| `digest` | Scheduled portfolio digests |
| `uptime` | Site down / recovered / still down (uptime monitor) |
| `index` | Pages with traffic dropped out of Google's index |
| `mention` | Daily brand-mentions summary (news / Wikipedia) |

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot`, copy the token.
2. Paste the token in Settings, press **Detect chat id**, then send any message to your bot
   (press **Start** in the bot's chat) and press **Detect** again.
3. **Send test** to confirm.

Free: messages go straight from your server to the Telegram Bot API.

## Slack

1. Create an **Incoming Webhook** in your Slack workspace settings
   (Settings → Workspace → Apps → Incoming Webhooks), pick a channel, copy the
   `https://hooks.slack.com/services/…` URL.
2. Paste it in Settings → Notifications → Slack → **Send test**.

## Discord

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**, pick a channel,
   then **Copy Webhook URL**. It looks like
   `https://discord.com/api/webhooks/1234567890/AbC…` (`discordapp.com` also works).
3. Paste it into the Discord row → **Save** → **Send test**.

Only `discord.com` / `discordapp.com` webhook URLs are accepted. Long messages are split on
paragraph boundaries into chunks of ≤ 2000 characters, and `@everyone` / `@here` inside message
text never ping anyone (`allowed_mentions` is empty).

## Microsoft Teams

Office 365 connectors are retired — use a **Workflows** webhook:

1. In Teams, open the target channel → **⋯ → Workflows** (or open
   [powerautomate.microsoft.com](https://make.powerautomate.com) directly).
2. Create from the template **"Post to a channel when a webhook request is received"**,
   pick team + channel.
3. Copy the generated HTTPS URL — its host ends with `.logic.azure.com`,
   `.powerplatform.com` or `.powerautomate.com` — and paste it into the Teams row.

Messages arrive as an Adaptive Card 1.4 with a bold title. Only the three Workflows hosts above
are accepted (never weakened to "any https URL").

## E-mail (SMTP)

OpenGSC speaks SMTP directly to your mail server — no third-party service in between.

| Field | Example (Gmail) | Notes |
|---|---|---|
| SMTP host | `smtp.gmail.com` | must be a public hostname; internal addresses are refused |
| Port | `587` (STARTTLS) or `465` (TLS) | |
| TLS (port 465) | on for 465, off for 587 | |
| Login | `you@gmail.com` | optional for an open relay |
| Password | Gmail **app password** | Gmail does not accept the account password — create one at Google Account → Security → 2-Step Verification → App passwords |
| From | `you@gmail.com` | what recipients see |
| Recipients | `chief@company.com, seo@company.com` | comma-separated, up to 10 |

The e-mail is sent as both plain text and minimal HTML (bold/italic/links only — mail clients
strip images and styles anyway). Leave the password field **empty** to keep the stored one.

Common errors: `SMTP login failed` — wrong login/app password; `Cannot reach the SMTP server` —
wrong host/port or the server is unreachable from your VPS.

## Webhook (generic)

For your own automation (n8n, Zapier, a script, a chat bot). Any HTTPS URL that passes the
internal-address check. Each request:

- Method `POST`, `Content-Type: application/json`, body ≤ 64 KB.
- Optional signature header `X-OpenGSC-Signature: sha256=<hex>` — HMAC-SHA256 of the **raw
  request body** with the signing secret you set, prefixed with `sha256=`.

```json
{
  "event": "alert",
  "title": "📉 example.com: pages left Google's index",
  "text": "example.com — 2 page(s) with traffic are no longer indexed:\n…",
  "markdown": "*example.com* — 2 page(s) …",
  "createdAt": "2026-10-01T06:30:00.000Z",
  "instance": "https://your-opengsc.example"
}
```

`text` is flat plain text, `markdown` is the original Telegram-style markdown (`*bold*`,
`[label](url)`), `instance` is this OpenGSC deployment's own URL (`NEXTAUTH_URL`).

Verifying the signature — Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

app.post("/hook", express.raw({ type: "application/json" }), (req, res) => {
  const expected = "sha256=" + createHmac("sha256", process.env.OPENGSC_WEBHOOK_SECRET)
    .update(req.body).digest("hex");
  const got = req.get("X-OpenGSC-Signature") ?? "";
  const ok = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);
  console.log(JSON.parse(req.body.toString()));
  res.sendStatus(200);
});
```

Python (FastAPI):

```python
import hashlib, hmac, os
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

@app.post("/hook")
async def hook(req: Request):
    body = await req.body()
    mac = hmac.new(os.environ["OPENGSC_WEBHOOK_SECRET"].encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(req.headers.get("x-opengsc-signature", ""), f"sha256={mac}"):
        raise HTTPException(status_code=401)
    return {}
```

Always compare the signature over the raw bytes, before any JSON re-serialization.

## Security notes

- Webhook/SMTP targets are checked against internal/private addresses before every request
  (SSRF guard), redirects are refused, and each request times out after 10 s.
- Secrets (webhook tokens, SMTP passwords, the signing secret) are stored server-side only;
  the settings page always shows masked values, and an empty field on save means "keep".
- Delivery state (`lastOkAt` / `lastError`) is written back per channel after every send.
- Retries: one retry after 2 s on network errors and 5xx; on Discord 429 the announced
  `retry_after` is respected (capped at 10 s) before the single retry.

## API

| Method & path | What |
|---|---|
| `GET /api/settings/notify-channels` | `{ channels: NotifyChannelView[] }` — masked, no secrets |
| `PUT /api/settings/notify-channels` | `{ id, patch }` → updated view; `""` in `url`/`secret`/`pass` = keep |
| `POST /api/settings/notify-channels/test` | `{ id }` → `NotifyDelivery` for that channel |

Owner-only (the same permission as the Telegram/Slack blocks — channel config holds the
owner's secrets). Delivery code: `notifyUser(userId, text, { event, title })` in
`src/lib/notify.ts`; per-channel results via `notifyUserDetailed`.
