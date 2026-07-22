# Job-runner image — Nomad/K8s launch this as a job.
# Build (from repo root): docker build -f packages/job-runner/Dockerfile -t <registry>/everdict-job-runner:<tag> .
FROM node:22-bookworm-slim

# Preinstall git (environment seed) + claude CLI (harness under test) + python3/venv/pip (setup for
# declarative command harnesses — e.g. installing a Python CLI agent into a venv)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g @anthropic-ai/claude-code

# batteries-included: preinstall a common OSS CLI agent (aider) into a dedicated venv → fast and
# stable, no pip install per run. A command harness spec can leave setup empty and just call `aider …`
# (on PATH); to pin a different version, install it via setup.
RUN python3 -m venv /opt/aider \
  && /opt/aider/bin/pip install --no-cache-dir -q aider-chat \
  && ln -s /opt/aider/bin/aider /usr/local/bin/aider
ENV AIDER_BIN=/opt/aider/bin/aider

WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @everdict/job-runner... build

# CaseJob is injected via the EVERDICT_CASE_JOB env (base64 JSON); auth via CLAUDE_CODE_OAUTH_TOKEN etc.
ENTRYPOINT ["node", "packages/job-runner/dist/main.js"]
