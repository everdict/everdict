-- 0072_drop_schedule_regression_notifications — contract: the `schedule_regression` notification kind is retired.
-- Scheduled evals now emit a schedule-branded completion notification (`schedule_completed`/`schedule_failed`) from
-- the scorecard's own onComplete instead of a regression alert. The kind column is free-form text (no CHECK), but the
-- store validates every row against NotificationKindSchema on read (rowToRecord → .parse), so a lingering
-- `schedule_regression` row would throw and break the whole feed list. Delete those (feed rows are ephemeral, no FKs).
DELETE FROM everdict_notifications WHERE kind = 'schedule_regression';
