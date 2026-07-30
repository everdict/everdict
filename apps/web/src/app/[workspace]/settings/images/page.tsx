import { getTranslations } from 'next-intl/server'

import { WorkspaceImagesManager } from '@/features/manage-workspace-images'
import { workspaceImageCatalogSchema, type WorkspaceImageCatalog } from '@/entities/workspace-image'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Images — 관리형 이미지 스토어(everdict 자체 레지스트리)의 워크스페이스 네임스페이스.
// 읽기는 harnesses:read, 회수는 images:push. 관리형 스토어를 안 돌리는 배포에서는 라우트가 404이므로
// 빈 목록이 아니라 "설정되지 않음"으로 구분해서 보여준다 — 이미지가 없는 것과 스토어가 없는 것은 다른 상태다.
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
    </div>
  )
}
