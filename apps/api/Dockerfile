# syntax=docker/dockerfile:1.7
# Control-plane API image (@everdict/api, Fastify :8787).
# Build from the monorepo context (repo root):
#   docker build -f apps/api/Dockerfile --target runtime -t everdict-api .
# compose selects the target: dev (bind-mount · hot reload) / runtime (build output).

# ---- base: common runtime tools ----
FROM node:22-bookworm-slim AS base
# git: RepoEnvironment seed + git-diff snapshot. claude CLI: the claude-code harness (under test)
# that LocalBackend runs in-process. ca-certificates: TLS. (works without claude if you only run the scripted harness)
# Enterprise proxy / air-gapped build (gap 17). Proxy: HTTP_PROXY/HTTPS_PROXY/NO_PROXY are Docker PREDEFINED build args
# — `docker build --build-arg HTTP_PROXY=http://proxy:3128 …` routes apt/npm/corepack through a corporate proxy with no
# Dockerfile change. CA_CERT: for a MITM proxy that re-signs TLS, pass its root CA (PEM) so apt/npm/corepack trust it
# (`--build-arg CA_CERT="$(cat corp-root.crt)"`). Fully air-gapped (no proxy): also point pnpm/npm at an internal
# registry mirror (an .npmrc), since corepack fetches pnpm@<pinned> at build.
ARG CA_CERT=""
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && if [ -n "$CA_CERT" ]; then printf '%s' "$CA_CERT" > /usr/local/share/ca-certificates/corp-proxy.crt && update-ca-certificates; fi \
  && npm i -g @anthropic-ai/claude-code \
  && corepack enable
WORKDIR /app

# ---- dev: compose bind-mounts the source; here we only add tools ----
FROM base AS dev
ENV NODE_ENV=development
# Hot reload: the api package regenerates dist via tsc -w + restarts via node --watch (the compose command may override this).
CMD ["sh","-lc","pnpm install --frozen-lockfile && pnpm --filter @everdict/api... build && (node_modules/.bin/tsc -p apps/api/tsconfig.json --watch --preserveWatchOutput & exec node --watch apps/api/dist/main.js)"]

# ---- builder: install the whole workspace + build api (+ its dependency packages) ----
FROM base AS builder
ENV NODE_ENV=development
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@everdict/api..." build

# ---- runtime: build output + node_modules only ----
FROM base AS runtime
ENV NODE_ENV=production PORT=8787
# pnpm's virtual store (node_modules/.pnpm) uses relative symlinks inside /app, so a wholesale copy preserves it.
COPY --from=builder /app /app
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/api/dist/main.js"]
