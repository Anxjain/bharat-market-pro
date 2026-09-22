# Bharat Market Pro — single-image app (API + built frontend). Includes Chromium for the
# headless ULIP adapters (SBI / ICICI Pru). Build context = this folder ("1").
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Supabase auth keys are BUILD-TIME for the frontend (Vite bakes import.meta.env into
# the bundle). Pass them as build args so login/watchlist-sync works in the image;
# leave unset to ship an anonymous (browser-local watchlist) build.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
# Frontend deps + build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build            # tsc -b && vite build -> server/dist
# Server deps (separate package). Skip Puppeteer's bundled Chromium download — the
# runtime stage installs system chromium and points CHROMIUM_PATH at it.
ENV PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app/server
RUN npm ci --no-audit --no-fund
# Fail the build on a server-side type error (prod runs raw TS via tsx, so this is
# the only gate that catches type errors before they hit the VM at runtime).
RUN npm run typecheck

FROM node:22-bookworm-slim AS runtime
# Chromium + fonts for headless adapters (puppeteer uses the system binary).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation postgresql-client tini \
      poppler-utils python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
# PyMuPDF powers the deterministic (no-LLM) ULIP factsheet extractors in
# server/extractors/. This is the PRIMARY parse path — without it, factsheet ingestion
# falls back to the optional LLM route. --break-system-packages: Debian marks the system
# Python "externally managed" (PEP 668); this is a single-purpose container, not a shared
# host, so installing into it is the intended behaviour.
RUN pip3 install --no-cache-dir --break-system-packages pymupdf
ENV CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    ULIP_PYTHON=python3 \
    NODE_ENV=production \
    PORT=9787
WORKDIR /app/server
# App code + built artifacts from the build stage
COPY --from=build /app/server ./
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/drizzle ./drizzle
# The server imports the frontend's seed data at runtime (server/src/index.ts ->
# ../../src/data/*), so the runtime image needs /app/src too — without it the
# container crashes on boot with ERR_MODULE_NOT_FOUND for /app/src/data/companies.
COPY --from=build /app/src /app/src
# Run as the unprivileged `node` user (shipped in the base image). Every dir the app
# writes lives under /data (raw archive, factsheet library, intake drop-box) — /app
# stays root-owned, so a write path pointing there fails with EACCES (this is exactly
# what broke the monthly factsheet fetch when FACTSHEET_DIR defaulted to
# /app/factsheets; compose now pins ULIP_FACTSHEET_DIR/ULIP_INTAKE_DIR to /data).
# Pre-create + chown them so named volumes initialize node-owned on first mount.
# (For an EXISTING volume on the VM, chown it once:
# `docker compose exec -u root app chown -R node:node /data/raw`.)
RUN mkdir -p /data/raw /data/factsheets /data/intake && chown -R node:node /data /app/src /app/server
USER node
EXPOSE 9787
# tini for proper signal handling; migrations run on boot (ensureSchema)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
