'use server'

import {
  capabilitySchema,
  capabilitySpecDiffSchema,
  capabilityVersionsSchema,
  type Capability,
  type CapabilitySpecDiff,
  type CapabilityVersions,
} from '@/entities/capability'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The server actions of the store detail drill-in's version panel — the version list, one version's record, and the structural diff. The drill-in is
// CLIENT state rather than a route so it cannot arrive as a page prop, and it is loaded on demand when the detail opens. source = the cross-tenant public/subset owner (omitted for mine).
type VersionActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

export async function loadCapabilityVersionsAction(
  id: string,
  source?: string
): Promise<VersionActionResult<CapabilityVersions>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: capabilityVersionsSchema.parse(
        await controlPlane.listCapabilityVersions(ctx, id, source)
      ),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function loadCapabilityVersionAction(
  id: string,
  version: string,
  source?: string
): Promise<VersionActionResult<Capability>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: capabilitySchema.parse(await controlPlane.getCapability(ctx, id, version, source)),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function diffCapabilityVersionsAction(
  id: string,
  base: string,
  candidate: string,
  source?: string
): Promise<VersionActionResult<CapabilitySpecDiff>> {
  const ctx = await authContext()
  try {
    return {
      ok: true,
      data: capabilitySpecDiffSchema.parse(
        await controlPlane.diffCapabilityVersions(ctx, id, base, candidate, source)
      ),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
