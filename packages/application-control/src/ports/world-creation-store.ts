import { z } from "zod";

// ── THE WORKLIST OF WORLDS THIS PLATFORM MADE (world-and-engagement-model.md, landing order 3.9) ─────
//
// A static world is somebody else's; a session world is somebody else's to expire. A world Everdict CREATES
// is the only one where "we could not find out whether it is gone" costs money, so it is the only one that
// owes a ledger — and rule `protocol` says what that ledger must be able to say:
//
//   L1  the intent is durable BEFORE the effect. A creation nobody recorded is compute nothing can address.
//   L5  completion is a VERIFIED zero. "The teardown was accepted" is not "it is gone", and a read that
//       could not answer is `unknown` — an escalation, never a terminal.
//
// So the row is created `creating`, moves to `created` once the world exists, `releasing` when the teardown
// starts, and `released` ONLY after a read-back said the world is not standing. Anything else stays owed and
// the reconciler picks it up.
export const CreatedWorldStateSchema = z.enum(["creating", "created", "releasing", "released", "unknown"]);
export type CreatedWorldState = z.infer<typeof CreatedWorldStateSchema>;

export const CreatedWorldRecordSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  runId: z.string().min(1), // the case's run — how an operator joins a leaked world to what asked for it
  environment: z.string().min(1), // "id@version" — the sealed world's identity, so a leak names its version
  state: CreatedWorldStateSchema,
  // What the world is, kept so a RECONCILER can tear it down without re-reading the registry: the case that
  // created it is long gone by then, and a registry read is one more thing that can be unavailable exactly
  // when the sweep matters.
  services: z.array(z.unknown()),
  // WHERE the world stands — the registered runtime the case was placed on. A sweep has no case to ask, so a
  // row that could not say which cluster its world is on is a row nothing can tear down.
  target: z.string().optional(),
  // ── A WORLD SEVERAL CASES TAKE TURNS IN (world-and-engagement-model.md) ──────────────────────────
  //
  // A `per-run` world stands up once and is shared by the batch's cases, so the row needs two things a
  // per-case row does not:
  //   `sharedKey`  what makes two cases' acquisitions the SAME world — one row, not one per case;
  //   `holders`    how many cases are inside it right now. Zero is what makes a release safe, and the count
  //                is moved by a conditional write rather than a read-then-write, because two cases entering
  //                at the same instant is the ordinary case rather than the rare one.
  //   `expiresAt`  the backstop for a holder that died without leaving. The refcount is the FENCE (a world is
  //                not torn down while somebody is in it); the lease is what stops a crashed holder from
  //                pinning a world forever, and it is refreshed on every acquire.
  sharedKey: z.string().optional(),
  // The coordinates the CREATOR got, kept on the row because a joiner has no other way to learn them: the
  // world exists in somebody else's process, and asking the runtime again would be a second answer to a
  // question one caller already had.
  endpoints: z.record(z.string(), z.string()).optional(),
  holders: z.number().int().nonnegative().default(0),
  expiresAt: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  detail: z.string().optional(), // why `unknown` — the sentence an operator reads
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CreatedWorldRecord = z.infer<typeof CreatedWorldRecordSchema>;

export interface WorldCreationStore {
  // The intent, written before anything is created. Returns the stored row — never void, because the caller
  // may not create a world it could not record (rule `protocol` L1).
  open(
    record: Omit<
      CreatedWorldRecord,
      "state" | "attempts" | "updatedAt" | "holders" | "sharedKey" | "endpoints" | "expiresAt"
    >,
  ): Promise<CreatedWorldRecord>;
  // A state transition that returns whether it happened. `false` = the row moved underneath this caller
  // (another sweep already owns it), which is a different answer from "it worked".
  transition(
    tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { detail?: string; bumpAttempts?: boolean; endpoints?: Record<string, string> },
  ): Promise<boolean>;
  get(tenant: string, id: string): Promise<CreatedWorldRecord | undefined>;
  // Every world still owed — the reconciler's whole input. Rows in `released` are done and never returned.
  due(now: string, staleBeforeMs: number): Promise<CreatedWorldRecord[]>;
  // ── JOINING AND LEAVING A SHARED WORLD ──────────────────────────────────────────────────────────
  //
  // One statement, so two cases arriving at the same instant get two different answers rather than both
  // believing they are first. `created: true` means THIS caller is the one that must stand the world up;
  // every other caller waits for it. The lease is refreshed here, which is what makes a live batch's world
  // outlive the sweep's patience without a heartbeat of its own.
  acquireShared(input: {
    id: string; // the row id to create when this caller is first
    tenant: string;
    runId: string;
    environment: string;
    sharedKey: string;
    services: unknown[];
    target?: string;
    expiresAt: string;
    now: string;
  }): Promise<{ row: CreatedWorldRecord; created: boolean }>;
  // Leave. `holders` is the remaining count AFTER this caller left; zero means the release may proceed.
  releaseShared(tenant: string, sharedKey: string): Promise<{ row: CreatedWorldRecord; holders: number } | undefined>;
  // The shared row as it stands — what a joiner polls while the first caller creates the world.
  getShared(tenant: string, sharedKey: string): Promise<CreatedWorldRecord | undefined>;
}
