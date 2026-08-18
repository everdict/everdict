-- THE WRITE-ONLY EFFECT IS DELETED (arch-review 55, Wave 7).
--
-- WHY. A publication operation could owe two effects: promote the mutable `analyses/<id>.json` alias, and
-- export to the tenant's trace sink. The first was write-only. It was planned exactly when staging produced
-- `revisionKey` — the same value the settle records on its scoring revision as `analysisKey` — and the
-- analysis reader resolves `scoring.at(-1).analysisKey` FIRST, falling back to the alias only when there is
-- none. So every promotion wrote an object its own settlement had just made unreachable, and every read that
-- reaches the alias belongs to a revision for which nothing was ever promoted.
--
-- It was also the one effect whose monotonicity could not be enforced. Its position came from this ledger and
-- its bytes went to an object store, with no conditional put to join them, so two settlements draining
-- concurrently could still land newest-first. Arch-review 54 Phase 4 guarded it with a revision compare and
-- arch-review 55 Wave 5 made that guard three-valued; neither closes the window, because the window is
-- between the read and the put. Deleting an effect nobody reads is the fix a guard could not be.
--
-- WHAT. The effects array drops every `artifact` entry, so no stored row carries a variant the contract's
-- discriminated union no longer has. An operation left owing NOTHING was an alias-only debt — a sinkless
-- install's every batch — and is deleted outright rather than left pending for a drain that would find no
-- effects; a published one is kept, because it is history.
--
-- Objects already written under `analyses/<id>.json` are untouched. The reader's fallback still finds them,
-- which is what keeps the pre-staging records readable; there is simply no longer a writer.
UPDATE everdict_publication_operations
   SET effects = COALESCE(
         (SELECT jsonb_agg(e) FROM jsonb_array_elements(effects) AS e WHERE e->>'kind' <> 'artifact'),
         '[]'::jsonb
       )
 WHERE effects @> '[{"kind": "artifact"}]'::jsonb;

DELETE FROM everdict_publication_operations
 WHERE jsonb_array_length(effects) = 0
   AND state <> 'published';

-- A published alias-only row keeps its (now empty) effects: it records that a settlement's outward debt was
-- discharged, and rewriting history to say it owed nothing would lose that.
