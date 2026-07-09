-- Durable per-tenant budgets. The in-memory BudgetTracker (@everdict/backends) enforces synchronously and
-- write-throughs here, hydrating at boot so caps survive a control-plane restart (single-process read model, same
-- assumption as everdict_usage). Two tables: accumulated usage counters, and per-tenant limit config. Additive.
CREATE TABLE IF NOT EXISTS everdict_budget_usage (
  tenant text PRIMARY KEY,
  runs bigint NOT NULL DEFAULT 0,            -- reserved+committed run count (admit +1 / release -1), floored at 0
  usd double precision NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS everdict_budget_limits (
  tenant text PRIMARY KEY,
  usd double precision,                       -- NULL = unlimited on that dimension
  tokens bigint,
  runs bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
