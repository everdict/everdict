import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

// 표준 아웃바운드 프록시 env(HTTP_PROXY/HTTPS_PROXY/NO_PROXY — 관례상 대소문자 둘 다)를 읽는다. 순수 함수라
// "프록시가 구성되었는가" 판단을 전역 상태 없이 검증할 수 있다. apps/api infrastructure/http/proxy-dispatcher 의
// 재해석 — 웹은 런타임 디커플링 규칙상 @everdict/* 를 import 할 수 없어 같은 로직을 로컬로 둔다.
export function proxyEnv(env: NodeJS.ProcessEnv = process.env): {
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
} {
  const pick = (upper: string, lower: string): string | undefined => {
    const v = env[upper]?.trim() || env[lower]?.trim()
    return v ? v : undefined
  }
  const httpProxy = pick('HTTP_PROXY', 'http_proxy')
  const httpsProxy = pick('HTTPS_PROXY', 'https_proxy')
  const noProxy = pick('NO_PROXY', 'no_proxy')
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  }
}

// 프록시-인지 전역 디스패처 설치 — 사내 프록시 뒤 배포에서 웹 서버의 아웃바운드 fetch(대표적으로 데스크탑
// 릴리즈 목록의 api.github.com 호출)가 HTTP(S)_PROXY 를 타게 한다. undici 의 setGlobalDispatcher 는 Node 내장
// fetch 가 읽는 것과 동일한 전역(Symbol.for 레지스트리)을 설정하므로, 이 한 번의 호출이 호출부 수정 없이 전체를
// 커버한다. 프록시 env 미설정이면 no-op — 프록시 없는 배포는 기존과 동일하게 동작한다.
// EnvHttpProxyAgent 는 요청마다 NO_PROXY 를 적용하므로 내부 호스트(CONTROL_PLANE_URL 의 api, agent 등)는
// NO_PROXY 에 올라 있으면 프록시를 우회한다 — compose 가 서비스 이름을 자동으로 합류시킨다(deploy/compose).
// 설치된 구성(또는 undefined)을 반환해 부팅 로그 한 줄에 쓴다.
export function installProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env
): { httpProxy?: string; httpsProxy?: string } | undefined {
  const p = proxyEnv(env)
  if (!p.httpProxy && !p.httpsProxy) return undefined // 프록시 미구성 → 기본 디스패처 유지
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
      ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
      ...(p.noProxy ? { noProxy: p.noProxy } : {}),
    })
  )
  return {
    ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
    ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
  }
}
