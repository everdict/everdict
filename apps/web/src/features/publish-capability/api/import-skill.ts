'use server'

import { skillSchema, type Skill } from '@/entities/skill'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// Refreshing the screen is the CALLER's `refresh()` — `revalidatePath` must not be called here
// (there is no cache to invalidate, and Next 16 throws away the whole client prefetch cache and imposes a 300ms cooldown on the DECLARATION
// alone). The grounds are in `docs/web.md` §"A mutation refreshes; it must not revalidate".
export interface ImportSkillActionResult {
  ok: boolean
  skill?: Skill
  error?: string
}

// Adding a skill publication to the workspace is **making a COPY** (POST /skills/import). Rather than pinning a reference as the other kinds do,
// it takes its seat as a workspace skill under Settings › Agent › Skills — and from then on WE edit it and stamp its versions.
// A managed skill everdict put in the store is an "example", so this is the only path by which it enters a workspace.
export async function importSkillAction(body: {
  source: string
  id: string
  version: string
}): Promise<ImportSkillActionResult> {
  const ctx = await authContext()
  try {
    const skill = skillSchema.parse(await controlPlane.importSkill(ctx, body))
    return { ok: true, skill }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
