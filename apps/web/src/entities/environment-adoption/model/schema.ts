import type { AdoptedEnvironmentView as WireAdoptedEnvironmentView } from '@everdict/contracts/wire'
import { z } from 'zod'

// Client mirror of the control-plane /workspace/adopted-environments response — the workspace's environment-image
// inventory (import + pull-usability verification). Runtime boundary validation is zod v4 here; the EXPORTED type is
// anchored to @everdict/contracts/wire (re-architecture P4). `import type` only — the wire zod never runs in the web.
export const adoptedEnvironmentVerifySchema = z.object({
  pullable: z.boolean(),
  reason: z.enum(['ok', 'auth', 'not-found', 'unreachable']).optional(),
  digest: z.string().optional(),
  at: z.string(),
})

export const adoptedEnvironmentSchema = z.object({
  source: z.string(),
  id: z.string(),
  version: z.string(),
  adoptedAt: z.string(),
  available: z.boolean(), // the source capability still resolves + is consumable for this workspace
  name: z.string().optional(),
  image: z.string().optional(),
  benchmark: z.string().optional(),
  imageClass: z.enum(['workspace', 'external', 'local', 'unqualified']).optional(),
  verify: adoptedEnvironmentVerifySchema.optional(),
})

export const adoptedEnvironmentsResponseSchema = z.object({
  environments: z.array(adoptedEnvironmentSchema),
})

// Drift guard — identical-shape, bidirectional: a wire rename/retype fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebAdoptedEnvironment = z.infer<typeof adoptedEnvironmentSchema>
type _fwd = AssertAssignable<WebAdoptedEnvironment, WireAdoptedEnvironmentView>
type _back = AssertAssignable<WireAdoptedEnvironmentView, WebAdoptedEnvironment>
export type __adoptedEnvironmentDriftGuard = [_fwd, _back]

export type AdoptedEnvironment = WireAdoptedEnvironmentView
