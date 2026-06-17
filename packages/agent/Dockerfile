# 러너 에이전트 이미지 — Nomad/K8s 가 이걸 잡으로 띄운다.
# 빌드(레포 루트에서): docker build -f packages/agent/Dockerfile -t <registry>/assay-agent:<tag> .
FROM node:22-bookworm-slim

# git(환경 시드) + claude CLI(피평가 하니스) 사전설치
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g @anthropic-ai/claude-code

WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @assay/agent... build

# AgentJob 은 ASSAY_AGENT_JOB(base64 JSON) env 로, 인증은 CLAUDE_CODE_OAUTH_TOKEN 등으로 주입
ENTRYPOINT ["node", "packages/agent/dist/main.js"]
