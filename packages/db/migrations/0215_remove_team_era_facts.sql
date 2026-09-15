-- 0215_remove_team_era_facts — the recorded facts that only described the team axis go with it.
--
-- 0212 dropped the team axis and left its FACTS behind: platform events of kind `harness.moved`,
-- `dataset.moved`, `judge.moved` and `scorecard.moved` (an ownership transfer between teams), and tracker
-- history entries `moved` (an issue changing teams), `member_added` and `member_removed` (a team roster change).
-- Nothing has emitted any of them since, and the vocabulary that parsed them is removed in the same change —
-- `PlatformEventRecordSchema` and `TrackerHistoryEntrySchema` parse every stored row against a closed list, so a
-- row still carrying one of these words would fail to read. Deleting them is compatible in both directions: the
-- code before this change tolerates their absence, and the code after it requires it. Irreversible.
--
-- The preflight for this file lives in `docs/migration/preflight/0215-remove-team-era-facts.md`.

-- ① Platform events, and the dead letters that parked one of them.
DELETE FROM everdict_event_dead_letters d
  USING everdict_platform_events e
  WHERE d.event_id = e.id
    AND e.kind IN ('harness.moved', 'dataset.moved', 'judge.moved', 'scorecard.moved');
DELETE FROM everdict_platform_events
  WHERE kind IN ('harness.moved', 'dataset.moved', 'judge.moved', 'scorecard.moved');

-- ② Tracker history entries, in every record that carries a history — order preserved.
UPDATE everdict_issues SET history = COALESCE((
    SELECT jsonb_agg(h ORDER BY o) FROM jsonb_array_elements(history) WITH ORDINALITY AS t(h, o)
    WHERE h->>'event' NOT IN ('moved', 'member_added', 'member_removed')
  ), '[]'::jsonb)
  WHERE history @> '[{"event":"moved"}]' OR history @> '[{"event":"member_added"}]' OR history @> '[{"event":"member_removed"}]';
UPDATE everdict_projects SET history = COALESCE((
    SELECT jsonb_agg(h ORDER BY o) FROM jsonb_array_elements(history) WITH ORDINALITY AS t(h, o)
    WHERE h->>'event' NOT IN ('moved', 'member_added', 'member_removed')
  ), '[]'::jsonb)
  WHERE history @> '[{"event":"moved"}]' OR history @> '[{"event":"member_added"}]' OR history @> '[{"event":"member_removed"}]';
UPDATE everdict_initiatives SET history = COALESCE((
    SELECT jsonb_agg(h ORDER BY o) FROM jsonb_array_elements(history) WITH ORDINALITY AS t(h, o)
    WHERE h->>'event' NOT IN ('moved', 'member_added', 'member_removed')
  ), '[]'::jsonb)
  WHERE history @> '[{"event":"moved"}]' OR history @> '[{"event":"member_added"}]' OR history @> '[{"event":"member_removed"}]';
UPDATE everdict_products SET history = COALESCE((
    SELECT jsonb_agg(h ORDER BY o) FROM jsonb_array_elements(history) WITH ORDINALITY AS t(h, o)
    WHERE h->>'event' NOT IN ('moved', 'member_added', 'member_removed')
  ), '[]'::jsonb)
  WHERE history @> '[{"event":"moved"}]' OR history @> '[{"event":"member_added"}]' OR history @> '[{"event":"member_removed"}]';
UPDATE everdict_product_releases SET history = COALESCE((
    SELECT jsonb_agg(h ORDER BY o) FROM jsonb_array_elements(history) WITH ORDINALITY AS t(h, o)
    WHERE h->>'event' NOT IN ('moved', 'member_added', 'member_removed')
  ), '[]'::jsonb)
  WHERE history @> '[{"event":"moved"}]' OR history @> '[{"event":"member_added"}]' OR history @> '[{"event":"member_removed"}]';
