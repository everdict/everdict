# syntax=docker/dockerfile:1.7
# Conversational-agent image (@everdict/agent, Fastify :8790).
# Build from the monorepo context (repo root):
#   docker build -f apps/agent/Dockerfile --target runtime -t everdict-agent .
# compose selects the target: dev (bind-mount · hot reload) / runtime (build output).
# Mirrors apps/api/Dockerfile (the proven control-plane image pattern) — same base + monorepo build,
# only the package filter (@everdict/agent), port (8790), entrypoint, and healthcheck differ.

# ---- base: common runtime tools ----
FROM node:22-bookworm-slim AS base
# git: repo ops a LocalDriver code tool may need. claude CLI: kept for control-plane parity — the default agent uses
# provider-native LLM (@everdict/llm), NOT the claude-code harness, so this is droppable for a leaner image later.
# ca-certificates: TLS for the LLM provider + control-plane calls.
# Enterprise proxy / air-gapped build (gap 17). Proxy: HTTP_PROXY/HTTPS_PROXY/NO_PROXY are Docker PREDEFINED build args
# — `docker build --build-arg HTTP_PROXY=http://proxy:3128 …` routes apt/npm/corepack through a corporate proxy with no
# Dockerfile change. CA_CERT: for a MITM proxy that re-signs TLS, pass its root CA (PEM) so apt/npm/corepack trust it
# (`--build-arg CA_CERT="$(cat corp-root.crt)"`).
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
# Hot reload: regenerate dist via tsc -w + restart via node --watch (the compose command may override this).
CMD ["sh","-lc","pnpm install --frozen-lockfile && pnpm --filter @everdict/agent... build && (node_modules/.bin/tsc -p apps/agent/tsconfig.json --watch --preserveWatchOutput & exec node --watch apps/agent/dist/main.js)"]

# ---- builder: install the whole workspace + build agent (+ its dependency packages) ----
FROM base AS builder
ENV NODE_ENV=development
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@everdict/agent..." build

# ---- runtime: build output + node_modules only ----
FROM base AS runtime
ENV NODE_ENV=production PORT=8790
# pnpm's virtual store (node_modules/.pnpm) uses relative symlinks inside /app, so a wholesale copy preserves it.
COPY --from=builder /app /app
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/agent/dist/main.js"]
