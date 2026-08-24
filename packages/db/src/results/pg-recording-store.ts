import { type RecordingSeal, type RecordingStore, recordingRefOf } from "@everdict/application-control";
import { type CaseRecording, CaseRecordingSchema, type RecordingRef, type TrackEntry } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

interface RecordingRow {
  tracks: unknown;
  t0: string | number | null;
  env_kind: string | null;
  effective_fidelity: string | null;
  dispatch: unknown;
}

// Postgres-backed replay recording store. ONE ROW PER ATTEMPT (mig 0177), keyed `(run_id, generation)`:
// `open` inserts the next attempt, `append` pushes an entry onto its track lane via a jsonb append (row-locked,
// so concurrent appends for the same attempt serialize — no lost update), `seal` freezes the derived metadata
// (t0 + effectiveFidelity) over the row the write claims, `get` returns a sealed CaseRecording (the newest
// sealed attempt when the caller names none). Same contract as InMemoryRecordingStore — apps/api swaps the two
// by DATABASE_URL. docs/architecture/replay.md D4.
export class PgRecordingStore implements RecordingStore {
  constructor(private readonly client: SqlClient) {}

  async append(runId: string, item: TrackEntry, generation: number): Promise<void> {
    // Create the row + lane on first sight; on conflict append to the lane. jsonb_set under the row lock makes
    // concurrent appends for the same run safe.
    //
    // …and the row this claims is the ATTEMPT's (mig 0177), which is what revokes a producer from an earlier
    // one: each attempt owns its own row, and a recorder stamping a generation nobody opened writes into a row
    // of its own that no reader of the run's newest attempt will ever be served.
    //
    // A SEALED RECORDING IS FINAL (arch-review 38 P0). It had no such condition, so a late report — and the
    // self-hosted lane's frame/log reports are fire-and-forget, so late is ORDINARY, not exceptional — kept
    // appending after the seal. The recording a reader is served then disagrees with its own metadata: frames
    // in the tracks, `effectiveFidelity: "final"` beside them, and a t0 computed before either arrived.
    await this.client.query(
      `INSERT INTO everdict_recordings (run_id, tracks, generation, updated_at)
       VALUES ($1, jsonb_build_object($2::text, jsonb_build_array($3::jsonb)), $4::int, now())
       ON CONFLICT (run_id, generation) DO UPDATE SET
         tracks = jsonb_set(
           everdict_recordings.tracks,
           ARRAY[$2::text],
           COALESCE(everdict_recordings.tracks -> $2, '[]'::jsonb) || jsonb_build_array($3::jsonb),
           true
         ),
         updated_at = now()
       WHERE everdict_recordings.sealed = false`,
      [runId, item.track, JSON.stringify(item.entry), generation],
    );
  }

  async seal(runId: string, meta: RecordingSeal, generation: number): Promise<RecordingRef | undefined> {
    // ONE STATEMENT (arch-review 38 P0). This used to read the tracks, derive the metadata, and then UPDATE
    // by run_id alone — so a reset landing in between let an attempt freeze a row it had not read: the
    // metadata of generation N stamped onto generation N+1's recording. The derivation happens inside the
    // write now, over the row the write is claiming, under both conditions that make it this attempt's:
    // the generation it holds, and not already sealed.
    const { rows } = await this.client.query<{ run_id: string }>(
      `UPDATE everdict_recordings SET
         t0 = (SELECT MIN((e->>'t')::bigint) FROM jsonb_each(tracks) lane, jsonb_array_elements(lane.value) e),
         env_kind = $3,
         effective_fidelity = CASE
           WHEN jsonb_array_length(COALESCE(tracks -> 'frames', '[]'::jsonb)) > 0 THEN 'frames' ELSE 'final' END,
         dispatch = $4::jsonb,
         sealed = true,
         updated_at = now()
       WHERE run_id = $1 AND generation = $2 AND sealed = false
         AND EXISTS (SELECT 1 FROM jsonb_each(tracks) lane, jsonb_array_elements(lane.value) e)
       RETURNING run_id`,
      [runId, generation, meta.envKind, meta.dispatch ? JSON.stringify(meta.dispatch) : null],
    );
    // Nothing recorded, another attempt's row, or already frozen — in every case there is no ref that is ours.
    // The ref NAMES THE ATTEMPT (review 39 P1): a pointer that said only the run left a reader holding a
    // verdict unable to tell which execution it was about to play.
    return rows.length > 0 ? { ref: recordingRefOf("pg", runId, generation) } : undefined;
  }

  // A re-drive OPENS A NEW ATTEMPT (review 39, Phase 4) — see the port for why this is an insert and not the
  // reset it used to be.
  async open(runId: string, generation?: number): Promise<number> {
    // One statement: the next generation is computed and claimed together, so two openers cannot both read
    // the same max and then both insert it. The primary key refuses the second, this throws, and the caller
    // records the case as `unisolated` — a fence it could not raise, which is the fail-closed reading and not
    // a number to invent. Two opens for one execution id is already a driver that lost its authority.
    //
    // …unless the coordinate was MINTED ELSEWHERE (arch-review 42): the attempt ledger is the one authority
    // for the ordinal, so a caller holding a generation claims that exact row instead of computing a second
    // opinion. A collision throws here too, by the same primary key and for the same reason.
    const { rows } =
      generation === undefined
        ? await this.client.query<{ generation: number }>(
            `INSERT INTO everdict_recordings (run_id, tracks, generation, updated_at)
       SELECT $1, '{}'::jsonb, COALESCE(MAX(generation), 0) + 1, now()
         FROM everdict_recordings WHERE run_id = $1
       RETURNING generation`,
            [runId],
          )
        : await this.client.query<{ generation: number }>(
            `INSERT INTO everdict_recordings (run_id, tracks, generation, updated_at)
       VALUES ($1, '{}'::jsonb, $2::int, now())
       RETURNING generation`,
            [runId, generation],
          );
    const opened = rows[0]?.generation;
    // No row back means the insert was refused, and nothing here deletes recordings — so this is a store
    // fault, not an attempt number to invent. Returning 0 would hand the caller the generation every
    // un-fenced producer already stamps.
    if (opened == null) throw new Error(`recording attempt for ${runId} was not opened`);
    return Number(opened);
  }

  // The sealed replay. A caller naming a generation gets THAT attempt — the one its verdict was committed
  // under — and one naming none gets the newest sealed attempt, which is the run's current replay.
  async get(runId: string, generation?: number): Promise<CaseRecording | undefined> {
    const { rows } = await this.client.query<RecordingRow>(
      `SELECT tracks, t0, env_kind, effective_fidelity, dispatch FROM everdict_recordings
        WHERE run_id = $1 AND sealed = true AND ($2::int IS NULL OR generation = $2::int)
        ORDER BY generation DESC LIMIT 1`,
      [runId, generation ?? null],
    );
    const row = rows[0];
    if (!row || row.t0 == null || row.env_kind == null || row.effective_fidelity == null) return undefined;
    // The jsonb columns are already parsed by pg; the contract is validated once with Zod at this boundary.
    return CaseRecordingSchema.parse({
      runId,
      t0: Number(row.t0),
      tracks: row.tracks ?? {},
      envKind: row.env_kind,
      effectiveFidelity: row.effective_fidelity,
      ...(row.dispatch ? { dispatch: row.dispatch } : {}),
    });
  }

  // The live tail — the attempt as it stands, sealed or not (the player scrubs a still-running run with this).
  // Unsealed metadata is provisional: t0/fidelity derived from the tracks, envKind "live" until seal names it.
  async peek(runId: string, generation?: number): Promise<CaseRecording | undefined> {
    const { rows } = await this.client.query<RecordingRow & { sealed: boolean }>(
      `SELECT tracks, t0, env_kind, effective_fidelity, dispatch, sealed FROM everdict_recordings
        WHERE run_id = $1 AND ($2::int IS NULL OR generation = $2::int)
        ORDER BY generation DESC LIMIT 1`,
      [runId, generation ?? null],
    );
    const row = rows[0];
    if (!row) return undefined;
    const times = allEntryTimes(row.tracks);
    if (times.length === 0) return undefined; // a row with no entries yet has nothing to scrub
    const sealedMeta = row.sealed && row.t0 != null && row.env_kind != null && row.effective_fidelity != null;
    return CaseRecordingSchema.parse({
      runId,
      t0: sealedMeta ? Number(row.t0) : times.reduce((m, t) => Math.min(m, t), Number.POSITIVE_INFINITY),
      tracks: row.tracks ?? {},
      envKind: sealedMeta ? row.env_kind : "live",
      effectiveFidelity: sealedMeta ? row.effective_fidelity : hasFramesLane(row.tracks) ? "frames" : "final",
      ...(sealedMeta && row.dispatch ? { dispatch: row.dispatch } : {}),
    });
  }
}

// Every entry's `t` across all lanes — for the t0 anchor (earliest event). Boundary-safe over the raw jsonb.
function allEntryTimes(tracksJson: unknown): number[] {
  const times: number[] = [];
  if (tracksJson && typeof tracksJson === "object") {
    for (const lane of Object.values(tracksJson as Record<string, unknown>)) {
      if (!Array.isArray(lane)) continue;
      for (const e of lane) {
        const t = (e as { t?: unknown })?.t;
        if (typeof t === "number") times.push(t);
      }
    }
  }
  return times;
}

function hasFramesLane(tracksJson: unknown): boolean {
  if (tracksJson && typeof tracksJson === "object") {
    const frames = (tracksJson as Record<string, unknown>).frames;
    return Array.isArray(frames) && frames.length > 0;
  }
  return false;
}
