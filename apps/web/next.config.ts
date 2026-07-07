import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// i18n 요청 설정(쿠키 기반 로케일 — URL 라우팅 없음). 카탈로그는 messages/{ko,en}.json.
const withNextIntl = createNextIntlPlugin('./src/shared/i18n/request.ts')

const nextConfig: NextConfig = {
  // 컨트롤플레인(@everdict/api) HTTP 클라이언트만 쓰므로 추가 서버 패키지 없음.
  reactStrictMode: true,
  // dev 와 build 가 같은 .next 를 공유하면, 이 공유 WIP 트리에서 다른 세션의 next build 가 dev 터보팩
  // 캐시를 오염시킨다(SST persist 실패/buildManifest ENOENT → 하이드레이션 죽어 모든 클릭 무반응).
  // pnpm dev 는 NEXT_DIST_DIR=.next-dev 로 격리(빌드는 기본 .next 유지 — 프로덕션 무영향).
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // dev 서버를 0.0.0.0 으로 띄우고 LAN/Tailscale IP·localhost 로 접속하면, Next 16 은 그 origin 을
  // "cross-origin dev resource" 로 보고 /_next/webpack-hmr(HMR/턴보팩 런타임 부트스트랩)를 차단한다.
  // → 런타임이 초기화되지 않아 React 하이드레이션이 아예 안 일어나고 모든 onClick 이 죽는다(링크만 살아있음).
  // 접속 origin 을 명시적으로 허용해 차단을 푼다(dev 전용 설정, 프로덕션 무영향).
  // LAN/Tailscale 등 추가 origin 은 EVERDICT_DEV_ORIGIN(.env.local)로 — 개인 호스트를 리포에 하드코딩하지 않는다.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    ...(process.env.EVERDICT_DEV_ORIGIN ? [process.env.EVERDICT_DEV_ORIGIN] : []),
  ],
  // 데이터셋 등록/새 버전 배포는 케이스 JSON(repo 시드 파일 임베드)이 기본 한도 1MB 를 쉽게 넘는다
  // (예: pinch-runnable ≈ 1.1MB) — 서버 액션 본문 한도를 넉넉히 올린다. 실제 검증은 컨트롤플레인이 한다.
  experimental: { serverActions: { bodySizeLimit: '8mb' } },
}

export default withNextIntl(nextConfig)
