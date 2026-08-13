-- The physical attempt's identity on the self-hosted lease queue.
--
-- A lease that expires is requeued by clearing `leased_by`, so the SAME job id is handed to the next runner
-- while the previous holder is still alive and still believes it holds the work. Both then push evidence
-- quoting a job id both were given, and the control plane had no way to tell one from the other: it took the
-- run id from the request body and stamped whatever attempt the receiving PROCESS happened to know about.
--
-- The epoch is minted by the claim (see the store's claim SQL: lease_epoch = lease_epoch + 1), so it changes on
-- every physical attempt and on nothing else. 0 = never leased, which no report can ride.
ALTER TABLE everdict_runner_jobs ADD COLUMN IF NOT EXISTS lease_epoch integer NOT NULL DEFAULT 0;
