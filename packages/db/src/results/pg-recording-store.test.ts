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
    await store.append("evd-run-1", item);

    // Then it INSERTs with an ON CONFLICT jsonb append, carrying [runId, track, entry-json]
    expect(calls[0]?.text).toContain("INSERT INTO everdict_recordings");
    expect(calls[0]?.text).toContain("ON CONFLICT (run_id) DO UPDATE");
    expect(calls[0]?.text).toContain("jsonb_set");
    expect(calls[0]?.params).toEqual(["evd-run-1", "frames", JSON.stringify({ t: 1000, ref: "s3://f" })]);
  });

  it("seal derives t0 + effectiveFidelity from the accumulated tracks and freezes them", async () => {
    // Given accumulated tracks (a frame + an earlier log) returned by the SELECT
    const tracks = {
      frames: [{ t: 2000, ref: "s3://f2" }],
      logs: [{ t: 1000, stream: "stdout", text: "x" }],
    };
    const { client, calls } = fakeClient((text) =>
      text.includes("SELECT tracks") ? { rows: [{ tracks }] } : { rows: [] },
    );
    const store = new PgRecordingStore(client);

    // When sealed
    const ref = await store.seal("evd-run-1", { envKind: "browser" });

    // Then it UPDATEs with t0=earliest(1000) + effectiveFidelity="frames" and returns a pg ref
    expect(ref?.ref).toBe("pg://recording/evd-run-1");
    const update = calls.find((c) => c.text.includes("UPDATE everdict_recordings"));
    expect(update?.params).toEqual(["evd-run-1", 1000, "browser", "frames", null]);
  });

  it("seal returns undefined when nothing was recorded for the run", async () => {
    // Given no row for the run
    const { client } = fakeClient(() => ({ rows: [] }));
    const store = new PgRecordingStore(client);
    expect(await store.seal("evd-run-x", { envKind: "repo" })).toBeUndefined();
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
});
