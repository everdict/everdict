-- A criterion now says WHAT IT JUDGES (`judges`), and an unmet answer says WHY (`reason`). Both are required
-- by `ChangeCampaignRecordSchema`, which every read parses — so without this, a campaign stored before the
-- change becomes UNREADABLE rather than merely old, and the page that shows it fails instead of showing less.
--
-- ⚠️ THE BACKFILL DOES NOT GUESS. `judges` gets `{"kind":"unclassified"}`, which is deliberately not a synonym
-- for either real kind: these criteria were written when nothing recorded the distinction, and stamping them
-- `quality` would report an unmet REQUEST as a passed gate while `requirement` would invent a request nobody
-- made. The rollup counts them apart and the campaign page says the count is incomplete — "we cannot know" is
-- a third value, not a default (protocol L2). New campaigns cannot claim it: the request schema rejects it.
--
-- `reason` gets `attempted_and_failed` for the same reason in the other direction: it is the only member of
-- the vocabulary that claims nothing beyond "this did not come back met", which is exactly what the old
-- record said. The four that name something to go and get would each be a fact nobody recorded.
UPDATE everdict_change_campaigns
SET body = jsonb_set(
      body,
      '{criteria}',
      (
        SELECT COALESCE(jsonb_agg(
                 CASE WHEN criterion ? 'judges'
                      THEN criterion
                      ELSE criterion || '{"judges":{"kind":"unclassified"}}'::jsonb
                 END
                 ORDER BY ordinality
               ), '[]'::jsonb)
        FROM jsonb_array_elements(body->'criteria') WITH ORDINALITY AS t(criterion, ordinality)
      )
    )
WHERE jsonb_typeof(body->'criteria') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(body->'criteria') AS c(criterion)
    WHERE NOT (c.criterion ? 'judges')
  );

UPDATE everdict_change_campaigns
SET body = jsonb_set(
      body,
      '{rounds}',
      (
        SELECT COALESCE(jsonb_agg(
                 jsonb_set(
                   round,
                   '{judgement,answers}',
                   (
                     SELECT COALESCE(jsonb_agg(
                              CASE WHEN answer->>'answer' = 'met' OR answer ? 'reason'
                                   THEN answer
                                   ELSE answer || '{"reason":"attempted_and_failed"}'::jsonb
                              END
                              ORDER BY a.ordinality
                            ), '[]'::jsonb)
                     FROM jsonb_array_elements(round->'judgement'->'answers') WITH ORDINALITY AS a(answer, ordinality)
                   )
                 )
                 ORDER BY r.ordinality
               ), '[]'::jsonb)
        FROM jsonb_array_elements(body->'rounds') WITH ORDINALITY AS r(round, ordinality)
      )
    )
WHERE jsonb_typeof(body->'rounds') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(body->'rounds') AS r(round),
         jsonb_array_elements(r.round->'judgement'->'answers') AS a(answer)
    WHERE a.answer->>'answer' <> 'met' AND NOT (a.answer ? 'reason')
  );
