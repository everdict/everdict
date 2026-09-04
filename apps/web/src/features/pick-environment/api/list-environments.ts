'use server'

import {
  capabilitiesSchema,
  type CapabilityImageClass,
  type CapabilitySpec,
} from '@/entities/capability'
import { adoptedEnvironmentsResponseSchema } from '@/entities/environment-adoption'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// The store's environment assets (evaluation environment images) — consumed by the harness authoring "from store" picker. It merges my store
// with the public catalog, and a duplicate (tenant,id) prefers mine. The image ref is inserted into the pin VERBATIM (the no-rewrite invariant),
// and where it came from is recorded as a pinSources annotation. A preset prefills the template service rows. docs/architecture/environment-image-store.md.
export type StoreEnvironmentPreset = NonNullable<
  Extract<CapabilitySpec, { type: 'environment' }>['preset']
>

export interface StoreEnvironment {
  key: string // tenant/id — the list key
  tenant: string // the publishing workspace — pinSources.source
  id: string
  name: string
  description: string
  version: string
  image: string
  imageClass?: CapabilityImageClass // the classification against the VIEWER's workspace (computed by the control plane)
  benchmark?: string
  preset?: StoreEnvironmentPreset // the composition preset (service fragments, dependency stores, front door) — the source for authoring prefill
  instructions: string // the environment composition description (md) — shown for reference while prefilling
  adopted?: boolean // has my workspace already imported this environment — shown as "imported" in the picker
  pullable?: boolean // the pull verification result of an imported one (false = this workspace cannot pull the image); undefined = not imported / not verified
}

export interface ListStoreEnvironmentsResult {
  ok: boolean
  environments?: StoreEnvironment[]
  error?: string
}

export async function listStoreEnvironmentsAction(): Promise<ListStoreEnvironmentsResult> {
  const ctx = await authContext()
  try {
    const [mine, pub, adoptedRaw] = await Promise.all([
      controlPlane.listCapabilities<unknown>(ctx),
      controlPlane.listPublicCapabilities<unknown>(ctx),
      controlPlane.listAdoptedEnvironments<unknown>(ctx).catch(() => ({ environments: [] })),
    ])
    // My workspace inventory — marks each entry's "imported + pull verified" state by source/id.
    const adopted = new Map(
      adoptedEnvironmentsResponseSchema
        .parse(adoptedRaw)
        .environments.map((e) => [`${e.source}/${e.id}`, e])
    )
    const seen = new Set<string>()
    const environments = [
      ...capabilitiesSchema.parse(mine),
      ...capabilitiesSchema.parse(pub),
    ].flatMap((c) => {
      if (c.spec.type !== 'environment') return []
      const key = `${c.tenant}/${c.id}`
      if (seen.has(key)) return []
      seen.add(key)
      const inv = adopted.get(key)
      return [
        {
          key,
          tenant: c.tenant,
          id: c.id,
          name: c.name,
          description: c.description,
          version: c.version,
          image: c.spec.image,
          ...(c.imageClass ? { imageClass: c.imageClass } : {}),
          ...(c.spec.contents?.benchmark ? { benchmark: c.spec.contents.benchmark } : {}),
          ...(c.spec.preset ? { preset: c.spec.preset } : {}),
          instructions: c.spec.instructions,
          ...(inv ? { adopted: true } : {}),
          ...(inv?.verify ? { pullable: inv.verify.pullable } : {}),
        },
      ]
    })
    return { ok: true, environments }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
