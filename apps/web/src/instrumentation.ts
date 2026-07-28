// Next instrumentation 훅 — 서버 기동 시(요청 처리 전) 1회 실행. 사내 프록시 뒤 배포에서 서버사이드 아웃바운드
// fetch 가 HTTP(S)_PROXY / NO_PROXY 를 존중하도록 전역 디스패처를 설치한다(apps/api 와 동일한 일급 처리의 웹 확장).
// edge 런타임(미들웨어)에서도 register 가 불리므로 nodejs 런타임에서만 동적 import — 엣지 번들에 undici 가 끼지 않는다.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installProxyDispatcher } = await import('./shared/lib/proxy-dispatcher')
    const proxy = installProxyDispatcher()
    if (proxy)
      // eslint-disable-next-line no-console -- 서버 부팅 1회 운영 로그: 프록시 적용 여부를 다운스트림에서 확인하는 용도
      console.log(
        `[everdict-web] outbound proxy: ${proxy.httpsProxy ?? proxy.httpProxy} (NO_PROXY honored)`
      )
  }
}
