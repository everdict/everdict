import {
  Boxes,
  Code2,
  Container,
  Globe,
  Lock,
  Share2,
  Sparkles,
  UserRoundCog,
  Users,
} from 'lucide-react'

import type {
  Capability,
  CapabilityImageClass,
  CapabilityType,
  CapabilityVisibility,
} from '@/entities/capability'

// The display vocabulary shared by the store lists (the catalog and my publications) and the detail **page** — the kind and visibility icons,
// the image classification badge tones, the "is it already in the workspace" key, and the detail route href. Once the detail moved from a dialog
// to a route, the list and the detail had no reason to import each other, so only what BOTH use is pulled out here.

// What a list holds — 'catalog' = the public catalog (browsing), 'mine' = what my workspace published (management).
export type StoreVariant = 'catalog' | 'mine'

// The required secrets a capability declares (the importing workspace fills them with its own secret NAMES — names, not values).
export interface RequiredSecret {
  name: string
  description: string
}

export const TYPE_ICON: Record<CapabilityType, typeof Boxes> = {
  mcp: Boxes,
  code: Code2,
  skill: Sparkles,
  environment: Container,
  delegation: UserRoundCog, // who we hand work to — not a tool but a work environment we EMPLOY
}

export const VIS_ICON: Record<CapabilityVisibility, typeof Lock> = {
  private: Lock,
  workspace: Users,
  subset: Share2,
  public: Globe,
}

// The image classification badge tone against the viewer — workspace/external = pullable, local/unqualified = no pull guarantee (a warning).
export const IMG_CLASS_TONE: Record<CapabilityImageClass, 'success' | 'info' | 'warning'> = {
  managed: 'success',
  workspace: 'success',
  external: 'info',
  local: 'warning',
  unqualified: 'warning',
}

export const capKey = (c: { tenant: string; id: string }): string => `${c.tenant}/${c.id}`

// A capability's required secrets (bound to my own secrets when adding it to the workspace). skill and environment have none.
export function requiredSecretsOf(c: Capability): RequiredSecret[] {
  if (c.spec.type === 'mcp' || c.spec.type === 'code') return c.spec.requiredSecrets
  return []
}

// Does this capability provide a WRITE (mutating) tool — the subject of the enableWrite opt-in when adding it.
export function offersWrite(c: Capability): boolean {
  if (c.spec.type === 'mcp') return c.spec.write
  if (c.spec.type === 'code') return !c.spec.isReadOnly
  return false
}

// The detail route — the address is decided by the publishing workspace (tenant) and the id (managed ones use `_shared`). from='mine' makes the
// detail's back link return to my publications list, and shows the visibility badge alongside.
export function storeItemHref(
  workspace: string,
  c: { tenant: string; id: string },
  from?: 'mine'
): string {
  const base = `/${workspace}/store/${encodeURIComponent(c.tenant)}/${encodeURIComponent(c.id)}`
  return from === 'mine' ? `${base}?from=mine` : base
}
