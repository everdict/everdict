'use server'

import {
  codeToolTryResultSchema,
  imageTagsSchema,
  imageVerifySchema,
  probeCapabilityMcpResultSchema,
  validateCapabilityResultSchema,
  type CapabilitySpec,
  type CodeToolTryResult,
  type ImageVerify,
  type ProbeCapabilityMcpResult,
  type ValidateCapabilityResult,
} from '@/entities/capability'
import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'
import { controlPlane } from '@/shared/lib/control-plane'

// 위자드 저작 보조 서버액션 — 저장 전 검증(validate)·mcp 연결 테스트(probe)·environment 이미지 태그 조회. 실패는 결과로
// 되돌린다(throw 아님) — 폼이 인라인 피드백을 렌더한다.

export interface ValidateResult {
  ok: boolean
  result?: ValidateCapabilityResult
  error?: string
}

// save 의 dry-run — 새 capability/새 버전 여부 + 예측 버전 + (environment) 이미지 경고. 스펙 파싱 실패는 result.ok=false.
export async function validateCapabilityAction(
  id: string,
  name: string,
  description: string,
  spec: CapabilitySpec
): Promise<ValidateResult> {
  const ctx = await authContext()
  try {
    const result = validateCapabilityResultSchema.parse(
      await controlPlane.validateCapability(ctx, { id, name, description, spec })
    )
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ProbeResult {
  ok: boolean
  result?: ProbeCapabilityMcpResult
  error?: string
}

// mcp URL 연결 테스트 + 도구 발견. token 은 테스트 전용 임시 베어러(저장 안 됨).
export async function probeCapabilityMcpAction(url: string, token?: string): Promise<ProbeResult> {
  const ctx = await authContext()
  try {
    const result = probeCapabilityMcpResultSchema.parse(
      await controlPlane.probeCapabilityMcp(ctx, { url, ...(token ? { token } : {}) })
    )
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface TryCodeToolActionResult {
  ok: boolean
  result?: CodeToolTryResult
  error?: string
}

// code 도구 검증(POST /agent/code-tools/try) — check=구문만(파스, 실행 없음) · run=예제 입력으로 실제 1회 실행(에이전트와
// 동일 실행계약; 타 워크스페이스 코드는 격리 런타임에서만 — 게이트는 서버가 소유권으로 판정). 위저드는 draft spec 을,
// 스토어 상세는 발행본 ref 를 보낸다. 무상태.
export async function tryCodeToolAction(body: {
  mode: 'check' | 'run'
  name?: string
  spec?: CapabilitySpec
  ref?: { source: string; id: string; version: string }
  input?: Record<string, unknown>
}): Promise<TryCodeToolActionResult> {
  const ctx = await authContext()
  try {
    const result = codeToolTryResultSchema.parse(await agentPlane.tryCodeTool(ctx, body))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ImageTagsResult {
  ok: boolean
  tags?: string[]
  error?: string
}

// environment 이미지 피커 — 워크스페이스 레지스트리의 repository 태그 목록(등록이 여럿이면 registry 이름 필요).
export async function listImageTagsAction(
  repository: string,
  registry?: string
): Promise<ImageTagsResult> {
  const ctx = await authContext()
  try {
    const { tags } = imageTagsSchema.parse(
      await controlPlane.listImageTags(ctx, repository, registry)
    )
    return { ok: true, tags }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ImageVerifyResult {
  ok: boolean
  result?: ImageVerify
  error?: string
}

// 저작 시점 실 pull 검증 — 정적 분류 경고(imageWarnings)는 "레지스트리 등록 여부"만 보는데, 이건 레지스트리에 실제로
// 물어본다(내가 방금 push 한 이미지를 정말 당길 수 있는가). digest 가 오면 그것이 재현 가능한 핀.
export async function verifyImageAction(image: string): Promise<ImageVerifyResult> {
  const ctx = await authContext()
  try {
    const result = imageVerifySchema.parse(await controlPlane.verifyImage(ctx, image))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
