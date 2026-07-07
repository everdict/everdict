import type { SecretScope } from './schema'

// 플랫폼 기능이 소비하는 "예약 이름" 시크릿(프로바이더 토큰) — 유저가 예약어(HF_TOKEN 등)를 외우지 않도록
// 시크릿 UI 가 큐레이션 섹션으로 노출한다. 저장소는 일반 시크릿과 동일(SecretStore 가 SSOT — UI 분리일 뿐).
// GitHub 는 여기 없다: 토큰 입력이 아니라 '연결된 계정'(OAuth 원클릭)이 담당하는 상위 UX.
// 표시 카피(provider/usedFor/help)는 secrets-manager 가 토큰 이름으로 next-intl 카탈로그에서 해석한다
// (manageWorkspaceSecrets.providerTokens.<NAME>.*) — 이 const 는 예약 이름·발급 링크·스코프만 담는 데이터.
export interface ProviderTokenDef {
  name: string // 예약 시크릿 이름(서버가 이 이름으로 소비)
  helpUrl: string // 발급 페이지
  scopes: SecretScope[] // 소비되는 스코프 — 개인 소비가 없는 키는 개인(계정) 화면에 안 보인다
}

export const PROVIDER_TOKENS: ProviderTokenDef[] = [
  {
    name: 'HF_TOKEN',
    helpUrl: 'https://huggingface.co/settings/tokens',
    scopes: ['user', 'workspace'],
  },
  {
    name: 'ANTHROPIC_API_KEY',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    scopes: ['workspace'],
  },
  {
    name: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
    scopes: ['workspace'],
  },
]

export const providerTokenNames: ReadonlySet<string> = new Set(PROVIDER_TOKENS.map((t) => t.name))
