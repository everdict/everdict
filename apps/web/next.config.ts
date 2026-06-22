import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 컨트롤플레인(@assay/api) HTTP 클라이언트만 쓰므로 추가 서버 패키지 없음.
  reactStrictMode: true,
  // dev 서버를 0.0.0.0 으로 띄우고 LAN/Tailscale IP·localhost 로 접속하면, Next 16 은 그 origin 을
  // "cross-origin dev resource" 로 보고 /_next/webpack-hmr(HMR/턴보팩 런타임 부트스트랩)를 차단한다.
  // → 런타임이 초기화되지 않아 React 하이드레이션이 아예 안 일어나고 모든 onClick 이 죽는다(링크만 살아있음).
  // 접속 origin 을 명시적으로 허용해 차단을 푼다(dev 전용 설정, 프로덕션 무영향).
  allowedDevOrigins: ['localhost', '127.0.0.1', '0.0.0.0', '100.69.164.81'],
}

export default nextConfig
