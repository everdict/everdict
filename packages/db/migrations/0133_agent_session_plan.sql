-- Plan durability (LESSON 059 P6): a plan-mode approval promotes the plan to standing session state, so it
-- keeps steering after the running-memory fold and across a service restart — a plan that lived only in the
-- transcript stopped steering the moment bounded replay dropped it. Additive.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS plan jsonb;
