import { getTranslations } from 'next-intl/server'

import { AgentChatOpener, AskAgentButton } from '@/widgets/infra-panel'
import {
  CustomAnalyzer,
  loadAnalysisData,
  paramsToConfig,
  storedToConfig,
} from '@/features/analyze-scorecards'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Scorecard analysis — THE studio canvas (docs/architecture/analysis-studio.md): one flexible pivot surface.
// Natural language in the right-hand agent chat and the manual pickers drive the SAME AnalysisConfig
// (apply_view_config), so there are no modes — the legacy easy/custom wizard split is gone. Saved views are
// first-class objects (/{ws}/views); ?view=<id> opens one live, ?chat=1 lands with the conversation revealed.
export default async function AnalyzePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('scorecardsPage')
  const sp = await searchParams
  const flat: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? v[0] : v

  const { scorecards, authors, savedViews, subject, canManage, isAdmin, error } =
    await loadAnalysisData()

  // ?view=<id> deep link — opening a saved View fills the canvas with its config (live re-run).
  const linkedView = flat.view ? savedViews.find((v) => v.id === flat.view) : undefined

  const agentReference = linkedView
    ? { type: 'view' as const, id: linkedView.id, label: linkedView.name }
    : undefined
  const agentPrompt = t('analyzeAgentPrompt')

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('analyze')}
        description={t('analyzeCustomDesc')}
        actions={
          <AskAgentButton
            variant="primary"
            label={t('analyzeWithAgent')}
            prompt={agentPrompt}
            reference={agentReference}
            mission="viewAnalyze"
          />
        }
      />
      {flat.chat === '1' && (
        <AgentChatOpener prompt={agentPrompt} reference={agentReference} mission="viewAnalyze" />
      )}
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('analyzeEmptyHint')} />
      ) : (
        <CustomAnalyzer
          scorecards={scorecards}
          authors={authors}
          initialConfig={linkedView ? storedToConfig(linkedView.config) : paramsToConfig(flat)}
          savedViews={savedViews}
          currentSubject={subject}
          canManage={canManage}
          isAdmin={isAdmin}
          activeViewId={linkedView?.id}
        />
      )}
    </div>
  )
}
