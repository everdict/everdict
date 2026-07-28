import { getTranslations } from 'next-intl/server'

import { budgetResponseSchema, type BudgetResponse } from '@/entities/budget'
import { tenantUsageSchema, type TenantUsage } from '@/entities/usage'
import { BudgetManager, UsageOverview } from '@/features/manage-budget'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { Separator } from '@/shared/ui/separator'

export const dynamic = 'force-dynamic'

// Workspace › Budget — the billing view: metered usage FIRST (daily-spend chart + tiles + breakdown, the money the
// workspace actually burns) with the enforcement caps (block runs with 402) below. Readable by members (viewer+,
// reuses scorecards:read); editing the limit stays admin (settings:write). Consolidated from the old /usage page.
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
      ) : (
        <>
          {metered !== undefined && <UsageOverview metered={metered} />}
          {metered !== undefined && budget && <Separator />}
          {budget && <BudgetManager usage={budget.usage} limit={budget.limit} canWrite={canWrite} />}
        </>
      )}
    </div>
  )
}
