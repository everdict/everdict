import type { PlatformEventRecord } from '@everdict/contracts'
import { z } from 'zod'

// GET /events 200 — 워크스페이스의 플랫폼 이벤트(라이프사이클 사실) 로그. 크래프팅 스튜디오의 리플레이 피커와
// 플릿 이벤트 피드가 소비한다. kind 는 서버 enum 보다 느슨한 string(신규 kind 추가가 웹을 깨지 않게) —
// 역방향 드리프트 가드만 건다(deliberately-loose consumer view).
export const platformEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  tenant: z.string(),
  kind: z.string(),
  subject: z.object({ type: z.string(), id: z.string() }),
  actor: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  causedBy: z.string().optional(),
  message: z.string(),
  createdAt: z.string(),
})
export type PlatformEvent = z.infer<typeof platformEventSchema>

export const platformEventListSchema = z.object({ events: z.array(platformEventSchema) })

// 드리프트 가드(역방향) — 계약 레코드가 웹 뷰에 언제나 대입 가능해야 한다(필드 개명/삭제 시 typecheck 실패).
type AssertAssignable<A extends B, B> = A
type _eventBack = AssertAssignable<PlatformEventRecord, PlatformEvent>
export type __platformEventDriftGuard = [_eventBack]
