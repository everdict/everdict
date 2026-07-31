import { getTranslations } from 'next-intl/server'

import { AgentChatOpener, AskAgentButton } from '@/widgets/infra-panel'
import {
  CustomAnalyzer,
  hasAnalysisParams,
  loadAnalysisData,
  paramsToConfig,
  storedToConfig,
} from '@/features/analyze-scorecards'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Scorecard analysis — THE studio canvas (docs/architecture/analysis-studio.md): a BLANK surface the
// conversation draws on. Creating an analysis is starting a conversation: the page lands empty (no stat tiles,
// no presets, no search, no filter/shape pickers) with the agent chat revealed on the right, and the agent's
// apply_view_config puts the first lens on the screen. A deep link (?view=<id> / config params) fills the
// canvas on arrival instead; saved views are first-class objects at /{ws}/views.
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
  // Nothing named = a NEW analysis: the canvas stays blank until the conversation draws on it.
  const initialConfig = linkedView
    ? storedToConfig(linkedView.config)
    : hasAnalysisParams(flat)
      ? paramsToConfig(flat)
      : undefined

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
      {/* Arriving on a blank canvas IS "new analysis" — open the chat on a FRESH conversation, so one analysis
          is one conversation. A deep-linked canvas keeps whatever thread is open (it may be the one that drew it). */}
      {flat.chat === '1' && (
        <AgentChatOpener
          prompt={agentPrompt}
          reference={agentReference}
          mission="viewAnalyze"
          fresh={!initialConfig}
        />
      )}
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('analyzeEmptyHint')} />
      ) : (
        <CustomAnalyzer
          scorecards={scorecards}
          authors={authors}
          initialConfig={initialConfig}
          savedViews={savedViews}
          currentSubject={subject}
          canManage={canManage}
          isAdmin={isAdmin}
          activeViewId={linkedView?.id}
          emptyAction={
            <AskAgentButton
              variant="primary"
              label={t('analyzeWithAgent')}
              prompt={agentPrompt}
              mission="viewAnalyze"
              fresh
            />
          }
        />
      )}
    </div>
  )
}
