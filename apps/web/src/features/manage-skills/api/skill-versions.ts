'use server'

import { skillSchema, skillVersionSchema, type Skill, type SkillVersion } from '@/entities/skill'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface StampSkillVersionResult {
  ok: boolean
  skill?: Skill
  stamped?: SkillVersion
  error?: string
}

// Stamp the current content as a version (POST /skills/:id/versions) — the back end of "edit by conversation, then stamp a version again".
// bump = major|minor|patch (patch by default). A stamped version is immutable, so an older version still says exactly what it said then.
// The management gate (author-or-admin) and the "it must be after the current version" rule are enforced by the control plane.
export async function stampSkillVersionAction(
  id: string,
  body: { bump?: 'major' | 'minor' | 'patch'; note?: string }
): Promise<StampSkillVersionResult> {
  const ctx = await authContext()
  try {
    const raw = (await controlPlane.stampSkillVersion(ctx, id, body)) as {
      skill: unknown
      stamped: unknown
    }
    const result = {
      skill: skillSchema.parse(raw.skill),
      stamped: skillVersionSchema.parse(raw.stamped),
    }
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
