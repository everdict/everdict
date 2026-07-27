'use server'

import {
  capabilitiesSchema,
  type CapabilityImageClass,
  type CapabilitySpec,
} from '@/entities/capability'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 스토어의 environment(평가환경 이미지) 자산 — 하네스 저작 "from store" 피커가 소비한다. 내 스토어 + 공개 카탈로그를
// 합치고 (tenant,id) 중복은 내 스토어 우선. 핀에는 이미지 ref 를 그대로(verbatim) 삽입하고(no-rewrite 불변), 삽입
// 출처는 pinSources 주석으로 기록한다. preset 은 템플릿 서비스행 프리필용. docs/architecture/environment-image-store.md.
export type StoreEnvironmentPreset = NonNullable<
  Extract<CapabilitySpec, { type: 'environment' }>['preset']
>

export interface StoreEnvironment {
  key: string // tenant/id — 리스트 key
  tenant: string // 발행 워크스페이스 — pinSources.source
  id: string
  name: string
  description: string
  version: string
  image: string
  imageClass?: CapabilityImageClass // 뷰어 워크스페이스 기준 분류(컨트롤플레인 계산)
  benchmark?: string
  preset?: StoreEnvironmentPreset // 구성 프리셋(서비스 조각·의존 스토어·프런트도어) — 저작 프리필 소스
  instructions: string // 환경 구성 설명(md) — 프리필 시 참고 표시용
}

export interface ListStoreEnvironmentsResult {
  ok: boolean
  environments?: StoreEnvironment[]
  error?: string
}

export async function listStoreEnvironmentsAction(): Promise<ListStoreEnvironmentsResult> {
  const ctx = await authContext()
  try {
    const [mine, pub] = await Promise.all([
      controlPlane.listCapabilities<unknown>(ctx),
      controlPlane.listPublicCapabilities<unknown>(ctx),
    ])
    const seen = new Set<string>()
    const environments = [
      ...capabilitiesSchema.parse(mine),
      ...capabilitiesSchema.parse(pub),
    ].flatMap((c) => {
      if (c.spec.type !== 'environment') return []
      const key = `${c.tenant}/${c.id}`
      if (seen.has(key)) return []
      seen.add(key)
      return [
        {
          key,
          tenant: c.tenant,
          id: c.id,
          name: c.name,
          description: c.description,
          version: c.version,
          image: c.spec.image,
          ...(c.imageClass ? { imageClass: c.imageClass } : {}),
          ...(c.spec.contents?.benchmark ? { benchmark: c.spec.contents.benchmark } : {}),
          ...(c.spec.preset ? { preset: c.spec.preset } : {}),
          instructions: c.spec.instructions,
        },
      ]
    })
    return { ok: true, environments }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
