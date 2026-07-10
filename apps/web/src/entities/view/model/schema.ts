import type { ViewRecord, ViewVisibility as WireViewVisibility } from '@everdict/contracts'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4) — the web still parses the control-plane payload with its own schema.
// The EXPORTED types come from @everdict/contracts (re-architecture P4): the wire record IS the type SSOT, so this
// local schema can no longer silently drift from the control plane. `import type` only — never a value/schema from
// @everdict/*; the zod v3 wire schemas do NOT run in the web.
// config is the web AnalysisConfig (recipe) — opaque here (the web validates its shape). Not a snapshot: re-runs on
// current data when opened (live).
export const viewVisibilitySchema = z.enum(['private', 'workspace'])

export const viewSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  config: z.unknown(), // web AnalysisConfig — corresponds to paramsToConfig (opaque storage).
  visibility: viewVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const viewsSchema = z.array(viewSchema)

// Drift guard — the local schema and the wire contract MUST stay MUTUALLY assignable. View is an identical-shape
// entity (the web models every wire field and no extra), so the guard is bidirectional: a renamed/dropped/added field
// or a widened enum on EITHER side stops one binding compiling and the web typecheck fails. That is what makes deleting
// the hand mirror safe — the mirror is now checked against its source of truth.
//
// `config` is excluded from the STRUCTURAL guard: it is opaque (`unknown`) on both sides, and zod v4's `z.unknown()`
// infers an OPTIONAL key while zod v3's infers a REQUIRED one — a cross-version quirk on unknown, not a real drift.
// Its presence/name is still pinned (_configPresent), only its optionality is not compared.
type AssertAssignable<A extends B, B> = A
type WebView = z.infer<typeof viewSchema>
type _visGuardFwd = AssertAssignable<z.infer<typeof viewVisibilitySchema>, WireViewVisibility>
type _visGuardBack = AssertAssignable<WireViewVisibility, z.infer<typeof viewVisibilitySchema>>
type _viewGuardFwd = AssertAssignable<Omit<WebView, 'config'>, Omit<ViewRecord, 'config'>>
type _viewGuardBack = AssertAssignable<Omit<ViewRecord, 'config'>, Omit<WebView, 'config'>>
type _configPresent = AssertAssignable<'config', keyof WebView & keyof ViewRecord>

// Exported names alias the contract types (consumers are untouched: same `View` / `ViewVisibility` identifiers).
export type ViewVisibility = WireViewVisibility
export type View = ViewRecord

// Reference the guards so unused-type lint never strips them.
export type __viewDriftGuard = [
  _visGuardFwd,
  _visGuardBack,
  _viewGuardFwd,
  _viewGuardBack,
  _configPresent,
]
