import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 컨트롤플레인(@assay/api) HTTP 클라이언트만 쓰므로 추가 서버 패키지 없음.
  reactStrictMode: true,
}

export default nextConfig
