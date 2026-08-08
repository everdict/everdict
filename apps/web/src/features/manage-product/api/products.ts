'use server'

import { z } from 'zod'

import {
  productSchema,
  productSyncResultSchema,
  releaseSchema,
  type Product,
  type ProductSeries,
  type ProductService,
  type ProductSyncResult,
  type Release,
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

export async function createReleaseAction(
  productId: string,
  input: { name: string; description?: string; targetDate?: string; seriesKeys?: string[] }
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
