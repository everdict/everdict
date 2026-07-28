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

// 스토어 상세 드릴인의 버전 패널 서버 액션 — 버전 목록·특정 버전 레코드·구조 diff. 드릴인은 라우트가 아니라 클라이언트
// 상태라 페이지 props 로 못 받으므로 상세를 열 때 온디맨드로 로드한다. source=크로스테넌트 public/subset 오너(내 것이면 생략).
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
