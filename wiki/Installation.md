# Installation

Two supported ways to run OpenGSC:

- **The one-line VPS installer** (recommended): Node.js + PM2 + Nginx + Let's Encrypt, set up for you. Covered on this page.
- **Docker**: see [Docker](Docker).

Before either, create the Google OAuth app: [Google Cloud Setup](Google-Cloud-Setup).

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 / 24.04 LTS |
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB + swap | 2 GB (+ swap for builds) |
| Disk | 10 GB SSD | 20 GB SSD |
| Domain | **required** | with SSL (Let's Encrypt) |
| Node.js | 22.12+ | 24 LTS (installed for you) |

Other Debian-based distributions usually work. CentOS/RHEL and Windows servers aren't supported. For local development on macOS or Windows, see [For Developers](For-Developers).

### Memory and swap

Running OpenGSC needs little memory. **Building** it doesn't: `next build` (Turbopack) peaks around **2.4 GB**. On a 2 GB server without swap the kernel kills the build and you see a bare `Killed` ([#21](https://github.com/fenjo26/OpenGSC/issues/21)).

`install.sh` and `update.sh` handle this themselves. When RAM + swap is under ~3 GB they create a 4 GB swapfile before building (2 GB if disk is tight). If you build by hand, add swap once:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab   # keep it after reboot
```

## One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/fenjo26/opengsc/main/install.sh | sudo bash
```

What it does, in order:

1. Clones the repository into **`/root/opengsc`** (or pulls if the folder exists).
2. Asks for the domain, whether to install Nginx, whether to set up SSL, and the SSL e-mail.
3. Installs system packages, **Node.js 24 LTS** and **PM2**.
4. Writes `.env` (skipped if `.env` already exists): a random `NEXTAUTH_SECRET`, `NEXTAUTH_URL` built from your answers, the database at `/root/opengsc/data/prod.db`, and the Google Client ID / Secret it asks you for. It prints the exact redirect URI to paste into Google Cloud.
5. `npm install`, `prisma generate`, `prisma db push`, `npm run build` (adds swap first if needed).
6. Starts the app with PM2 as **`opengsc`** on port **3000** and registers PM2 to start on boot.
7. Optionally configures **Nginx** as a reverse proxy and issues a **Let's Encrypt** certificate with Certbot. See [Nginx: which package, and security updates](#nginx-which-package-and-security-updates) below.
8. Opens ports 22/80/443 in **UFW** (and 3000 when there's no Nginx).

When it finishes it prints the URL to open. Then continue with [First Login, Accounts and Team](First-Login-and-Team).

### Nginx: which package, and security updates

- **No nginx on the server yet** → the installer adds nginx.org's official repository (stable branch, signing key checked against its published fingerprints) and installs from there, so security releases arrive with a normal `apt upgrade`. The site file goes to `/etc/nginx/conf.d/opengsc.conf`. If nginx.org has no packages for your release or cannot be reached, it falls back to the distribution's nginx and says so.
- **nginx already installed** → it is kept as it is, never replaced by another package (that would change the config layout under any other sites on the server). The installer only applies pending security updates from the same source, keeping your config files. The site file goes where your nginx reads sites: `/etc/nginx/sites-available/opengsc` on a Debian/Ubuntu-packaged nginx.
- **At the end, and on every update from the UI**, a read-only check reports whether your nginx has the 2026-11-18 security fixes (1.30.7 / 1.31.9, CVE-2026-123007 and nine more) and warns if HTTP/2 is enabled on a build without them. It never edits your nginx config.

Check by hand:

```bash
nginx -v                                   # nginx.org build: 1.30.7+ (stable) or 1.31.9+ (mainline)
zgrep -h CVE-2026-123007 /usr/share/doc/nginx*/changelog.Debian.gz   # distribution build: fix present?
grep -rn http2 /etc/nginx/                 # HTTP/2 on = the remote-code-execution path until patched
```

Until a fixed build is installed, removing `http2` from the `listen` lines (or `http2 off;`) and `nginx -t && systemctl reload nginx` closes the code-execution path; the other fixes still need the upgrade.

### Answers and the URL you get

| Domain | Nginx | SSL | `NEXTAUTH_URL` |
|---|---|---|---|
| `gsc.example.com` | Y | Y | `https://gsc.example.com` (recommended) |
| `gsc.example.com` | Y | N | `http://gsc.example.com` |
| `gsc.example.com` | N | – | `http://gsc.example.com:3000` |
| `localhost` | – | – | `http://localhost:3000` (reach it with `ssh -L 3000:localhost:3000 root@server`) |

Whatever `NEXTAUTH_URL` ends up as, the Google redirect URI must be `NEXTAUTH_URL` + `/api/auth/callback/google`.

### Re-running the installer

The installer won't overwrite an existing `.env`. To start over with a different domain, run `rm /root/opengsc/.env && bash /root/opengsc/install.sh`. Your database in `data/` is kept.

## Manual installation

```bash
git clone https://github.com/fenjo26/opengsc.git /root/opengsc
cd /root/opengsc

# Node.js 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs
npm install -g pm2

# Dependencies (--include=dev matters: the build needs Tailwind/TypeScript)
npm install --include=dev

# Configuration
cp .env.template .env
nano .env        # see Configuration Reference

# Database and build
npx prisma generate
npx prisma db push
node scripts/seed-rag.mjs      # optional: Casino RAG knowledge base for igaming outlines
npm run build

# Run
pm2 start npm --name opengsc -- start
pm2 save
pm2 startup
```

Use an **absolute** `DATABASE_URL` (`file:/root/opengsc/data/prod.db`). A relative path resolves against whatever directory the process starts in, and the database seems to "disappear" after a restart. Keep the database under `data/`: that folder is gitignored, so `git reset --hard` during an update can't touch it.

Then put a reverse proxy with TLS in front of port 3000. A minimal Nginx site:

```nginx
server {
    server_name gsc.example.com;
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Then `certbot --nginx -d gsc.example.com`.

## Managing the process

```bash
pm2 status                         # is it running?
pm2 logs opengsc                   # live logs (most problems are explained here)
pm2 logs opengsc --lines 200       # last 200 lines
pm2 restart opengsc --update-env   # restart and re-read .env
pm2 stop opengsc
```

If the server hosts other PM2 apps, set `PM2_PROC_NAME=opengsc` in `.env`. Without it, the updater falls back to `pm2 stop all` during the build window.

## Databases

**SQLite is the only fully supported production database.** It's a single file, needs no server, and backups are a file copy. MySQL/MariaDB work as an experimental port: set `DATABASE_URL="mysql://…"` and the Prisma config switches schema automatically. Feature parity isn't promised (for example `execute_sql_query` in MCP needs SQLite, and very long URLs don't fit MySQL indexed columns). See [TESTING-MYSQL.md](https://github.com/fenjo26/OpenGSC/blob/main/docs/TESTING-MYSQL.md).

## Next

- [First Login, Accounts and Team](First-Login-and-Team)
- [Configuration Reference](Configuration-Reference)
- [Updating and Backups](Updating-and-Backups)
