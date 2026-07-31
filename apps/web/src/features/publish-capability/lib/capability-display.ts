import { Boxes, Code2, Container, Globe, Lock, Share2, Sparkles, Users } from 'lucide-react'

import type {
  Capability,
  CapabilityImageClass,
  CapabilityType,
  CapabilityVisibility,
} from '@/entities/capability'

// 스토어 목록(카탈로그·내 발행)과 상세 **페이지**가 공유하는 표시 어휘 — 종류/공개범위 아이콘, 이미지 분류 배지 톤,
// "이미 워크스페이스에 있는가" 판정 키, 그리고 상세 라우트 href. 상세가 다이얼로그에서 라우트로 나가면서 목록과 상세가
// 서로를 임포트할 이유가 없어졌으므로, 둘이 함께 쓰는 것만 여기로 뺀다.

// 목록이 무엇을 담는가 — 'catalog'=공개 카탈로그(브라우즈), 'mine'=내 워크스페이스가 발행한 것(관리).
export type StoreVariant = 'catalog' | 'mine'

// capability 가 선언한 필요 시크릿(가져가는 워크스페이스가 자기 시크릿 이름으로 채운다 — 값이 아니라 이름).
export interface RequiredSecret {
  name: string
  description: string
}

export const TYPE_ICON: Record<CapabilityType, typeof Boxes> = {
  mcp: Boxes,
  code: Code2,
  skill: Sparkles,
  environment: Container,
}

export const VIS_ICON: Record<CapabilityVisibility, typeof Lock> = {
  private: Lock,
  workspace: Users,
  subset: Share2,
  public: Globe,
}

// 뷰어 기준 이미지 분류 배지 톤 — workspace/external=풀 가능, local/unqualified=풀 보장 없음(경고).
export const IMG_CLASS_TONE: Record<CapabilityImageClass, 'success' | 'info' | 'warning'> = {
  managed: 'success',
  workspace: 'success',
  external: 'info',
  local: 'warning',
  unqualified: 'warning',
}

export const capKey = (c: { tenant: string; id: string }): string => `${c.tenant}/${c.id}`

// capability 의 필요 시크릿(워크스페이스에 추가할 때 내 시크릿으로 바인딩). skill/environment 는 없음.
export function requiredSecretsOf(c: Capability): RequiredSecret[] {
  if (c.spec.type === 'mcp' || c.spec.type === 'code') return c.spec.requiredSecrets
  return []
}

// 이 capability 가 write(변경) 도구를 제공하는가 — 추가 시 enableWrite 옵트인 대상.
export function offersWrite(c: Capability): boolean {
  if (c.spec.type === 'mcp') return c.spec.write
  if (c.spec.type === 'code') return !c.spec.isReadOnly
  return false
}

// 상세 라우트 — 발행 워크스페이스(tenant)와 id 로 주소가 정해진다(매니지드는 `_shared`). from='mine' 은 상세의
// 뒤로가기가 내 발행 목록으로 돌아가게 하고, 공개범위 배지를 함께 보여 준다.
export function storeItemHref(
  workspace: string,
  c: { tenant: string; id: string },
  from?: 'mine'
): string {
  const base = `/${workspace}/store/${encodeURIComponent(c.tenant)}/${encodeURIComponent(c.id)}`
  return from === 'mine' ? `${base}?from=mine` : base
}
