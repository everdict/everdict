import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgTrajectoryStore } from "./trajectory-store.js";

// ── [R122 COUNTEREXAMPLE] THE WORKSPACE IS A ROW FILTER, NOT ONLY A HEADER CHECK ────────────────────
//
// `everdict_trajectories` is keyed by `run_id` alone and `everdict_trajectory_segments` by
// `(run_id, emitter)` — neither key carries the workspace. The plane read selected `WHERE run_id = $1`,
// checked the HEADER row's tenant, and then returned every row it had found:
//
//     const rows = await this.planeRows(runId);        // by run_id, all workspaces
//     if (header.tenant !== tenant) return undefined;  // the header only
//     const segments = rows.map(planeOf);              // every row, whatever its tenant
//
//     the header belongs to this workspace   ≠   every plane under this run does
//
// Nothing leaks today: `seal` refuses a foreign tenant's append (`primary.tenant !== input.tenant`), so a
// foreign segment cannot exist. That is the point — the READ's isolation was living in the WRITE path. A
// backfill, a migration, or a second writer ends that silently, and these same rows feed retention.
//
// This test asserts the QUERY, because the defect is what the database was asked for. A fixture that seeds
// rows through `seal` could never see it: the guard it depends on is the one that keeps the bad row out.
//
// Seen RED by removing the predicate: "arm 1 selects rows from every workspace".
//
// ⚠️ AND THE LIMIT OF THIS SHAPE, STATED. The assertion reads SQL TEXT, so a neutralization that KEEPS the
// substring while defeating the predicate — `AND ($2 IS NOT NULL OR tenant = $2)` — passes it. That was tried
// first and it did pass. A text assertion pins the predicate's PRESENCE, never its meaning; what would pin
// the meaning is a foreign segment row, and the seal guard makes one unconstructable through any public path.
// So this is the strongest available check and it is not the strongest imaginable one, which is worth saying
// out loud rather than discovering later.
function capturing(): { client: SqlClient; texts: string[]; params: unknown[][] } {
  const texts: string[] = [];
  const params: unknown[][] = [];
  return {
    texts,
    params,
    client: {
      async query<R = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: R[] }> {
        texts.push(text);
        params.push(values);
        return { rows: [] as R[] };
      },
    },
  };
}

describe("[R122 COUNTEREXAMPLE] a plane read is scoped to the asking workspace in SQL", () => {
  it("filters BOTH the header and the segment rows by tenant", async () => {
    const { client, texts, params } = capturing();
    await new PgTrajectoryStore(client).planes("acme", "r1");

    const read = texts.find((t) => t.includes("everdict_trajectory_segments"));
    expect(read, "the plane read never ran").toBeDefined();
    // Both arms — a filter on the header alone is the defect, not a partial fix.
    const arms = (read ?? "").split("UNION ALL");
    expect(arms).toHaveLength(2);
    for (const [i, arm] of arms.entries())
      expect(arm.includes("tenant = $2"), `arm ${i} selects rows from every workspace`).toBe(true);
    expect(params[texts.indexOf(read ?? "")], "the workspace never reached the statement").toContain("acme");
  });

  it("the events read uses the same scoped rows — one door is not a guard", async () => {
    const { client, texts } = capturing();
    await new PgTrajectoryStore(client).events("acme", "r1", {});
    const read = texts.find((t) => t.includes("everdict_trajectory_segments"));
    expect(read?.includes("tenant = $2"), "the events lane reads planes unscoped").toBe(true);
  });
});
