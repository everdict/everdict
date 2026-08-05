import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { WorkspaceImageDetail, type ImageEnvironmentLink } from '@/features/manage-workspace-images'
import { capabilitiesSchema } from '@/entities/capability'
import {
  workspaceImageCatalogSchema,
  workspaceImageInspectSchema,
  workspaceImageTagsSchema,
  type WorkspaceImageCatalog,
  type WorkspaceImageInspect,
} from '@/entities/workspace-image'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { imageRepositoryOf } from '@/shared/lib/image-ref'
import { isSemver, sortSemverDesc } from '@/shared/lib/semver'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 버전 정렬 — JFrog 문법: latest 가 먼저, 그 다음 semver 내림차순, 나머지는 사전順 내림차순. 레지스트리는
// 오름차순 사전순으로만 답하므로 "가장 최신일 것"이 위로 오게 여기서 정렬한다.
function orderTags(tags: string[]): string[] {
  const latest = tags.filter((t) => t === 'latest')
  const semver = sortSemverDesc(tags.filter((t) => t !== 'latest' && isSemver(t.replace(/^v/, ''))))
  const rest = tags
    .filter((t) => t !== 'latest' && !isSemver(t.replace(/^v/, '')))
    .sort((a, b) => b.localeCompare(a))
  return [...latest, ...semver, ...rest]
}

// Settings › Images › [name] — 리포지토리 하나의 상세: 버전(태그) → 고른 버전의 다이제스트/크기/플랫폼 →
// 빌드 히스토리(OCI config) → 런타임 계약 → 이 이미지를 선언한 환경(everdict 컨텍스트). 상세는 라우트이지
// 다이얼로그가 아니다(우측 대화 패널과 나란히 쓰는 화면).
export default async function WorkspaceImageDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; name: string }>
}) {
  const { workspace, name: raw } = await params
  const name = decodeURIComponent(raw)
  const t = await getTranslations('workspaceImages')
  const { principal, ctx } = await currentPrincipal()

  let catalog: WorkspaceImageCatalog
  try {
    catalog = workspaceImageCatalogSchema.parse(await controlPlane.listWorkspaceImages(ctx))
  } catch {
    notFound() // 관리형 스토어가 없는 배포 — 목록과 같은 404 판정
  }
  const repo = catalog.repositories.find((r) => r.name === name)
  if (!repo) notFound()

  let tags: string[] = []
  try {
    tags = orderTags(
      workspaceImageTagsSchema.parse(await controlPlane.listWorkspaceImageTags(ctx, name)).tags
    )
  } catch {
    // 태그를 못 읽어도 상세는 뜬다 — 빈 목록이 "없다"가 아니라 "못 읽었다"로 보이는 건 콜아웃 몫.
  }

  // 첫 버전은 서버에서 미리 열어 둔다 — 상세에 들어왔는데 아무것도 선택 안 된 화면은 빈 껍데기다.
  const initialReference = tags[0] ?? null
  let initialInspect: WorkspaceImageInspect | null = null
  if (initialReference) {
    try {
      initialInspect = workspaceImageInspectSchema.parse(
        await controlPlane.inspectWorkspaceImage(ctx, name, initialReference)
      )
    } catch {
      // inspect 실패는 요약 없는 상세로 강등 — 클라이언트 콜아웃이 안내한다.
    }
  }

  // everdict 컨텍스트 — 이 리포지토리를 선언한 환경 capability(태그/다이제스트 무관 매칭). 실패는 섹션 생략.
  let environments: ImageEnvironmentLink[] = []
  try {
    environments = capabilitiesSchema
      .parse(await controlPlane.listCapabilities(ctx))
      .flatMap((cap) => {
        if (cap.spec.type !== 'environment') return []
        if (imageRepositoryOf(cap.spec.image) !== repo.image) return []
        return [
          {
            id: cap.id,
            version: cap.version,
            name: cap.name,
            description: cap.description,
            instructions: cap.spec.instructions,
            ...(cap.spec.contents?.benchmark ? { benchmark: cap.spec.contents.benchmark } : {}),
            packages: cap.spec.contents?.packages ?? [],
            ...(cap.spec.contents?.os ? { os: cap.spec.contents.os } : {}),
            ...(cap.spec.contents?.arch ? { arch: cap.spec.contents.arch } : {}),
          },
        ]
      })
  } catch {
    // capability 스토어를 못 읽으면 컨텍스트 섹션만 사라진다 — 레지스트리 상세는 그대로 선다.
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/settings/images`}
        className="inline-flex items-center gap-1 text-[13px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t('backToImages')}
      </Link>
      <PageHeader title={repo.name} description={t('detailDescription')} />
      <WorkspaceImageDetail
        workspace={workspace}
        name={repo.name}
        image={repo.image}
        tags={tags}
        initialReference={initialReference}
        initialInspect={initialInspect}
        environments={environments}
        canPush={can(principal?.roles, 'images:push')}
      />
    </div>
  )
}
