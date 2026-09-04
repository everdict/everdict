import { cache } from 'react'

import {
  initiativeDetailSchema,
  initiativesSchema,
  type Initiative,
  type InitiativeDetail,
} from '@/entities/initiative'
import { membersSchema, type Member } from '@/entities/member'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The detail has three tabs sharing one layout (the header and the attribute column), and the layout and the tab inside it need the **same** read.
// That is why it is wrapped in React's `cache` so it is called once per request — a goal detail is a fan-out that sweeps issues per project, so
// with the layout and the page each calling it, it would run twice on one screen. Its argument is a single string, so the
// cache key does not hinge on reference identity.

export interface InitiativeLoad {
  initiative: InitiativeDetail | undefined
  error: string | undefined
  roles: string[]
  // The other initiatives — used to draw the parent/child relations and as the edit dialog's parent candidates.
  initiatives: Initiative[]
  members: Member[]
}

export const loadInitiative = cache(async (id: string): Promise<InitiativeLoad> => {
  const { principal, ctx } = await currentPrincipal()
  let initiative: InitiativeDetail | undefined
  let error: string | undefined
  try {
    initiative = initiativeDetailSchema.parse(await controlPlane.getInitiative(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  // Supporting reads — the detail keeps rendering when one fails (only that slot ends up empty).
  const [initiatives, members] = await Promise.all([
    controlPlane
      .listInitiatives(ctx)
      .then((r) => initiativesSchema.parse(r))
      .catch((): Initiative[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
  ])
  return {
    initiative,
    error,
    roles: principal?.roles ?? [],
    initiatives,
    members,
  }
})
