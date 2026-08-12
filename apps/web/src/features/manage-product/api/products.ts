'use server'

import { z } from 'zod'

import {
  productRepoDiscoverySchema,
  productSchema,
  productSeriesRunResultSchema,
  productSyncResultSchema,
  releaseSchema,
  type Product,
  type ProductRepoDiscovery,
  type ProductSeries,
  type ProductSeriesRunResult,
  type ProductService,
  type ProductSyncResult,
  type Release,
  type ReleaseComponent,
  type ReleaseStatus,
} from '@/entities/product'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 프로덕트 타임라인 server actions. 릴리즈 전이는 게이트다: 릴리즈에 링크된 열린 이슈나 회귀한 워치
// 시리즈가 있으면 409 로 거절되고, `force` 만이 그걸 넘는다(팩트와 히스토리에 기록된다).
//
// ⚠️ 화면 갱신은 부른 쪽의 `refresh()` 가 한다 — 여기서 `revalidatePath` 를 부르면 안 된다(docs/web.md).

export interface ProductActionResult {
  ok: boolean
  product?: Product
  error?: string
}

export interface ReleaseActionResult {
  ok: boolean
  release?: Release
  error?: string
}

export async function createProductAction(input: {
  name: string
  description?: string
  icon?: string
  services?: ProductService[]
  series?: ProductSeries[]
  autoEval?: { enabled: boolean; runtime?: string }
}): Promise<ProductActionResult> {
  const ctx = await authContext()
  try {
    const product = productSchema.parse(await controlPlane.createProduct(ctx, input))
    return { ok: true, product }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateProductAction(
  id: string,
  patch: {
    name?: string
    description?: string | null
    icon?: string | null
    services?: ProductService[]
    series?: ProductSeries[]
    autoEval?: { enabled: boolean; runtime?: string }
  }
): Promise<ProductActionResult> {
  const ctx = await authContext()
  try {
    const product = productSchema.parse(await controlPlane.updateProduct(ctx, id, patch))
    return { ok: true, product }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 레포 하나를 읽어 서비스 구성을 제안받는다 — 위자드가 "치는 폼"이 아니라 "고르는 화면"이 되는 근거.
// 아무것도 저장하지 않으므로 실패해도 위자드는 수동 입력으로 내려간다(에러는 그대로 보여 준다).
export async function discoverRepoAction(input: {
  repository: string
  host?: string
}): Promise<{ ok: boolean; discovery?: ProductRepoDiscovery; error?: string }> {
  const ctx = await authContext()
  try {
    const discovery = productRepoDiscoverySchema.parse(
      await controlPlane.discoverProductRepo(ctx, input)
    )
    return { ok: true, discovery }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteProductAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteProduct(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 지금 GitHub 을 당긴다 — 첫 싱크는 백필(조용히 과거를 채운다), 그 뒤의 새 버전이 시리즈를 돌린다.
export async function syncProductAction(
  id: string
): Promise<{ ok: boolean; result?: ProductSyncResult; error?: string }> {
  const ctx = await authContext()
  try {
    const result = productSyncResultSchema.parse(await controlPlane.syncProduct(ctx, id))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 시리즈를 지금 평가한다 — Sync 의 짝. 시리즈를 선언해도 새 버전이 임포트되기 전까지는 아무 배치도 돌지
// 않아 추이가 영원히 비어 있었고, 릴리즈 게이트는 그 공백을 not_evaluated 로 읽어 출하를 막았다.
export async function runProductSeriesAction(
  id: string,
  keys?: string[]
): Promise<{ ok: boolean; result?: ProductSeriesRunResult; error?: string }> {
  const ctx = await authContext()
  try {
    const result = productSeriesRunResultSchema.parse(
      await controlPlane.runProductSeries(ctx, id, keys)
    )
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function createReleaseAction(
  productId: string,
  input: {
    name: string
    description?: string
    targetDate?: string
    seriesKeys?: string[]
    components?: ReleaseComponent[]
  }
): Promise<ReleaseActionResult> {
  const ctx = await authContext()
  try {
    const release = releaseSchema.parse(await controlPlane.createRelease(ctx, productId, input))
    return { ok: true, release }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateReleaseAction(
  id: string,
  patch: {
    name?: string
    description?: string | null
    targetDate?: string | null
    seriesKeys?: string[] | null
    // null = "구성 선언 안 함"으로 되돌린다(빈 배열 = 추적 서비스가 하나도 안 나감 — 다른 사실이다).
    components?: ReleaseComponent[] | null
  }
): Promise<ReleaseActionResult> {
  const ctx = await authContext()
  try {
    const release = releaseSchema.parse(await controlPlane.updateRelease(ctx, id, patch))
    return { ok: true, release }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const errorEnvelopeSchema = z.object({ message: z.string().optional() })

// 릴리즈 게이트 — 409 는 실패가 아니라 대답이다: 무엇이 막았는지(message)를 그대로 사용자에게 보인다.
export async function setReleaseStatusAction(
  id: string,
  status: ReleaseStatus,
  force?: boolean
): Promise<ReleaseActionResult & { blocked?: boolean }> {
  const ctx = await authContext()
  try {
    const res = await controlPlane.setReleaseStatus(ctx, id, {
      status,
      ...(force ? { force: true } : {}),
    })
    if (res.ok) return { ok: true, release: releaseSchema.parse(res.body) }
    const envelope = errorEnvelopeSchema.safeParse(res.body)
    return {
      ok: false,
      blocked: res.status === 409,
      ...(envelope.success && envelope.data.message ? { error: envelope.data.message } : {}),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteReleaseAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteRelease(ctx, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
