# Health Check Setup (Safe Browsing, Core Web Vitals, VirusTotal)

The **Health tab** on each site page runs four checks:

| Check | Provider | Key needed |
|---|---|---|
| SSL certificate | direct TLS handshake from your server | — (free, always on) |
| Google Safe Browsing | Safe Browsing API | Google API key |
| Core Web Vitals (LCP, INP, CLS, TTFB, Performance score) | PageSpeed Insights API | Google API key |
| Malware / engine scan | VirusTotal API | VirusTotal key |

Keys are configured in **Settings → API Keys → Health Check API Keys**. This guide covers
getting each key and the restrictions that actually work — the three Google-side traps in
this doc account for nearly every "the check returns an error" report.

## Read this first: the checks are server-side

OpenGSC calls all three providers **from your server**, not from your browser. Two
consequences for key restrictions:

- **Never restrict these keys by HTTP referrer** (the "Websites" application restriction).
  Server requests carry no `Referer` header, so Google rejects them with
  `Requests from referer <empty> are blocked.`
- **If you restrict by IP addresses**, add **both** the server's IPv4 **and** IPv6 —
  outbound traffic may use either. On the VPS run `curl -4 ifconfig.me` and
  `curl -6 ifconfig.me` to see both; the error message from Google also names the IP it saw.
  Note that IPv6 on many VPS providers is stable (derived from the VM's MAC address), so
  listing it once is safe.
- Key and restriction changes can take **up to 5 minutes** to propagate on Google's side.

### What data is sent

When you run a check, OpenGSC sends only the site's domain (as part of a URL) to the
respective provider, plus your API key for authentication. Nothing else leaves your
instance. Results are cached in your own database for 24 hours; re-running the check
overwrites the cache immediately.

---

## Google Safe Browsing

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select or create a project.
2. **Enable the Safe Browsing API** for that project:
   [direct enable link](https://console.developers.google.com/apis/api/safebrowsing.googleapis.com/overview).
   ⚠️ Creating a key is **not** enough — an unused API in the project produces
   `Safe Browsing API has not been used in project ... before or it is disabled`.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. (Recommended) Click the key to restrict it:
   - **API restrictions → Restrict key** → tick **Safe Browsing API** only.
   - **Application restrictions → None** is the simplest reliable option.
     **IP addresses** also works if you list the server's IPv4 *and* IPv6.
     **Websites** will NOT work (see the referrer warning above).
5. Paste the key into **Settings → API Keys → Health Check API Keys → Google Safe Browsing** → Save.

## PageSpeed Insights (Core Web Vitals)

1. Enable the **PageSpeed Insights API**:
   [direct enable link](https://console.developers.google.com/apis/api/pagespeedonline.googleapis.com/overview).
2. Create an API key the same way (Credentials → Create credentials → API key).
3. Restrict it: **API restrictions → PageSpeed Insights API**; **Application restrictions → None**
   (or IP with IPv4 + IPv6).
4. Paste into **Settings → API Keys → Health Check API Keys → PageSpeed Insights** → Save.

> A mobile Lighthouse run on a slow site can legitimately take tens of seconds. If it
> can't finish in time you'll see `PageSpeed timed out after 45 s` — re-run the check;
> if it happens every time, the page is genuinely heavy for Lighthouse.

You can use the **same Google key for both Safe Browsing and PageSpeed** — then tick both
APIs in the key's API restrictions.

## VirusTotal

1. Register free at [virustotal.com](https://www.virustotal.com).
2. Click your avatar → **API key** ([direct link](https://www.virustotal.com/gui/my-apikey)) and copy the key.
3. Paste into **Settings → API Keys → Health Check API Keys → VirusTotal** → Save.

Free quota is 4 requests/min and 500/day — plenty for periodic health checks. VirusTotal
offers no key restrictions; keep the key private. Brand-new domains may return `not_found`
until they enter VirusTotal's corpus — that is normal and not an error on your side.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Safe Browsing API has not been used in project ... before or it is disabled` | The API is not enabled in the key's project | Enable it via the link in the error, wait a few minutes, re-run |
| `Requests from referer <empty> are blocked` | Key has a **Websites** (HTTP referrer) restriction | Application restrictions → **None** (or IP addresses); server calls have no Referer |
| `The provided API key has an IP address restriction. The originating IP address of the call (...) violates this restriction` | Server called from an IP not on the list — commonly the server's **IPv6** | Add the IP named in the error, or set Application restrictions → None |
| `PageSpeed timed out after 45 s` / `The operation was aborted due to timeout` | Lighthouse couldn't finish the lab run in the time budget | Re-run the check; recurring on the same site means the page is genuinely slow |
| VirusTotal `not_found` | Domain not yet in VirusTotal's corpus (fresh domains) | Normal; retry later |

## Where the keys live

Keys are entered per browser (`healthKey_*` in localStorage) and mirrored to your own
instance through the settings sync — the same backup every other OpenGSC key uses, so
they survive a cleared browser and are available to your team. When a check runs, the
server reads the key and calls the provider directly; nothing is sent anywhere except
the provider itself.
