import type { TrackEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgRecordingStore } from "./pg-recording-store.js";

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

describe("PgRecordingStore", () => {
  it("append upserts the entry onto its track lane (row-locked jsonb append)", async () => {
    // Given a store over a fake client
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgRecordingStore(client);

    // When a frame is appended
    const item: TrackEntry = { track: "frames", entry: { t: 1000, ref: "s3://f" } };
    await store.append("evd-run-1", item, 0);

    // Then it INSERTs with an ON CONFLICT jsonb append, carrying [runId, track, entry-json, generation]
    expect(calls[0]?.text).toContain("INSERT INTO everdict_recordings");
    // …onto the row of the attempt this producer serves (mig 0177) — the conflict target is the ATTEMPT,
    // so a recorder still stamping an earlier attempt's number appends to that attempt's row and never to
    // its successor's.
    expect(calls[0]?.text).toContain("ON CONFLICT (run_id, generation) DO UPDATE");
    expect(calls[0]?.text).toContain("jsonb_set");
    expect(calls[0]?.params).toEqual(["evd-run-1", "frames", JSON.stringify({ t: 1000, ref: "s3://f" }), 0]);
  });

  it("seal freezes the row in ONE statement, conditioned on the attempt and on not already being sealed", async () => {
    // Given the row is this attempt's and still open (the UPDATE matches and returns it)
    const { client, calls } = fakeClient(() => ({ rows: [{ run_id: "evd-run-1" }] }));
    const store = new PgRecordingStore(client);

    const ref = await store.seal("evd-run-1", { envKind: "browser" }, 0);

    expect(ref?.ref).toBe("pg://recording/evd-run-1/g0");
    const update = calls.find((c) => c.text.includes("UPDATE everdict_recordings"));
    // t0 and effectiveFidelity are DERIVED INSIDE the write, over the row it is claiming — the read-then-
    // write version let a reset land in between and stamp one attempt's metadata onto another's recording.
    expect(update?.text).toContain("generation = $2");
    expect(update?.text).toContain("sealed = false");
    expect(update?.text).toContain("MIN((e->>'t')::bigint)");
    expect(update?.params).toEqual(["evd-run-1", 0, "browser", null]);
  });

  it("seal returns undefined when the row is another attempt's or already sealed", async () => {
    // The conditional UPDATE matches nothing — the same answer for "not ours" and "already frozen", which is
    // right: in both cases there is no ref that is this attempt's to hand back.
    const { client } = fakeClient(() => ({ rows: [] }));
    const store = new PgRecordingStore(client);
    expect(await store.seal("evd-run-1", { envKind: "browser" }, 0)).toBeUndefined();
  });

  it("seal returns undefined when nothing was recorded for the run", async () => {
    // Given no row for the run
    const { client } = fakeClient(() => ({ rows: [] }));
    const store = new PgRecordingStore(client);
    expect(await store.seal("evd-run-x", { envKind: "repo" }, 0)).toBeUndefined();
  });

  it("open INSERTs the next attempt in one statement — it never clears the previous one", async () => {
    // Given the run already has attempts (the statement computes MAX(generation) + 1 itself)
    const { client, calls } = fakeClient(() => ({ rows: [{ generation: 3 }] }));
    const store = new PgRecordingStore(client);

    expect(await store.open("evd-run-1")).toBe(3);
    // Then it is an INSERT, not the UPDATE-to-empty it used to be: the previous attempt's tracks, seal and
    // metadata are untouched, and the next generation is claimed by the same statement that computed it.
    expect(calls[0]?.text).toContain("INSERT INTO everdict_recordings");
    expect(calls[0]?.text).toContain("COALESCE(MAX(generation), 0) + 1");
    expect(calls[0]?.text).not.toContain("UPDATE");
    expect(calls[0]?.params).toEqual(["evd-run-1"]);
  });

  it("open REFUSES to invent an attempt number when the insert came back empty", async () => {
    // Nothing deletes recordings, so an insert that returns no row is a store fault. Answering 0 would hand
    // the caller the generation every un-fenced producer already stamps — a fence that fences nothing.
    const { client } = fakeClient(() => ({ rows: [] }));
    await expect(new PgRecordingStore(client).open("evd-run-1")).rejects.toThrow("was not opened");
  });

  it("get serves the attempt the caller named, or the newest sealed one when it names none", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgRecordingStore(client);

    await store.get("evd-run-1", 2);
    expect(calls[0]?.text).toContain("ORDER BY generation DESC LIMIT 1");
    expect(calls[0]?.params).toEqual(["evd-run-1", 2]);

    // No generation → NULL, which the predicate reads as "any", so the newest sealed attempt answers.
    await store.get("evd-run-1");
    expect(calls[1]?.params).toEqual(["evd-run-1", null]);
  });

  it("get maps a sealed row to a validated CaseRecording", async () => {
    // Given a sealed row (pg returns bigint as a string, jsonb pre-parsed)
    const row = {
      tracks: { frames: [{ t: 1000, ref: "s3://f" }] },
      t0: "1000",
      env_kind: "browser",
      effective_fidelity: "frames",
      dispatch: { harness: "claude-code@1.0.0" },
    };
    const { client } = fakeClient(() => ({ rows: [row] }));
    const store = new PgRecordingStore(client);

    // When fetched, the row maps to a CaseRecording
    const rec = await store.get("evd-run-1");
    expect(rec?.runId).toBe("evd-run-1");
    expect(rec?.t0).toBe(1000); // bigint string → number
    expect(rec?.envKind).toBe("browser");
    expect(rec?.effectiveFidelity).toBe("frames");
    expect(rec?.tracks.frames?.[0]?.ref).toBe("s3://f");
    expect(rec?.dispatch?.harness).toBe("claude-code@1.0.0");
  });

  it("get returns undefined for an unsealed / missing recording", async () => {
    const { client } = fakeClient(() => ({ rows: [] }));
    const store = new PgRecordingStore(client);
    expect(await store.get("evd-run-x")).toBeUndefined();
  });

  it("peek serves the live tail of an unsealed row with derived provisional metadata", async () => {
    // Given an unsealed row still accumulating (no t0/env_kind frozen yet)
    const row = {
      tracks: { logs: [{ t: 2000, stream: "stdout", text: "x" }], frames: [{ t: 3000, ref: "s3://f" }] },
      t0: null,
      env_kind: null,
      effective_fidelity: null,
      dispatch: null,
      sealed: false,
    };
    const { client, calls } = fakeClient(() => ({ rows: [row] }));
    const store = new PgRecordingStore(client);

    // When peeked mid-run
    const rec = await store.peek("evd-run-1");

    // Then the read carries no sealed filter and the metadata is derived from the tracks
    expect(calls[0]?.text).not.toContain("sealed = true");
    expect(rec?.t0).toBe(2000);
    expect(rec?.envKind).toBe("live");
    expect(rec?.effectiveFidelity).toBe("frames");
  });

  it("peek keeps the frozen metadata of a sealed row, and answers undefined for an empty/missing one", async () => {
    const sealedRow = {
      tracks: { logs: [{ t: 5, stream: "stdout", text: "done" }] },
      t0: "5",
      env_kind: "repo",
      effective_fidelity: "final",
      dispatch: null,
      sealed: true,
    };
    const { client } = fakeClient(() => ({ rows: [sealedRow] }));
    expect((await new PgRecordingStore(client).peek("evd-run-1"))?.envKind).toBe("repo");

    const { client: empty } = fakeClient(() => ({ rows: [] }));
    expect(await new PgRecordingStore(empty).peek("evd-run-x")).toBeUndefined();
  });
});
