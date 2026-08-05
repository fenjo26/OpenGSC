#!/usr/bin/env bash
set -e

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}▶ $*${NC}"; }
success() { echo -e "${GREEN}✔ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }
error()   { echo -e "${RED}✖ $*${NC}"; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──────────────────────────────────────${NC}"; }

# read from /dev/tty so it works both when run directly AND via curl | bash
ask() {
  local __var="$1" __prompt="$2" __default="$3"
  printf "  %s" "$__prompt" > /dev/tty
  local __val
  IFS= read -r __val < /dev/tty
  __val="${__val:-$__default}"
  printf -v "$__var" '%s' "$__val"
}
ask_secret() {
  local __var="$1" __prompt="$2"
  printf "  %s" "$__prompt" > /dev/tty
  local __val
  IFS= read -rs __val < /dev/tty
  echo > /dev/tty
  printf -v "$__var" '%s' "$__val"
}

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║      OpenGSC — VPS Installer v1.0        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── Root check ───────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Run as root: sudo bash install.sh"
fi

# ─── OS check ─────────────────────────────────────────────────────────────────
if ! command -v apt-get &>/dev/null; then
  error "Only Debian/Ubuntu supported. For other distros install Node.js 22+ manually."
fi

# ─── Auto-clone if running via curl | bash ────────────────────────────────────
# Detect: if package.json is missing we're not inside the repo yet
REPO_URL="https://github.com/fenjo26/opengsc.git"
INSTALL_DIR="/root/opengsc"

if [ ! -f "package.json" ]; then
  header "Cloning repository"
  if ! command -v git &>/dev/null; then
    info "Installing git..."
    apt-get update -qq && apt-get install -y -qq git
  fi
  if [ -d "$INSTALL_DIR" ]; then
    info "Directory $INSTALL_DIR already exists — pulling latest..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    info "Cloning into $INSTALL_DIR ..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  success "Repository ready at $INSTALL_DIR"
  # Re-exec install.sh from inside the cloned repo (cd first so package.json is found)
  cd "$INSTALL_DIR"
  exec bash "$INSTALL_DIR/install.sh" "$@"
fi

# ─── Collect config ───────────────────────────────────────────────────────────
header "Configuration"

ask DOMAIN    "Domain or server IP (e.g. seo.example.com or 1.2.3.4): " "localhost"
ask INSTALL_NGINX "Install Nginx reverse proxy? [Y/n]: " "Y"
ask SETUP_SSL "Setup SSL with Let's Encrypt? (only if real domain) [y/N]: " "N"
APP_PORT=3000

echo ""

# ─── Wait for apt lock ────────────────────────────────────────────────────────
wait_apt() {
  local i=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock &>/dev/null; do
    if [ $i -eq 0 ]; then
      info "Waiting for apt lock to be released (background updates running)..."
    fi
    sleep 5
    i=$((i+1))
    if [ $i -ge 60 ]; then
      LOCK_PID=$(fuser /var/lib/dpkg/lock-frontend 2>/dev/null | tr -d ' ')
      error "apt lock held for too long. Run: sudo kill ${LOCK_PID} && sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock && sudo dpkg --configure -a"
    fi
  done
}

# ─── System packages ──────────────────────────────────────────────────────────
header "System packages"
wait_apt
info "Updating package lists..."
apt-get update -qq

wait_apt
info "Installing curl, git, unzip..."
apt-get install -y -qq curl git unzip build-essential

success "System packages ready"

# ─── Node.js 24 (Active LTS) ──────────────────────────────────────────────────
#
# Was 20, which reached end of life on 30 April 2026 — no more security patches. A version
# pinned in an installer is a decision made on behalf of everyone who runs it, so it tracks
# Active LTS rather than whatever worked when the line was written.
#
# The check below accepts 22 as well: it is still in maintenance until April 2027, and an
# instance already running it does not need a major version change forced on it mid-install.
# Anything older is replaced.
header "Node.js"
if command -v node &>/dev/null && [ "$(node -e "console.log(process.versions.node.split('.')[0])")" -ge 22 ]; then
  success "Node.js $(node -v) already installed"
else
  info "Installing Node.js 24 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
  success "Node.js $(node -v) installed"
fi

# ─── PM2 ──────────────────────────────────────────────────────────────────────
header "PM2 (process manager)"
if command -v pm2 &>/dev/null; then
  success "PM2 already installed"
else
  info "Installing PM2..."
  npm install -g pm2 --silent
  success "PM2 installed"
fi

# ─── App dependencies ─────────────────────────────────────────────────────────
header "App dependencies"
info "Running npm install..."
# --include=dev for the same reason as update.sh: the build needs Tailwind, its PostCSS plugin
# and TypeScript, all of which are devDependencies that npm skips when NODE_ENV=production is
# set in the environment this script happens to inherit.
npm install --include=dev --silent
# A successful npm install is not the same as a usable one — see the comment in update.sh.
node scripts/check-native-deps.mjs || error "Dependencies installed but not usable — see above."
success "Dependencies installed"

# ─── .env ─────────────────────────────────────────────────────────────────────
header ".env"
if [ -f ".env" ]; then
  warn ".env already exists — skipping. Edit manually if needed."
else
  info "Generating .env..."

  if command -v openssl &>/dev/null; then
    SECRET=$(openssl rand -base64 32)
  else
    SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  fi

  # Determine URL
  if [[ "$DOMAIN" == "localhost" || "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEXTAUTH_URL="http://${DOMAIN}:${APP_PORT}"
  else
    if [[ "${SETUP_SSL^^}" == "Y" ]]; then
      NEXTAUTH_URL="https://${DOMAIN}"
    else
      NEXTAUTH_URL="http://${DOMAIN}"
    fi
  fi

  echo ""
  echo -e "${YELLOW}  Google OAuth credentials are required for login.${NC}"
  echo -e "  Create them at: ${CYAN}https://console.cloud.google.com${NC}"
  echo -e "  APIs & Services → Credentials → Create OAuth 2.0 Client ID"
  echo -e "  Redirect URI: ${CYAN}${NEXTAUTH_URL}/api/auth/callback/google${NC}"
  echo ""
  ask        GOOGLE_CLIENT_ID     "Google Client ID: " ""
  ask_secret GOOGLE_CLIENT_SECRET "Google Client Secret: "

  DB_PATH="$(pwd)/data/prod.db"
  mkdir -p "$(pwd)/data"

  cat > .env <<EOF
DATABASE_URL="file:${DB_PATH}"

# NextAuth
NEXTAUTH_SECRET="${SECRET}"
NEXTAUTH_URL="${NEXTAUTH_URL}"

# Google OAuth
# Redirect URI: ${NEXTAUTH_URL}/api/auth/callback/google
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET}"
EOF

  success ".env created (NEXTAUTH_URL=${NEXTAUTH_URL})"
fi

# ─── Build ────────────────────────────────────────────────────────────────────
header "Database & Build"
info "Generating Prisma client..."
npx prisma generate 2>/dev/null

info "Pushing database schema..."
npx prisma db push 2>/dev/null

info "Seeding Casino RAG knowledge base..."
node scripts/seed-rag.mjs || warn "RAG seed skipped (non-fatal) — run 'node scripts/seed-rag.mjs' manually"

info "Building Next.js..."
npm run build

success "Build complete"

# ─── PM2 start ────────────────────────────────────────────────────────────────
header "Starting app with PM2"

pm2 delete opengsc 2>/dev/null || true
pm2 start npm --name opengsc -- start -- -p "$APP_PORT"
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

success "App running on port ${APP_PORT} (pm2 name: opengsc)"

# ─── Nginx ────────────────────────────────────────────────────────────────────
if [[ "${INSTALL_NGINX^^}" == "Y" ]]; then
  header "Nginx"

  if ! command -v nginx &>/dev/null; then
    wait_apt
    info "Installing Nginx..."
    apt-get install -y -qq nginx
  fi

  NGINX_CONF="/etc/nginx/sites-available/opengsc"

  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 10M;

    location / {
        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout    300s;
        proxy_connect_timeout 300s;
        proxy_send_timeout    300s;
    }
}
EOF

  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/opengsc
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  nginx -t && systemctl reload nginx

  success "Nginx configured → http://${DOMAIN}"

  # ─── SSL ──────────────────────────────────────────────────────────────────
  if [[ "${SETUP_SSL^^}" == "Y" ]]; then
    header "SSL (Let's Encrypt)"
    wait_apt
    apt-get install -y -qq certbot python3-certbot-nginx
    ask SSL_EMAIL "Email for SSL certificate (Let's Encrypt): " "admin@${DOMAIN}"
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "${SSL_EMAIL}" || \
      warn "SSL setup failed — make sure the domain points to this server's IP"
    success "SSL certificate installed"
  fi
fi

# ─── Firewall ─────────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  header "Firewall"
  ufw allow OpenSSH  > /dev/null 2>&1 || true
  ufw allow 80/tcp   > /dev/null 2>&1 || true
  ufw allow 443/tcp  > /dev/null 2>&1 || true
  if [[ "${INSTALL_NGINX^^}" != "Y" ]]; then
    ufw allow "${APP_PORT}/tcp" > /dev/null 2>&1 || true
  fi
  ufw --force enable > /dev/null 2>&1 || true
  success "UFW firewall configured"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          ✔ Installation complete!        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""

if [[ "${INSTALL_NGINX^^}" == "Y" ]]; then
  if [[ "${SETUP_SSL^^}" == "Y" ]]; then
    echo -e "  Open: ${CYAN}https://${DOMAIN}${NC}"
  else
    echo -e "  Open: ${CYAN}http://${DOMAIN}${NC}"
  fi
else
  echo -e "  Open: ${CYAN}http://${DOMAIN}:${APP_PORT}${NC}"
fi

echo ""
echo -e "  Sign in with your Google account on first visit."
echo -e "  The first account becomes the owner of the dashboard."
echo -e "  Add more Google accounts via Settings to pull GSC data from all of them."
echo ""
echo -e "  PM2 commands:"
echo -e "    ${CYAN}pm2 logs opengsc${NC}     — view logs"
echo -e "    ${CYAN}pm2 restart opengsc${NC}  — restart"
echo -e "    ${CYAN}pm2 stop opengsc${NC}     — stop"
echo ""
