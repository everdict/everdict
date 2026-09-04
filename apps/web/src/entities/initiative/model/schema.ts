import type {
  InitiativeBlocker as WireInitiativeBlocker,
  InitiativeProjectSummary as WireInitiativeProjectSummary,
  InitiativeReadiness as WireInitiativeReadiness,
  InitiativeRecord as WireInitiativeRecord,
  InitiativeResource as WireInitiativeResource,
  InitiativeStatus as WireInitiativeStatus,
  InitiativeUpdateRecord as WireInitiativeUpdateRecord,
} from '@everdict/contracts'
import type {
  InitiativeDetailResponse,
  InitiativeListItem as WireInitiativeListItem,
  InitiativeProgress as WireInitiativeProgress,
} from '@everdict/contracts/wire'
import { z } from 'zod'

import { issueStatusSchema, trackerHistoryEntrySchema } from '@/entities/issue'
import { projectRollupSchema, projectStatusSchema } from '@/entities/project'
import { trackerHealthSchema } from '@/entities/tracker-health'

// The eval tracker's Initiative — a **goal** several projects work toward (docs/tracker.md). It is not a release unit:
// progress is arithmetic that sweeps everything beneath it, and completion is a gate for one reason only — "a goal with open work
// left is not one that has been reached". Runtime boundary validation stays here (zod v4); the EXPORTED types come from
// @everdict/contracts (`import type` only).

// `planned` is where a goal STARTS — what it means and which projects serve it are still being decided.
// Calling that active makes every idea look like work in progress.
export const INITIATIVE_STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const
export const initiativeStatusSchema = z.enum(INITIATIVE_STATUSES)

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// The links out to where the goal is written down, measured and argued about.
export const initiativeResourceSchema = z.object({
  label: z.string(),
  url: z.string(),
})

export const initiativeSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // One emoji — so a goal is recognised in a list before its name is read.
  icon: z.string().optional(),
  status: initiativeStatusSchema,
  // The parent initiative — progress sweeps up from below, so splitting a large goal still leaves ONE answer.
  parentId: z.string().optional(),
  // Who is responsible for this goal, and the verdict (health) they last posted. Absent means nobody has reported yet,
  // which is a different claim from "fine".
  lead: z.string().optional(),
  // The people who are on this goal, and the places it is written down.
  memberIds: z.array(z.string()).default([]),
  resources: z.array(initiativeResourceSchema).default([]),
  health: trackerHealthSchema.optional(),
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
// The progress one list row carries — the same three numbers as the detail's `readiness`, produced by aggregation alone without reading a
// single issue (a list of twenty goals cannot be twenty fan-outs). The rules must match the detail's: work in a cancelled project drops out
// of the goal, and a sub-goal's projects roll up into the parent.
export const initiativeProgressSchema = z.object({
  open: z.number(),
  total: z.number(),
  projects: z.number(),
})

export const initiativeListItemSchema = initiativeSchema.extend({
  progress: initiativeProgressSchema,
})
export const initiativesSchema = z.array(initiativeListItemSchema)

// One update posted on a goal — append-only, never edited.
export const initiativeUpdateSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  initiativeId: z.string(),
  health: trackerHealthSchema,
  body: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export const initiativeUpdatesSchema = z.array(initiativeUpdateSchema)

export const initiativeBlockerSchema = z.object({
  projectId: z.string().optional(),
  issueId: z.string(),
  // The name an issue is called by (`ENG-12`) — so the remaining-work list links by slug without re-reading the issue.
  identifier: z.string(),
  title: z.string(),
  status: issueStatusSchema,
})

export const initiativeProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  // The initiative that actually HOLDS this project — absent means directly under this initiative, present means it rolled up through a sub-goal.
  viaInitiativeId: z.string().optional(),
  status: projectStatusSchema,
  // Carried along so a project row on the goal screen says the same thing as the project list does.
  health: trackerHealthSchema.optional(),
  lead: z.string().optional(),
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  rollup: projectRollupSchema,
})

// How far along the goal is: `ready` counts the open issues of **every** non-cancelled project regardless of that project's status —
// even a project marked complete still leaves work under the goal if its issues later regressed.
export const initiativeReadinessSchema = z.object({
  ready: z.boolean(),
  openIssues: z.number(),
  totalIssues: z.number(),
  projects: z.array(initiativeProjectSummarySchema),
  blockers: z.array(initiativeBlockerSchema),
})

export const initiativeDetailSchema = initiativeSchema.extend({
  readiness: initiativeReadinessSchema,
})

// Drift guard — mutually assignable with the wire contract in both directions.
type AssertAssignable<A extends B, B> = A
type WebInitiative = z.infer<typeof initiativeSchema>
type _initiativeFwd = AssertAssignable<WebInitiative, WireInitiativeRecord>
type _initiativeBack = AssertAssignable<WireInitiativeRecord, WebInitiative>
type _statusFwd = AssertAssignable<z.infer<typeof initiativeStatusSchema>, WireInitiativeStatus>
type _statusBack = AssertAssignable<WireInitiativeStatus, z.infer<typeof initiativeStatusSchema>>
type _blockerFwd = AssertAssignable<z.infer<typeof initiativeBlockerSchema>, WireInitiativeBlocker>
type _blockerBack = AssertAssignable<WireInitiativeBlocker, z.infer<typeof initiativeBlockerSchema>>
type _summaryFwd = AssertAssignable<
  z.infer<typeof initiativeProjectSummarySchema>,
  WireInitiativeProjectSummary
>
type _summaryBack = AssertAssignable<
  WireInitiativeProjectSummary,
  z.infer<typeof initiativeProjectSummarySchema>
>
type _readinessFwd = AssertAssignable<
  z.infer<typeof initiativeReadinessSchema>,
  WireInitiativeReadiness
>
type _readinessBack = AssertAssignable<
  WireInitiativeReadiness,
  z.infer<typeof initiativeReadinessSchema>
>
type _detailFwd = AssertAssignable<z.infer<typeof initiativeDetailSchema>, InitiativeDetailResponse>
type _detailBack = AssertAssignable<
  InitiativeDetailResponse,
  z.infer<typeof initiativeDetailSchema>
>
type _listItemFwd = AssertAssignable<
  z.infer<typeof initiativeListItemSchema>,
  WireInitiativeListItem
>
type _listItemBack = AssertAssignable<
  WireInitiativeListItem,
  z.infer<typeof initiativeListItemSchema>
>
type _resourceFwd = AssertAssignable<
  z.infer<typeof initiativeResourceSchema>,
  WireInitiativeResource
>
type _resourceBack = AssertAssignable<
  WireInitiativeResource,
  z.infer<typeof initiativeResourceSchema>
>
type _progressFwd = AssertAssignable<
  z.infer<typeof initiativeProgressSchema>,
  WireInitiativeProgress
>
type _progressBack = AssertAssignable<
  WireInitiativeProgress,
  z.infer<typeof initiativeProgressSchema>
>
type _updateFwd = AssertAssignable<
  z.infer<typeof initiativeUpdateSchema>,
  WireInitiativeUpdateRecord
>
type _updateBack = AssertAssignable<
  WireInitiativeUpdateRecord,
  z.infer<typeof initiativeUpdateSchema>
>

export type Initiative = WireInitiativeRecord
export type InitiativeListItem = WireInitiativeListItem
export type InitiativeProgress = WireInitiativeProgress
export type InitiativeResource = WireInitiativeResource
export type InitiativeUpdate = WireInitiativeUpdateRecord
export type InitiativeStatus = WireInitiativeStatus
export type InitiativeReadiness = WireInitiativeReadiness
export type InitiativeBlocker = WireInitiativeBlocker
export type InitiativeProjectSummary = WireInitiativeProjectSummary
export type InitiativeDetail = InitiativeDetailResponse

export type __initiativeDriftGuard = [
  _initiativeFwd,
  _initiativeBack,
  _statusFwd,
  _statusBack,
  _blockerFwd,
  _blockerBack,
  _summaryFwd,
  _summaryBack,
  _readinessFwd,
  _readinessBack,
  _detailFwd,
  _detailBack,
  _updateFwd,
  _updateBack,
  _listItemFwd,
  _listItemBack,
  _progressFwd,
  _progressBack,
  _resourceFwd,
  _resourceBack,
]
