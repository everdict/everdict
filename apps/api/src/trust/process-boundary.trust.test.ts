import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-127.
//
// A REAL PROCESS BOUNDARY. Everything else in this suite runs in one Node process: real stores, real
// database, real SQL, one process. That is enough to certify a DECISION and not enough to certify that a
// booting control plane wires it — which is the whole content of "recovery works". TRUST-09 proves
// `recoverInterrupted` reclaims the dead replica's batch given a heartbeat set; it cannot prove that the
// composition root hands it the right heartbeat set, the right owner, or calls it at all.
//
// So this one kills nothing in-process. It writes two interrupted batches into a real database — one owned by
// a replica that is still beating, one owned by a replica that stopped — then BOOTS THE BUILT CONTROL PLANE
// as a child process against that database and reads what it did.
//
// The asymmetry is the point: a boot that reclaims everything is as wrong as one that reclaims nothing. The
// second replica's work is not the newcomer's to settle.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ENTRY = path.join(ROOT, "apps/api/dist/main.js");
// The BUILT entry, deliberately not a fallback to source: this scenario's whole claim is "what an operator
// runs", and running the TypeScript through a loader would certify a different program. The nightly builds
// before it runs; a missing build FAILS here rather than skipping, because a scenario that quietly does not
// run is the one thing this suite refuses to call a pass.
describe.skipIf(!TRUST_PG_ENABLED)(
  "TRUST-127 — a booting control plane reclaims the dead replica's work, not the live one's",
  () => {
    let pg: TrustPg;
    const ids = { dead: trustId("sc-dead"), live: trustId("sc-live") };
    const replicas = { dead: trustId("cp-dead"), live: trustId("cp-live") };

    beforeAll(async () => {
      pg = await openTrustPg();
    });
    afterAll(async () => pg?.close());

    async function seed(): Promise<void> {
      // Two replicas: one heartbeating NOW, one that stopped long ago. `staleMs` defaults to 30s.
      await pg.client.query(
        `INSERT INTO everdict_control_plane_replicas (replica_id, started_at, heartbeat_at)
       VALUES ($1, now() - interval '1 hour', now() - interval '1 hour'), ($2, now(), now())
       ON CONFLICT (replica_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
        [replicas.dead, replicas.live],
      );
      for (const [id, owner] of [
        [ids.dead, replicas.dead],
        [ids.live, replicas.live],
      ] as const)
        await pg.client.query(
          `INSERT INTO everdict_scorecards (id, tenant, dataset_id, dataset_version, harness_id, harness_version,
                                          status, owner_replica, created_at, updated_at)
         VALUES ($1,'trust','d','1.0.0','h','1','running',$2, now(), now())`,
          [id, owner],
        );
    }

    // The BUILT control plane, booted the way an operator boots it: one process, one database URL.
    async function bootOnce(): Promise<void> {
      const child = spawn(process.execPath, [ENTRY], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PORT: "18991",
          DATABASE_URL: process.env.EVERDICT_TRUST_DATABASE_URL ?? "",
          EVERDICT_RUNTIME_REQUIRED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        // Wait for the boot-recovery line the composition prints, not for a fixed sleep — a timing barrier
        // would make this scenario report on load rather than on behaviour (the flake this suite fixed once
        // already).
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("control plane did not report boot recovery in 60s")),
            60_000,
          );
          const watch = (chunk: Buffer): void => {
            if (chunk.toString().includes("boot recovery:")) {
              clearTimeout(timer);
              resolve();
            }
          };
          child.stdout?.on("data", watch);
          child.stderr?.on("data", watch);
          child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`control plane exited before recovery (code ${code})`));
          });
        });
      } finally {
        child.kill("SIGKILL");
      }
    }

    it("the control plane is BUILT — this scenario runs the artifact, not the source", () => {
      expect(existsSync(ENTRY), `${ENTRY} is missing — run \`pnpm build\` before the trust suite`).toBe(true);
    });

    it("the dead replica's batch is settled; the live replica's is left alone", async () => {
      await seed();
      await bootOnce();
      const { rows } = await pg.client.query<{ id: string; status: string; owner_replica: string | null }>(
        "SELECT id, status, owner_replica FROM everdict_scorecards WHERE id = ANY($1::text[])",
        [[ids.dead, ids.live]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      // The dead replica's batch stops being `running` — whether it resumed or was tombstoned INTERRUPTED is
      // the recovery decision's business; that it was ADDRESSED is this scenario's.
      expect(byId.get(ids.dead)?.status).not.toBe("running");
      // …and the live replica's is untouched, still owned by it. A boot that settles a peer's in-flight work
      // is the same defect as one that settles nothing, pointing the other way.
      expect(byId.get(ids.live)).toMatchObject({ status: "running", owner_replica: replicas.live });
    }, 90_000);
  },
);
