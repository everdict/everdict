import { getTranslations } from 'next-intl/server'

import { ImageStoreActions, WorkspaceImagesManager } from '@/features/manage-workspace-images'
import { workspaceImageCatalogSchema, type WorkspaceImageCatalog } from '@/entities/workspace-image'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Images — the workspace namespace of the managed image store (everdict's own registry).
// Reading is harnesses:read and unpublishing is images:push. On a deployment not running a managed store the route answers 404, so it is shown
// distinctly as "not configured" rather than as an empty list — having no images and having no store are different states.
export default async function WorkspaceImagesPage() {
  const t = await getTranslations('workspaceImages')
  const { principal } = await currentPrincipal()
  const ctx = await authContext()

  let catalog: WorkspaceImageCatalog | null = null
  let unavailable = false
  try {
    catalog = workspaceImageCatalogSchema.parse(await controlPlane.listWorkspaceImages(ctx))
  } catch {
    unavailable = true
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <WorkspaceImagesManager
        catalog={catalog}
        canPush={can(principal?.roles, 'images:push')}
        unavailable={unavailable}
      />
      {/* The managed store's two member acts — bringing an external image IN, and minting the credential
          `everdict image push` consumes. Both had routes and neither could be reached from the web. */}
      {!unavailable && <ImageStoreActions canPush={can(principal?.roles, 'images:push')} />}
    </div>
  )
}
