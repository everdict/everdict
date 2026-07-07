# syntax=docker/dockerfile:1.7
# 컨트롤플레인 API 이미지 (@everdict/api, Fastify :8787).
# 모노레포 컨텍스트(레포 루트)에서 빌드한다:
#   docker build -f apps/api/Dockerfile --target runtime -t everdict-api .
# compose 가 target 으로 dev(바인드마운트·핫리로드) / runtime(빌드 산출물) 을 선택한다.

# ---- base: 공통 런타임 도구 ----
FROM node:22-bookworm-slim AS base
# git: RepoEnvironment 시드 + git-diff 스냅샷. claude CLI: LocalBackend 가 in-process 로 돌리는
# claude-code 하니스(피평가). ca-certificates: TLS. (scripted 하니스만 돌릴 거면 claude 없이도 동작)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g @anthropic-ai/claude-code \
  && corepack enable
WORKDIR /app

# ---- dev: 소스는 compose 가 바인드마운트, 여기선 도구만 ----
FROM base AS dev
ENV NODE_ENV=development
# 핫리로드: api 패키지 tsc -w 로 dist 재생성 + node --watch 로 재시작(compose command 가 덮어쓸 수 있음).
CMD ["sh","-lc","pnpm install --frozen-lockfile && pnpm --filter @everdict/api... build && (node_modules/.bin/tsc -p apps/api/tsconfig.json --watch --preserveWatchOutput & exec node --watch apps/api/dist/main.js)"]

# ---- builder: 전체 워크스페이스 설치 + api(+의존 패키지) 빌드 ----
FROM base AS builder
ENV NODE_ENV=development
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@everdict/api..." build

# ---- runtime: 빌드 산출물 + node_modules 만 ----
FROM base AS runtime
ENV NODE_ENV=production PORT=8787
# pnpm 의 가상 스토어(node_modules/.pnpm)는 /app 내부 상대 심링크라 통째 복사로 보존된다.
COPY --from=builder /app /app
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/api/dist/main.js"]
