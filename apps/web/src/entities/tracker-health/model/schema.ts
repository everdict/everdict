import type { TrackerHealth as WireTrackerHealth } from '@everdict/contracts'
import { z } from 'zod'

// 트래커가 기록하는 유일한 "판단" — 사람이 말한 것이라, 판정과 그 문장이 함께 간다.
//
// 어휘가 한 벌인 이유: 사람이 보고하는 층은 프로젝트와 그 프로젝트들이 향하는 목표(이니셔티브) 둘인데, 같은
// 세 단어가 두 곳에서 같은 뜻이다. 열거형을 둘로 나눴다면 "위험"이 보는 화면에 따라 다른 값이 됐을 것이다.
export const TRACKER_HEALTH = ['on_track', 'at_risk', 'off_track'] as const
export const trackerHealthSchema = z.enum(TRACKER_HEALTH)

// Drift guard — mutually assignable with the wire contract in both directions.
type AssertAssignable<A extends B, B> = A
type _healthFwd = AssertAssignable<z.infer<typeof trackerHealthSchema>, WireTrackerHealth>
type _healthBack = AssertAssignable<WireTrackerHealth, z.infer<typeof trackerHealthSchema>>

export type TrackerHealth = WireTrackerHealth

export type __trackerHealthDriftGuard = [_healthFwd, _healthBack]
