import { getTranslations } from 'next-intl/server'

import { budgetResponseSchema, type BudgetResponse } from '@/entities/budget'
import { tenantUsageSchema, type TenantUsage } from '@/entities/usage'
import { BudgetManager } from '@/features/manage-budget'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Workspace › Budget — enforcement caps (block runs with 402) + metered billing usage. Readable by members
// (viewer+, reuses scorecards:read); editing the limit stays admin (settings:write). Consolidated from the old /usage page.
export default async function BudgetPage() {
  const t = await getTranslations('settingsNav')
  const s = await getTranslations('settingsPage')
  const { principal, ctx } = await currentPrincipal()
  const canRead = can(principal?.roles, 'scorecards:read')
  const canWrite = can(principal?.roles, 'settings:write')
  const header = <PageHeader title={t('budget')} description={t('budgetDesc')} />
  if (!canRead) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let budget: BudgetResponse | undefined
  let metered: TenantUsage | undefined
  let error: string | undefined
  try {
    budget = budgetResponseSchema.parse(await controlPlane.getBudget(ctx))
    metered = tenantUsageSchema.parse(await controlPlane.getUsage(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      {header}
      {error !== undefined ? (
        <Callout tone="danger">{s('connectError', { error })}</Callout>
      ) : budget ? (
        <BudgetManager
          usage={budget.usage}
          limit={budget.limit}
          {...(metered !== undefined ? { metered } : {})}
          canWrite={canWrite}
        />
      ) : null}
    </div>
  )
}
