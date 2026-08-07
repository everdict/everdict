-- Task executor (LESSON 059 P1): a completed task carries the completer's RESULTS back to whoever waits on
-- it — the requester parked on task.completed reads the output after the wake. Additive.
ALTER TABLE everdict_agent_tasks ADD COLUMN IF NOT EXISTS output text;
