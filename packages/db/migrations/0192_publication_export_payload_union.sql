-- A SETTLEMENT SAYS WHERE ITS BYTES ARE, OR WHY IT CANNOT (arch-review 55, Wave 9).
--
-- WHY. An export effect carried `payloadKey` as an OPTIONAL field, with its absence documented as the legacy
-- shape (mig 0188's backfill of the pre-Phase-4 column). It was never only that. `stageAnalysis` froze the
-- payload best-effort inside a bare `catch {}`, so a live settlement whose object store refused one PUT
-- produced a row byte-identical to one migrated from before the feature existed — and the drain silently took
-- the weaker path for both: re-read the record's current results, compare, refuse on mismatch. Fail-closed,
-- and unable to converge once anything re-scores, because the bytes it owed were never frozen.
--
-- The missing field was doing two incompatible jobs: "this predates payload freezing" (a statement about our
-- history) and "this settlement tried to freeze its bytes and failed" (an incident on THIS batch). Nothing
-- could tell them apart, and nothing said why. Rule `suite` already had the answer for this shape: absence is
-- not a legacy allowance — a state that must be weaker says so, and says why.
--
-- WHAT. `payloadKey` becomes a required discriminated `payload`. A row that had a key becomes `frozen` and is
-- performable exactly as before; a row that had none becomes `unfrozen` carrying the only reason this
-- migration can honestly give, which is that it was planned before the settle froze anything. The drain's
-- behaviour for those rows is unchanged — it is the record that stops being silent.
UPDATE everdict_publication_operations
   SET effects = (
         SELECT jsonb_agg(
                  CASE
                    WHEN e->>'kind' <> 'export' THEN e
                    WHEN e ? 'payloadKey' THEN
                      (e - 'payloadKey')
                        || jsonb_build_object('payload', jsonb_build_object('kind', 'frozen', 'key', e->>'payloadKey'))
                    ELSE
                      e || jsonb_build_object(
                             'payload',
                             jsonb_build_object(
                               'kind', 'unfrozen',
                               'reason', 'planned before this settlement froze its export payload (mig 0192)'
                             )
                           )
                  END
                )
           FROM jsonb_array_elements(effects) AS e
       )
 WHERE jsonb_array_length(effects) > 0
   AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(effects) AS e
          WHERE e->>'kind' = 'export' AND NOT (e ? 'payload')
       );

-- The same field on the pre-0188 column, for records that still carry it. `publication` is read through the
-- same schema, so a row left with an export effect that cannot say where its bytes are would fail to parse.
UPDATE everdict_scorecards
   SET publication = jsonb_set(
         publication,
         '{exports}',
         (
           SELECT jsonb_agg(
                    CASE
                      WHEN e ? 'payloadKey' THEN
                        (e - 'payloadKey')
                          || jsonb_build_object('payload', jsonb_build_object('kind', 'frozen', 'key', e->>'payloadKey'))
                      ELSE
                        e || jsonb_build_object(
                               'payload',
                               jsonb_build_object(
                                 'kind', 'unfrozen',
                                 'reason', 'planned before this settlement froze its export payload (mig 0192)'
                               )
                             )
                    END
                  )
             FROM jsonb_array_elements(publication->'exports') AS e
         )
       )
 WHERE publication IS NOT NULL
   AND jsonb_typeof(publication->'exports') = 'array'
   AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(publication->'exports') AS e WHERE NOT (e ? 'payload')
       );

-- …and the alias promotion mig 0191 removed from the operations ledger, removed from the same legacy column
-- for the same reason: `PublicationPlan` no longer declares `artifacts`, and a stored plan carrying one would
-- describe an effect nothing can perform.
UPDATE everdict_scorecards
   SET publication = publication - 'artifacts'
 WHERE publication IS NOT NULL
   AND publication ? 'artifacts';
