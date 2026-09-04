import type { TrackerHealth as WireTrackerHealth } from '@everdict/contracts'
import { z } from 'zod'

// The only "judgement" the tracker records — a PERSON said it, so the verdict travels with its sentence.
//
// Why there is ONE vocabulary: the layer where people report is two things, projects and the goals (initiatives) those projects head toward, and
// the same three words mean the same thing in both. Split into two enums, "at risk" would have become a different value depending on the screen.
export const TRACKER_HEALTH = ['on_track', 'at_risk', 'off_track'] as const
export const trackerHealthSchema = z.enum(TRACKER_HEALTH)

// Drift guard — mutually assignable with the wire contract in both directions.
type AssertAssignable<A extends B, B> = A
type _healthFwd = AssertAssignable<z.infer<typeof trackerHealthSchema>, WireTrackerHealth>
type _healthBack = AssertAssignable<WireTrackerHealth, z.infer<typeof trackerHealthSchema>>

export type TrackerHealth = WireTrackerHealth

export type __trackerHealthDriftGuard = [_healthFwd, _healthBack]
