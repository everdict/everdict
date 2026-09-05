import { agentSpecSchema } from '@/entities/agent-spec'
import {
  adoptedEnvironmentsResponseSchema,
  type AdoptedEnvironment,
} from '@/entities/environment-adoption'
import { imageRegistriesResponseSchema } from '@/entities/image-registry'
import { membersSchema } from '@/entities/member'
import { secretsSchema } from '@/entities/secret'
import { skillsSchema } from '@/entities/skill'
import { workspacesSchema } from '@/entities/workspace'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'

export interface StoreContext {
  // The author display — subject → name plus avatar (the member profile).
  authors: Record<string, { name: string; avatarUrl?: string }>
  // The keys (source/id) of capabilities already adopted — marks a row as "adopted".
  adoptedKeys: string[]
  // The source keys (source/id) of skill publications already **imported** — a skill becomes a **copy** of a workspace skill rather than an
  // adoption reference, so "is it already here" is judged from the library's origin (the basis on which the catalog hides imported examples).
  importedSkillKeys: string[]
  // The inventory of environment images the workspace imported — for environment's "imported / usable" marks.
  adoptedEnvironments: AdoptedEnvironment[]
  // The candidates for binding required secrets at adoption (workspace secret names).
  secretNames: string[]
  // For the subset sharing-target picker — the workspaces I belong to (id + name).
  myWorkspaces: { id: string; name: string }[]
  // For the environment image tag picker — the workspace registries (name + host).
  imageRegistries: { name: string; host: string }[]
}

// The supporting data shared by the store (public catalog) and my-publications pages. All of it is SOFT (empty on failure) — the page renders as
// long as the capability list is there. Permissions and the main list are loaded by each page from the principal and its own source; only display and adoption support data is gathered here.
export async function loadStoreContext(ctx: AuthContext): Promise<StoreContext> {
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

  const adoptedKeys = await controlPlane
    .getAgent(ctx, 'default', 'latest')
    .then((r) => agentSpecSchema.parse(r).capabilities.map((c) => `${c.source}/${c.id}`))
    .catch(() => [] as string[])

  const secretNames = await controlPlane
    .listSecrets(ctx)
    .then((r) =>
      secretsSchema
        .parse(r)
        .filter((secret) => secret.scope === 'workspace')
        .map((secret) => secret.name)
    )
    .catch(() => [] as string[])

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

  const importedSkillKeys = await controlPlane
    .listSkills(ctx)
    .then((r) =>
      skillsSchema
        .parse(r)
        .flatMap((skill) => (skill.origin ? [`${skill.origin.source}/${skill.origin.id}`] : []))
    )
    .catch(() => [] as string[])

  const adoptedEnvironments = await controlPlane
    .listAdoptedEnvironments(ctx)
    .then((r) => adoptedEnvironmentsResponseSchema.parse(r).environments)
    .catch(() => [] as AdoptedEnvironment[])

  return {
    authors,
    adoptedKeys,
    importedSkillKeys,
    adoptedEnvironments,
    secretNames,
    myWorkspaces,
    imageRegistries,
  }
}
