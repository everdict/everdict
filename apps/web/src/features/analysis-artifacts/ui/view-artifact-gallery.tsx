import { getTranslations } from 'next-intl/server'

import {
  ArtifactCard,
  analysisArtifactsResponseSchema,
  type AnalysisArtifact,
} from '@/entities/analysis-artifact'
import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { SectionHeader } from '@/shared/ui/section-header'


// The View's pinned analysis artifacts (analysis-studio V3) — scheduled reports and agent-pinned charts/tables,
// newest first. Server-rendered from the agent service (visibility is double-gated: this page already 404s a
// foreign private view, and the agent route re-verifies with the forwarded bearer). An unreachable/unconfigured
// agent service collapses the section silently — the view page never breaks on an optional companion service.
export async function ViewArtifactGallery({ viewId }: { viewId: string }) {
  const t = await getTranslations('analysisArtifacts')
  let artifacts: AnalysisArtifact[]
  try {
    const ctx = await authContext()
    artifacts = analysisArtifactsResponseSchema.parse(
      await agentPlane.listViewArtifacts(ctx, viewId)
    ).artifacts
  } catch {
    return null
  }

  return (
    <section className="space-y-3">
      <SectionHeader title={t('galleryTitle')} />
      <p className="text-sm text-muted-foreground">{t('galleryDescription')}</p>
      {artifacts.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-3">
          {artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      )}
    </section>
  )
}
