-- Crash reconcile (LESSON 059 P0): the agent service's boot sweep scans for headless runs stranded in
-- status = 'running' by a process death. Partial index keeps that scan off the full session table — the
-- stranded set is tiny by nature (same shape as the wake-intent partial index).
CREATE INDEX IF NOT EXISTS everdict_agent_sessions_running_idx
  ON everdict_agent_sessions (updated_at)
  WHERE status = 'running';
