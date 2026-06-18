# 러너 에이전트 이미지 — Nomad/K8s 가 이걸 잡으로 띄운다.
# 빌드(레포 루트에서): docker build -f packages/agent/Dockerfile -t <registry>/assay-agent:<tag> .
FROM node:22-bookworm-slim

# git(환경 시드) + claude CLI(피평가 하니스) + python3/venv/pip(선언형 command 하니스의 setup —
# 예: Python CLI 에이전트를 venv 에 설치) 사전설치
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g @anthropic-ai/claude-code

# batteries-included: 흔한 OSS CLI 에이전트(aider)를 전용 venv 에 사전설치 → 매 run pip 설치 없이 빠르고
# 안정적. command 하니스 spec 은 setup 을 비우고 `aider …`(PATH) 만 쓰면 된다(원하면 setup 으로 다른 버전 설치).
RUN python3 -m venv /opt/aider \
  && /opt/aider/bin/pip install --no-cache-dir -q aider-chat \
  && ln -s /opt/aider/bin/aider /usr/local/bin/aider
ENV AIDER_BIN=/opt/aider/bin/aider

WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @assay/agent... build

# AgentJob 은 ASSAY_AGENT_JOB(base64 JSON) env 로, 인증은 CLAUDE_CODE_OAUTH_TOKEN 등으로 주입
ENTRYPOINT ["node", "packages/agent/dist/main.js"]
