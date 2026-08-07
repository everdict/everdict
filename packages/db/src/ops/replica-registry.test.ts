import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgReplicaRegistry } from "./replica-registry.js";

function recorder(rows: unknown[] = []): { client: SqlClient; calls: Array<{ text: string; params?: unknown[] }> } {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    client: {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: rows as never[] };
      },
    },
  };
}

describe("PgReplicaRegistry — who is still running the control plane", () => {
  it("a heartbeat is an upsert, so a replica that restarts refreshes its row instead of failing on the key", async () => {
    const { client, calls } = recorder();

    await new PgReplicaRegistry(client, { replicaId: "cp-1" }).beat();

    expect(calls[0]?.text).toContain("INSERT INTO everdict_control_plane_replicas");
    expect(calls[0]?.text).toContain("ON CONFLICT (replica_id) DO UPDATE SET heartbeat_at = now()");
    expect(calls[0]?.params).toEqual(["cp-1"]);
  });

  it("liveness is judged against the database's clock, over the configured staleness window", async () => {
    const { client, calls } = recorder([{ replica_id: "cp-1" }, { replica_id: "cp-2" }]);

    const live = await new PgReplicaRegistry(client, { replicaId: "cp-1", staleMs: 45_000 }).liveReplicas();

    expect(live).toEqual(["cp-1", "cp-2"]);
    expect(calls[0]?.text).toContain("heartbeat_at > now() - make_interval");
    expect(calls[0]?.params).toEqual([45]);
  });

  it("leaving removes the row, so a successor reclaims this replica's work without waiting out the window", async () => {
    const { client, calls } = recorder();

    await new PgReplicaRegistry(client, { replicaId: "cp-1" }).leave();

    expect(calls[0]?.text).toContain("DELETE FROM everdict_control_plane_replicas");
    expect(calls[0]?.params).toEqual(["cp-1"]);
  });
});
