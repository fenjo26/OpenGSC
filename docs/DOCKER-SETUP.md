# Docker Setup

An alternative to the one-line VPS installer (`install.sh`) for anyone who prefers containers —
local use, a NAS, or a VPS that already runs Docker. The app itself is identical; only the
process management differs (Docker instead of PM2/Nginx).

## Prerequisites

- Docker with the Compose plugin ([get Docker](https://docs.docker.com/get-docker/))
- A Google OAuth client (same 5-minute setup as the main install — see the
  [README](../README.md#-installation), step 1)

> ⚠️ The domain requirement still applies for anything internet-facing: Google OAuth does not
> accept bare IPs. For local use, `http://localhost:3000` works fine as the OAuth origin.

> ⚠️ The **build** stage compiles the app with Turbopack, which peaks around 2.4 GB of memory —
> and a container cannot add swap to paper over a shortage, so the memory has to be real
> (Docker Desktop: check the VM's allocation). The running container is far lighter; a 1 GB
> limit works fine once the image is built.

## Quickstart

```bash
git clone https://github.com/fenjo26/opengsc.git
cd opengsc

cp .env.template .env
nano .env         # set NEXTAUTH_SECRET, NEXTAUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

docker compose up -d --build
```

Open `http://localhost:3000` (or whatever `NEXTAUTH_URL` you configured) and sign in with Google.

Notes:

- `DATABASE_URL` in `.env` is ignored — inside the container the SQLite file always lives at
  `/data/prod.db` on the `opengsc-data` named volume, so it survives rebuilds and updates.
- The container runs `prisma db push` on every start, which applies schema changes
  automatically after updates.
- `PORT=8080 docker compose up -d` changes the host port.

## Updating

```bash
git pull
docker compose up -d --build
```

## Reverse proxy / SSL

For an internet-facing deployment put any reverse proxy in front (Caddy, Traefik, Nginx) and
point `NEXTAUTH_URL` at the public HTTPS URL. Minimal Caddy example:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

Remember: `NEXTAUTH_URL` must exactly match the Authorized redirect URI configured in Google
Cloud Console (`https://your-domain.com/api/auth/callback/google`), including the scheme.

## Other platforms (Railway, Fly.io, …)

The image keeps all state in `/data/prod.db` and deliberately declares no Docker `VOLUME` —
on PaaS platforms anonymous volumes are either unsupported or silently lose the database
between deploys (each deploy starts a fresh container). If you deploy the image outside
Compose, attach a volume to `/data` through the platform's own mechanism (on Railway:
service → Volumes → new volume, mount path `/data`). Without a mounted `/data` the database
lives in the container's writable layer and is wiped on every redeploy.

## Backups

Everything lives in one SQLite file on the volume:

```bash
docker compose cp opengsc:/data/prod.db ./backup-$(date +%F).db
```

## Troubleshooting

- **`redirect_uri_mismatch`** — `NEXTAUTH_URL` doesn't match the redirect URI in Google Console
  (see the main [README troubleshooting](../README.md#troubleshooting)).
- **Container restarts in a loop** — `docker compose logs opengsc`; the most common cause is a
  malformed `.env` (quotes/spaces around values are fine, missing `NEXTAUTH_SECRET` is not).
- **Where is my data?** — `docker volume inspect opengsc_opengsc-data` shows the host path.
