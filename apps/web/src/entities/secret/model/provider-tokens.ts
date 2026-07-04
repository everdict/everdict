import type { SecretScope } from './schema'

// 플랫폼 기능이 소비하는 "예약 이름" 시크릿(프로바이더 토큰) — 유저가 예약어(HF_TOKEN 등)를 외우지 않도록
// 시크릿 UI 가 큐레이션 섹션으로 노출한다. 저장소는 일반 시크릿과 동일(SecretStore 가 SSOT — UI 분리일 뿐).
// GitHub 는 여기 없다: 토큰 입력이 아니라 '연결된 계정'(OAuth 원클릭)이 담당하는 상위 UX.
export interface ProviderTokenDef {
  name: string // 예약 시크릿 이름(서버가 이 이름으로 소비)
  provider: string // 표시명
  usedFor: string // 한 줄 용도
  help: string // InfoTip 상세(최소 권한 가이드)
  helpUrl: string // 발급 페이지
  scopes: SecretScope[] // 소비되는 스코프 — 개인 소비가 없는 키는 개인(계정) 화면에 안 보인다
}

export const PROVIDER_TOKENS: ProviderTokenDef[] = [
  {
    name: 'HF_TOKEN',
    provider: 'HuggingFace',
    usedFor: 'gated 데이터셋(벤치마크) 가져오기',
    help: 'fine-grained 토큰에 대상 데이터셋 저장소 읽기 권한이면 충분해요. gated 데이터셋은 HF 계정의 약관 동의도 필요해요. 개인 토큰이 워크스페이스 공유보다 우선해요.',
    helpUrl: 'https://huggingface.co/settings/tokens',
    scopes: ['user', 'workspace'],
  },
  {
    name: 'ANTHROPIC_API_KEY',
    provider: 'Anthropic',
    usedFor: '모델 judge 채점 호출',
    help: 'judge 로 Anthropic 모델을 쓸 때 이 워크스페이스의 채점 호출에 사용돼요.',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    scopes: ['workspace'],
  },
  {
    name: 'OPENAI_API_KEY',
    provider: 'OpenAI · 호환',
    usedFor: '모델 judge 채점 호출 (LiteLLM 등 호환 게이트웨이 포함)',
    help: 'judge 로 OpenAI(또는 OpenAI 호환 게이트웨이) 모델을 쓸 때 사용돼요.',
    helpUrl: 'https://platform.openai.com/api-keys',
    scopes: ['workspace'],
  },
]

export const providerTokenNames: ReadonlySet<string> = new Set(PROVIDER_TOKENS.map((t) => t.name))
