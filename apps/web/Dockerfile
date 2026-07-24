# syntax=docker/dockerfile:1.7
# SaaS web image (@everdict/web, Next.js 16 :3001).
# Build from the monorepo context (repo root):
#   docker build -f apps/web/Dockerfile --target runtime -t everdict-web .
# The web has no @everdict/* runtime deps (pure HTTP client), but the pnpm workspace install needs the root context.

# ---- base: shared tooling ----
FROM node:22-bookworm-slim AS base
# Enterprise proxy / air-gapped build (gap 17): HTTP_PROXY/HTTPS_PROXY/NO_PROXY are Docker PREDEFINED build args (pass
# --build-arg to route apt/npm/corepack through a corporate proxy, no Dockerfile change). CA_CERT installs a MITM
# proxy's root CA so TLS is trusted. Full air-gap also needs an internal npm/pnpm registry mirror (corepack fetches pnpm).
ARG CA_CERT=""
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && if [ -n "$CA_CERT" ]; then printf '%s' "$CA_CERT" > /usr/local/share/ca-certificates/corp-proxy.crt && update-ca-certificates; fi \
  && corepack enable
WORKDIR /app

# ---- dev: source is bind-mounted by compose, next dev hot reload ----
FROM base AS dev
ENV NODE_ENV=development
CMD ["sh","-lc","pnpm install --frozen-lockfile && pnpm --filter @everdict/web dev"]

# ---- builder: install + next build ----
# Do NOT set NODE_ENV (same condition as a host build):
#  - production makes pnpm skip devDeps (@tailwindcss/postcss etc.) -> next build postcss breaks.
#  - development breaks React during next build prerender (_global-error useContext null).
#  When unset, devDeps are installed and next build internally performs a production build.
FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@everdict/web..." build

# ---- runtime: build output (.next) + node_modules for next start ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=builder /app /app
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# next start -H 0.0.0.0 -p 3001 (apps/web's start script)
CMD ["pnpm","--filter","@everdict/web","start"]
