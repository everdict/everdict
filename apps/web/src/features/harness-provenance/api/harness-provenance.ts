import type { AuthContext } from '@/shared/lib/control-plane'
import { controlPlane } from '@/shared/lib/control-plane'
import { z } from 'zod'

// ── WHERE A HARNESS VERSION CAME FROM ───────────────────────────────────────────────────────────────
//
// The control plane answers this in one read and the web never asked, so a harness page could say what a
// version IS and nothing about what produced it. Census slice 5.
// docs/architecture/web-runtime-gap-census-spec.md
//
// The shapes are narrow on purpose: the panel renders a chain, not the whole document. `predecessor` is the
// interesting field — the route resolves it from the origin's own `from` stamp when there is one and falls
// back to version order otherwise, and it SAYS WHICH, so a reader is never told a guess is a record.
export const harnessLineageSchema = z.object({
  versions: z
    .array(
      z
        .object({
          version: z.string(),
          digest: z.string().optional(),
          createdAt: z.string().optional(),
          createdBy: z.string().optional(),
          predecessor: z.string().optional(),
          predecessorSource: z.string().optional(),
          forkedFrom: z.string().optional(),
        })
        .passthrough()
    )
    .default([]),
})
export type HarnessLineage = z.infer<typeof harnessLineageSchema>

// WHAT A PULLED TRACE IS READ AS — the harness's span attributes mapped onto our semantic conventions. A
// harness whose mapping nobody can see produces traces that read wrong with no way to find out why.
export const spanAttrMappingSchema = z.object({ mapping: z.record(z.string(), z.string()).default({}) })
export type SpanAttrMapping = z.infer<typeof spanAttrMappingSchema>

// WHO MAINTAINS A SLOT'S CODE — the delegation profile the template declares, so a reader can see which
// coding agent an evolution driver would ask.
export const harnessDelegateSchema = z.object({
  slots: z.array(z.object({ slot: z.string(), maintainer: z.string().optional() }).passthrough()).default([]),
})
export type HarnessDelegate = z.infer<typeof harnessDelegateSchema>

// Best-effort by contract: a harness page whose lineage read failed still shows the harness. Absent is
// "not read", never "no lineage" — the panel says so rather than drawing an empty chain.
export async function loadHarnessLineage(ctx: AuthContext, id: string): Promise<HarnessLineage | undefined> {
  try {
    return harnessLineageSchema.parse(await controlPlane.harnessLineage(ctx, id))
  } catch {
    return undefined
  }
}

// The same posture for the two reads beside it: a page that loses one of them keeps the other, and each
// absence reads as "not read" rather than "empty".
export async function loadSpanAttrMapping(ctx: AuthContext, id: string): Promise<SpanAttrMapping | undefined> {
  try {
    return spanAttrMappingSchema.parse(await controlPlane.harnessSpanAttrMapping(ctx, id))
  } catch {
    return undefined
  }
}

export async function loadHarnessDelegate(ctx: AuthContext, id: string): Promise<HarnessDelegate | undefined> {
  try {
    return harnessDelegateSchema.parse(await controlPlane.harnessDelegate(ctx, id))
  } catch {
    return undefined
  }
}
