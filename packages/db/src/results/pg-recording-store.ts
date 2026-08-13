import type { RecordingSeal, RecordingStore } from "@everdict/application-control";
import {
  type CaseRecording,
  CaseRecordingSchema,
  type Fidelity,
  type RecordingRef,
  type TrackEntry,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";

interface RecordingRow {
  tracks: unknown;
  t0: string | number | null;
  env_kind: string | null;
  effective_fidelity: string | null;
  dispatch: unknown;
}

// Postgres-backed replay recording store. One row per runId; `append` pushes an entry onto its track lane via a
// jsonb append (row-locked, so concurrent appends for the same run serialize — no lost update), `seal` freezes the
// derived metadata (t0 + effectiveFidelity), `get` returns the sealed CaseRecording. Same contract as
// InMemoryRecordingStore — apps/api swaps the two by DATABASE_URL. docs/architecture/replay.md D4.
export class PgRecordingStore implements RecordingStore {
  constructor(private readonly client: SqlClient) {}

  async append(runId: string, item: TrackEntry, generation: number): Promise<void> {
    // Create the row + lane on first sight; on conflict append to the lane. jsonb_set under the row lock makes
    // concurrent appends for the same run safe.
    //
    // …and the WHERE on the conflict path is what revokes a producer from an earlier attempt (mig 0173): a
    // reset raised the generation, and a recorder still stamping the number it was started with writes
    // nothing from that moment.
    //
    // A SEALED RECORDING IS FINAL (arch-review 38 P0). It had no such condition, so a late report — and the
    // self-hosted lane's frame/log reports are fire-and-forget, so late is ORDINARY, not exceptional — kept
    // appending after the seal. The recording a reader is served then disagrees with its own metadata: frames
    // in the tracks, `effectiveFidelity: "final"` beside them, and a t0 computed before either arrived.
    await this.client.query(
      `INSERT INTO everdict_recordings (run_id, tracks, updated_at)
       VALUES ($1, jsonb_build_object($2::text, jsonb_build_array($3::jsonb)), now())
       ON CONFLICT (run_id) DO UPDATE SET
         tracks = jsonb_set(
           everdict_recordings.tracks,
           ARRAY[$2::text],
           COALESCE(everdict_recordings.tracks -> $2, '[]'::jsonb) || jsonb_build_array($3::jsonb),
           true
         ),
         updated_at = now()
       WHERE everdict_recordings.generation = $4::int AND everdict_recordings.sealed = false`,
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
    return rows.length > 0 ? { ref: `pg://recording/${runId}` } : undefined;
  }

  // A re-drive starts a fresh recording (arch-review 33 P1) — see the port for why this is a reset and not a
  // filter at seal time.
  async reset(runId: string): Promise<number> {
    // Clear the buffer AND raise the attempt (mig 0173) — the previous recorder keeps writing under the
    // number it was started with, and `append` refuses it from here on. One statement, so a producer can
    // never see an emptied buffer that still accepts its writes.
    const { rows } = await this.client.query<{ generation: number }>(
      `INSERT INTO everdict_recordings (run_id, tracks, generation, updated_at)
       VALUES ($1, '{}'::jsonb, 1, now())
       ON CONFLICT (run_id) DO UPDATE
         SET tracks = '{}'::jsonb,
             generation = everdict_recordings.generation + 1,
             t0 = NULL, env_kind = NULL, effective_fidelity = NULL, dispatch = NULL, sealed = false,
             updated_at = now()
       RETURNING generation`,
      [runId],
    );
    return Number(rows[0]?.generation ?? 0);
  }

  async get(runId: string): Promise<CaseRecording | undefined> {
    const { rows } = await this.client.query<RecordingRow>(
      "SELECT tracks, t0, env_kind, effective_fidelity, dispatch FROM everdict_recordings WHERE run_id = $1 AND sealed = true",
      [runId],
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

  // The live tail — the row as it stands, sealed or not (the player scrubs a still-running run with this).
  // Unsealed metadata is provisional: t0/fidelity derived from the tracks, envKind "live" until seal names it.
  async peek(runId: string): Promise<CaseRecording | undefined> {
    const { rows } = await this.client.query<RecordingRow & { sealed: boolean }>(
      "SELECT tracks, t0, env_kind, effective_fidelity, dispatch, sealed FROM everdict_recordings WHERE run_id = $1",
      [runId],
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
