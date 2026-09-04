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

// The product timeline server actions. A release transition is a GATE: with an open linked issue or a regressed watch series it is refused with
// a 409, and only `force` gets past (recorded in the facts and the history).
//
// ⚠️ Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here (docs/web.md).

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

// Read one repo and be offered a service composition — the grounds on which the wizard is a screen you PICK from rather than a form you type into.
// It stores nothing, so on a failure the wizard falls back to manual entry (the error is shown verbatim).
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

// Pull GitHub now — the first sync is a backfill (it fills the past quietly), and genuinely new versions after it run the series.
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

// Evaluate the series now — Sync's counterpart. Declaring a series ran no batch at all until a new version was imported, so the trend stayed
// empty forever and the release gate read that gap as not_evaluated and blocked the ship.
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
    // null returns it to "no composition declared" (an empty array = no tracked service ships — a different fact).
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

// The release gate — a 409 is an ANSWER rather than a failure: what blocked it (message) is shown to the user verbatim.
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
