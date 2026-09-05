import type { CapabilityOrigin as WireCapabilityOrigin } from '@everdict/contracts'
import { z } from 'zod'

// Where a registered version "came from" — whether it was born from an issue, and which agent made it in which conversation.
// Runtime validation is here (zod v4); the EXPORTED types are anchored to @everdict/contracts (re-architecture P4).
//
// It rides on the list response as `versionOrigins` (version → origin). A detail screen picks out the newest version's origin, and a version
// list draws each version's own — if v1 was born from an issue and v2 was refined in a different conversation, those are DIFFERENT answers,
// and lumping them into the first version leaves the newest version the least explained.
export const capabilityOriginSourceTypeSchema = z.enum([
  'issue',
  'project',
  'initiative',
  'scorecard',
  'run',
  'trace',
  'harness',
  'agent',
  'dataset',
  'judge',
  'benchmark',
])

export const capabilityOriginRefSchema = z.object({
  type: capabilityOriginSourceTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  // A display snapshot stamped at registration time (`ENG-12 the title`). The id is what resolution goes by; this is for DRAWING.
  label: z.string().optional(),
})

export const capabilityOriginSchema = z.object({
  via: z.enum(['web', 'mcp', 'ci', 'import']),
  from: capabilityOriginRefSchema.optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  note: z.string().optional(),
})

// version → origin. Only stamped versions are in it (with no version stamped, the field is absent entirely).
export const versionOriginsSchema = z.record(z.string(), capabilityOriginSchema)

type AssertAssignable<A extends B, B> = A
type WebCapabilityOrigin = z.infer<typeof capabilityOriginSchema>
type _originFwd = AssertAssignable<WebCapabilityOrigin, WireCapabilityOrigin>
type _originBack = AssertAssignable<WireCapabilityOrigin, WebCapabilityOrigin>
export type { _originFwd, _originBack }

export type CapabilityOrigin = WireCapabilityOrigin
export type CapabilityOriginRef = NonNullable<WireCapabilityOrigin['from']>
export type VersionOrigins = Record<string, CapabilityOrigin>

// Is there anything to draw — an origin carrying only a channel (via) says nothing but "registered from the web", which is no reason for a section.
// The detail screens' "an empty section is hidden" convention applies here too.
export function hasLineage(origin: CapabilityOrigin | undefined): boolean {
  if (!origin) return false
  return (
    origin.from !== undefined ||
    origin.agentId !== undefined ||
    origin.agentName !== undefined ||
    origin.conversationId !== undefined ||
    origin.note !== undefined
  )
}

// Picks the ONE origin a detail screen draws. The stamp of the version being displayed wins, and with no stamp on that version it falls back
// to the OLDEST stamp — the answer to "where did this come from" is ultimately where it was BORN, and if the newest version is just a version
// bump the birth record is still the valid answer. With no version stamped at all (an asset made before stamping) it is undefined.
export function pickOrigin(
  origins: VersionOrigins | undefined,
  version: string,
  versionsAscending: readonly string[]
): CapabilityOrigin | undefined {
  if (!origins) return undefined
  const exact = origins[version]
  if (exact) return exact
  for (const v of versionsAscending) {
    const found = origins[v]
    if (found) return found
  }
  return undefined
}

// The detail path the origin points at. An issue opens by identifier too, so the id is used verbatim.
// A kind that cannot be linked (a trace, etc.) is undefined — the chip stays as text.
// Each entry addresses ONE thing, so each is the singular segment — the plural is that resource's list page.
const ORIGIN_ROUTES: Partial<Record<CapabilityOriginRef['type'], string>> = {
  issue: 'issue',
  project: 'project',
  initiative: 'initiative',
  scorecard: 'scorecard',
  run: 'run',
  harness: 'harness',
  dataset: 'dataset',
  judge: 'judge',
}

export function originRefHref(workspace: string, ref: CapabilityOriginRef): string | undefined {
  const segment = ORIGIN_ROUTES[ref.type]
  return segment ? `/${workspace}/${segment}/${encodeURIComponent(ref.id)}` : undefined
}
