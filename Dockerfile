# OpenGSC — self-hosted Docker image.
# Build:  docker compose build   (or: docker build -t opengsc .)
# Run:    docker compose up -d   (see compose.yaml / docs/DOCKER-SETUP.md)

FROM node:24-bookworm-slim AS build
WORKDIR /app

# Native build tools for better-sqlite3 (its prebuilds usually suffice on x64,
# but this keeps arm64/unusual platforms working too).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `prisma generate`, which needs DATABASE_URL to exist (value unused for generate)
ENV DATABASE_URL="file:/data/prod.db"
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_URL="file:/data/prod.db"

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && mkdir -p /data

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/docker-entrypoint.sh"]
