-- ── THE EVENT IS THE ADDRESSABLE UNIT ───────────────────────────────────────────────────────────────
--
-- A trajectory's body was one jsonb value per plane, so there was no way to read part of one. Every reader
-- took all of it: detoasted by Postgres, shipped whole, turned into an object graph by pg's JSON.parse and
-- then copied ENTIRELY AGAIN by the Zod array parse that validates it. On a long-horizon run — hundreds of
-- turns, tool results carrying file dumps — that is several full copies of the largest object in the system,
-- in a process every workspace shares. See docs/architecture/long-horizon-trace-reads.md.
--
-- One row per event makes a WINDOW expressible, which is the only thing that actually fixes it. The primary
-- key IS the window's index: `WHERE run_id = $1 AND emitter = $2 AND seq > $3 ORDER BY seq LIMIT $4`.
--
-- `bytes` is the serialized size of this one event, recorded by the writer that serialized it. A page is
-- bounded by COUNT and by BYTES, because a hundred events is only a bound if the events are bounded — and
-- until the payload offload lands they are not. Asking Postgres for the size at read time would mean
-- detoasting the rows to decide whether to read them.
--
-- ON DELETE CASCADE from the header row, so retention (`deleteOlderThan`) keeps working unchanged and
-- evidence can never outlive the trajectory that names it.
CREATE TABLE IF NOT EXISTS everdict_trajectory_events (
  run_id text NOT NULL REFERENCES everdict_trajectories (run_id) ON DELETE CASCADE,
  -- The plane. Matches the parent row's `emitter` (or, for a header row written before planes existed, its
  -- `source`) — the same resolution the reads use, never a second spelling.
  emitter text NOT NULL,
  -- 1-based position within the plane. For a `spans` plane this is PROJECTION order, not arrival order: the
  -- seal sorts by `startedAt` before writing, because the read pages by seq and `spansToEvents` sorts by
  -- `startedAt`, so any other stored order would hand back a permuted stream. Rows are reordered; bytes never
  -- are — each event is stored exactly as it was sealed.
  seq integer NOT NULL,
  -- ONE TraceEvent, or ONE TraceSpan when the plane's `body_format` says `spans`. Which it is stays the
  -- parent row's statement about itself; nothing here is sniffed from the bytes (mig 0119's rule).
  body jsonb NOT NULL,
  bytes integer NOT NULL,
  PRIMARY KEY (run_id, emitter, seq)
);

-- ── WHICH FORM A PLANE IS IN, SAID BY THE ROW ───────────────────────────────────────────────────────
--
-- DEFAULT false, so every row written before this migration reads as what it is: a single-blob plane. Never
-- inferred from "are there rows in the events table" — that is a sniff, it costs a query, and it answers
-- wrong for a plane that legitimately sealed zero events.
--
-- A split plane keeps `body` as an empty array rather than NULL. `body` is NOT NULL and this migration does
-- not relax that on purpose: during a rolling deploy a replica running the previous release still reads
-- `body`, and an empty array degrades that replica to "this trajectory renders empty" — visible, temporary,
-- and non-destructive — where a NULL would crash it. The bytes are in the events table the whole time.
-- See docs/migration/preflight/0200_trajectory_events.md.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS body_split boolean NOT NULL DEFAULT false;
ALTER TABLE everdict_trajectory_segments ADD COLUMN IF NOT EXISTS body_split boolean NOT NULL DEFAULT false;

-- ── WHAT A PAGE OF A SPANS PLANE CANNOT SEE ─────────────────────────────────────────────────────────
--
-- `spansToEvents` measures every projected event's relative `t` from the earliest span IN THE BATCH it is
-- handed, and decides whether an aggregate span's tokens are a double-count by asking whether ANY chat span
-- in that batch reported its own. Both are properties of the PLANE. Project a page on its own and the clock
-- restarts at every page boundary and the page holding the aggregate double-counts its spend — the same
-- sealed evidence reading two ways depending on page size.
--
-- So the seal derives them once, over the whole plane it is holding anyway, and records them here; the paged
-- read passes them back into the projection instead of letting it re-derive them from a slice. NULL on an
-- `events` plane (there is nothing to project) and on rows sealed before this column existed — which is
-- consistent, because those rows are not split either and are read whole.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS batch jsonb;
ALTER TABLE everdict_trajectory_segments ADD COLUMN IF NOT EXISTS batch jsonb;
