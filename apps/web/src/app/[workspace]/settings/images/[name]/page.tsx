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

// Version ordering — the JFrog grammar: latest first, then semver descending, then the rest lexicographically descending. The registry only
// answers in ascending lexicographic order, so "the most likely newest" is sorted to the top here.
function orderTags(tags: string[]): string[] {
  const latest = tags.filter((t) => t === 'latest')
  const semver = sortSemverDesc(tags.filter((t) => t !== 'latest' && isSemver(t.replace(/^v/, ''))))
  const rest = tags
    .filter((t) => t !== 'latest' && !isSemver(t.replace(/^v/, '')))
    .sort((a, b) => b.localeCompare(a))
  return [...latest, ...semver, ...rest]
}

// Settings › Images › [name] — one repository's detail: versions (tags) → the chosen version's digest/size/platform → the build history
// (OCI config) → the runtime contract → the environment that declared this image (the everdict context). The detail is a ROUTE and not a
// dialog (a screen used beside the conversation panel on the right).
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
    notFound() // a deployment with no managed store — the same 404 judgement as the list
  }
  const repo = catalog.repositories.find((r) => r.name === name)
  if (!repo) notFound()

  let tags: string[] = []
  try {
    tags = orderTags(
      workspaceImageTagsSchema.parse(await controlPlane.listWorkspaceImageTags(ctx, name)).tags
    )
  } catch {
    // The detail still renders when the tags cannot be read — making an empty list read as "there are none" rather than "it could not be read" is the callout's job.
  }

  // The first version is opened on the SERVER — arriving at a detail with nothing selected is an empty shell.
  const initialReference = tags[0] ?? null
  let initialInspect: WorkspaceImageInspect | null = null
  if (initialReference) {
    try {
      initialInspect = workspaceImageInspectSchema.parse(
        await controlPlane.inspectWorkspaceImage(ctx, name, initialReference)
      )
    } catch {
      // An inspect failure degrades to a detail with no summary — the client callout explains.
    }
  }

  // The everdict context — the environment capability that declared this repository (matched regardless of tag or digest). A failure omits the section.
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
    // With the capability store unreadable only the context section disappears — the registry detail still stands.
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
