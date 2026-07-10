// @everdict/billing — the cost/billing domain rules now live in @everdict/domain (re-architecture
// P1b); this package is a compat re-export shell (removed in the P4 sweep). The persistent
// control-plane impls (PersistentBudget/PersistentUsageMeter) stay in apps/api as adapters.
export {
  assertWithinBudget,
  billingTenant,
  type BudgetLimit,
  type BudgetTracker,
  type BudgetUsage,
  costOf,
  inMemoryBudget,
  type InMemoryBudgetOptions,
  inMemoryUsageMeter,
  sumCost,
  type TenantUsage,
  totalUsage,
  USAGE_SOURCES,
  type UsageMeter,
  type UsageSource,
  type UsageTotals,
} from "@everdict/domain";
