import {
  adoptedEnvironmentsResponseSchema,
  type AdoptedEnvironment,
} from '@/entities/environment-adoption'
import { imageRegistriesResponseSchema } from '@/entities/image-registry'
import { membersSchema } from '@/entities/member'
import { workspacesSchema } from '@/entities/workspace'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

export interface EnvironmentContext {
  // The author display — subject → name plus avatar (the member profile).
  authors: Record<string, { name: string; avatarUrl?: string }>
  // The inventory of environment images the workspace imported — the "imported / pullable" rows of the merged list.
  adoptedEnvironments: AdoptedEnvironment[]
  // For the subset sharing-target picker — the workspaces I belong to (id + name).
  myWorkspaces: { id: string; name: string }[]
  // For the image tag helper — the workspace registries (name + host).
  imageRegistries: { name: string; host: string }[]
}

// The supporting data for Settings › Environments — a loader carrying only what the environment surface actually uses out of the store context
// (loadStoreContext); agent adoption keys and secret names have nothing to do with environments. All of it is SOFT (empty on failure).
export async function loadEnvironmentContext(ctx: AuthContext): Promise<EnvironmentContext> {
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  const adoptedEnvironments = await controlPlane
    .listAdoptedEnvironments(ctx)
    .then((r) => adoptedEnvironmentsResponseSchema.parse(r).environments)
    .catch(() => [] as AdoptedEnvironment[])

  const myWorkspaces = await controlPlane
    .listWorkspaces(ctx)
    .then((r) => workspacesSchema.parse(r).map((w) => ({ id: w.id, name: w.name })))
    .catch(() => [] as { id: string; name: string }[])

  const imageRegistries = await controlPlane
    .listImageRegistries(ctx)
    .then((r) =>
      imageRegistriesResponseSchema
        .parse(r)
        .registries.map((reg) => ({ name: reg.name, host: reg.host }))
    )
    .catch(() => [] as { name: string; host: string }[])

  return { authors, adoptedEnvironments, myWorkspaces, imageRegistries }
}
