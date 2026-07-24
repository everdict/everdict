# syntax=docker/dockerfile:1.7
# CLI image (@everdict/cli) — used as the durable Temporal WORKER in a deployment:
#   node apps/cli/dist/main.js worker --temporal-address <addr>
# The worker polls the Temporal task queue and runs the workflow activities. On the scorecard-batch and
# scheduled-fire paths those activities bridge back to the control-plane API over /internal/** (EVERDICT_API_URL +
# EVERDICT_INTERNAL_TOKEN), so the real dispatch — and the self-hosted runner lease hub — stay in the API process.
# Build from the monorepo context (repo root):
#   docker build -f apps/cli/Dockerfile --target runtime -t everdict-worker .

# ---- base: common runtime tools ----
FROM node:22-bookworm-slim AS base
# git: RepoEnvironment seed for any local-backend dispatch the worker performs directly. ca-certificates: TLS.
# Enterprise proxy / air-gapped build (gap 17): HTTP_PROXY/HTTPS_PROXY/NO_PROXY are Docker PREDEFINED build args (pass
# --build-arg to route apt/corepack through a corporate proxy). CA_CERT installs a MITM proxy's root CA (TLS trust).
ARG CA_CERT=""
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && if [ -n "$CA_CERT" ]; then printf '%s' "$CA_CERT" > /usr/local/share/ca-certificates/corp-proxy.crt && update-ca-certificates; fi \
  && corepack enable
WORKDIR /app

# ---- builder: install the whole workspace + build the cli (+ its dependency packages, incl. @everdict/orchestrator) ----
FROM base AS builder
ENV NODE_ENV=development
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@everdict/cli..." build

# ---- runtime: build output + node_modules only ----
FROM base AS runtime
ENV NODE_ENV=production
# pnpm's virtual store (node_modules/.pnpm) uses relative symlinks inside /app, so a wholesale copy preserves it.
COPY --from=builder /app /app
# The worker connects out to Temporal + the API; it exposes no port of its own.
# Default command runs the worker against the compose Temporal service; compose overrides the address as needed.
CMD ["node","apps/cli/dist/main.js","worker","--temporal-address","temporal:7233"]
