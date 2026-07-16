import { getTranslations } from 'next-intl/server'

import { modelSpecSchema, modelsSchema } from '@/entities/model'
import { secretsSchema } from '@/entities/secret'
import { ModelsManager, type ModelEntry } from '@/features/manage-models'
import {
  DefaultJudgeCard,
  workspaceSettingsSchema,
  type WorkspaceJudge,
} from '@/features/workspace-settings'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Models — workspace-owned + _shared LLM connections (provider/model/baseUrl/apiKeySecret). models:read;
// register/edit = models:write; delete = models:delete (creator exception handled server-side per row via currentSubject).
export default async function ModelsPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'models:read')
  const canWrite = can(principal?.roles, 'models:write')
  const canDelete = can(principal?.roles, 'models:delete')
  const header = <PageHeader title={t('models')} description={t('modelsDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  // Enrich each id with its latest spec (provider/model/baseUrl/apiKeySecret) so the card shows the connection + linked-key state.
  // A per-model detail fetch failure drops only that detail.
  let models: ModelEntry[] = []
  let error: string | undefined
  try {
    const summaries = modelsSchema.parse(await controlPlane.listModels(ctx))
    models = await Promise.all(
      summaries.map(async (summary): Promise<ModelEntry> => {
        const base = {
          id: summary.id,
          owner: summary.owner,
          versions: summary.versions,
          ...(summary.createdBy !== undefined ? { createdBy: summary.createdBy } : {}),
        }
        try {
          const spec = modelSpecSchema.parse(await controlPlane.getModel(ctx, summary.id, 'latest'))
          return { ...base, spec }
        } catch {
          return base
        }
      })
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // apiKeySecret picker draws from workspace secret names (values never come through).
  let secretNames: string[] = []
  try {
    secretNames = secretsSchema
      .parse(await controlPlane.listSecrets(ctx))
      .filter((secret) => secret.scope === 'workspace')
      .map((secret) => secret.name)
  } catch {
    // Secret store unconfigured — the apiKeySecret picker just shows no existing names.
  }

  // Workspace default judge model (references a registered model; resolved at judge-run time). Setting = settings:write (admin).
  // An unreadable settings response just drops the prefill — the picker still lets an admin set it.
  let defaultJudge: WorkspaceJudge | undefined
  try {
    defaultJudge = workspaceSettingsSchema.parse(await controlPlane.getWorkspaceSettings(ctx)).judge
  } catch {
    // settings unreadable / store unconfigured — no prefill
  }
  const canWriteSettings = can(principal?.roles, 'settings:write')
  // Picker source: registered models with a resolved spec (provider/model).
  const pickModels = models.flatMap((m) =>
    m.spec ? [{ id: m.id, provider: m.spec.provider, model: m.spec.model }] : []
  )

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : (
        <>
          <DefaultJudgeCard
            {...(defaultJudge ? { initialJudge: defaultJudge } : {})}
            models={pickModels}
            canWrite={canWriteSettings}
          />
          <ModelsManager
            models={models}
            secretNames={secretNames}
            canWrite={canWrite}
            canDelete={canDelete}
            {...(principal?.subject !== undefined ? { currentSubject: principal.subject } : {})}
          />
        </>
      )}
    </div>
  )
}
