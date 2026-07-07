# syntax=docker/dockerfile:1.7
# SaaS 웹 이미지 (@everdict/web, Next.js 16 :3001).
# 모노레포 컨텍스트(레포 루트)에서 빌드한다:
#   docker build -f apps/web/Dockerfile --target runtime -t everdict-web .
# 웹은 @everdict/* 런타임 의존이 없지만(순수 HTTP 클라이언트) pnpm 워크스페이스 install 에는 루트 컨텍스트가 필요하다.

# ---- base: 공통 도구 ----
FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

# ---- dev: 소스는 compose 가 바인드마운트, next dev 핫리로드 ----
FROM base AS dev
ENV NODE_ENV=development
CMD ["sh","-lc","pnpm install --frozen-lockfile && pnpm --filter @everdict/web dev"]

# ---- builder: 설치 + next build ----
# NODE_ENV 를 설정하지 않는다(호스트 빌드와 동일 조건):
#  - production 이면 pnpm 이 devDeps(@tailwindcss/postcss 등) 스킵 → next build postcss 깨짐.
#  - development 면 next build 프리렌더에서 React 가 깨진다(_global-error useContext null).
#  미설정이면 devDeps 는 설치되고 next build 는 내부적으로 프로덕션 빌드를 수행한다.
FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter "@everdict/web..." build

# ---- runtime: 빌드 산출물(.next) + node_modules 로 next start ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=builder /app /app
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# next start -H 0.0.0.0 -p 3001 (apps/web 의 start 스크립트)
CMD ["pnpm","--filter","@everdict/web","start"]
