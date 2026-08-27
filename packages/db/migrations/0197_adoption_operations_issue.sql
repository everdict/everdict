-- ── JOINING A RESOLUTION BACK TO THE AUTHORIZATION IT DISCHARGES (arch-review 73) ───────────────────
--
-- `completed` has been in this table's state vocabulary since it was created and nothing ever wrote it. The
-- state means the adoption's REASON is settled: the issue the campaign was opened against has been closed on
-- the evidence this adoption proved. That is the fourth of the four silent states arch-review 71 enumerated
-- (settle-then-crash · a save with no gate · one label over two specs · adopted with the issue still open),
-- and the only one still open.
--
-- The writer is an E1 cursor consumer over issue.status_changed, so the lookup it needs is BY ISSUE. The
-- issue id lives inside the proof document — deliberately, because the proof is stored verbatim rather than
-- split into columns (a comparison over columns checks four of the six fields) — so the index is expressional
-- rather than a duplicated column. A duplicated column would be a second copy of a value the proof already
-- owns, and the two would eventually disagree.
CREATE INDEX IF NOT EXISTS everdict_adoption_operations_issue
  ON everdict_adoption_operations (tenant, (proof ->> 'issueId'));

-- The worklist for the other direction: adoptions that landed and whose intent nobody has closed. An
-- operator reading this is reading "capabilities we adopted and never said why we are done".
CREATE INDEX IF NOT EXISTS everdict_adoption_operations_unsettled
  ON everdict_adoption_operations (updated_at)
  WHERE state = 'registered';
