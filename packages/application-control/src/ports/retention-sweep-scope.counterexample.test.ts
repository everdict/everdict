import { describe, expect, it } from "vitest";
import {
  OffloadingTrajectoryStore,
  REF_SCAN_RUNS,
  type TrajectoryPayloadArtifacts,
} from "./offloading-trajectory-store.js";
import { type TrajectoryPayloadRef, type TrajectoryStore, payloadKeyPrefix } from "./trajectory-store.js";

// ── A SWEEP'S COST IS ITS PAGE, NOT THE CORPUS (perf review) ────────────────────────────────────────
//
// `deleteOlderThan` takes a BOUNDED page of expired runs — `expiredRuns(cutoff, sweepLimit)` — and then has
// to account for every payload object those runs name before deleting their rows. The accounting read was
// `payloadRefsOlderThan(cutoffIso, page, after)`: scoped to the CUTOFF, so it enumerated every expired
// trajectory in the deployment, and the decorator threw away everything outside its own page with
//
//     if (!wanted.has(owned.runId)) continue;
//
// The filter was right and its LOCATION was the defect. To delete `sweepLimit` runs the sweep drained the
// whole expired corpus, page by page — on Postgres re-running `jsonb_path_query(body, '$.**')` over every
// expired event body and re-sorting it per page, on ClickHouse re-running a regex over the largest column in
// the system and rebuilding a full-table hash join. Hourly, in the API process, sharing a connection pool
// with every request handler: quadratic in the thing that grows fastest in the product.
//
// The composition is the point (skill `code-review`, pass 4): a BOUNDED page followed by an UNBOUNDED
// enumeration is unbounded, and both lines look correct on their own.
//
// SEEN RED by neutralizing the scope in `deleteOlderThan` — restoring the pre-fix breadth through the new
// signature, `const runIds = (await this.inner.expiredRuns(cutoffIso, 1_000_000)).map((r) => r.runId)` —
// observed:
//   AssertionError: the drain read refs for runs this sweep had not claimed:
//   expected [ Array(200) ] to strictly equal [ 'r-0000', 'r-0001' ]

const TENANT = "acme";
// Must exceed the largest page any test below claims, or the fixture never reaches the predicate: a page
// capped by the store's own row count cannot span more runs than the chunk bound allows, and the assertion
// becomes vacuously true (rule `testing` — a fixture that does not reach the predicate proves nothing).
const EXPIRED_RUNS = 700;
const SWEEP_PAGE = 2;

const runIdAt = (i: number): string => `r-${String(i).padStart(4, "0")}`;
// A ref this store minted for that run — `ownsPayloadKey` must accept it, or the drain skips the delete and
// the test would pass over a sweep that removed nothing.
const refAt = (i: number): string => `artifact://${payloadKeyPrefix(TENANT, runIdAt(i))}/sha256:${"a".repeat(64)}.out`;

// The inner store: every expired run holds exactly one payload ref, and `payloadRefsOf` answers ONLY for the
// runs it was asked about — which is what both adapters do in SQL now. A double whose scope is wider than
// production's could not see this defect at all (rule `testing`).
function innerStore(asked: string[][]): TrajectoryStore {
  const alive = new Set(Array.from({ length: EXPIRED_RUNS }, (_, i) => runIdAt(i)));
  return {
    async seal() {
      throw new Error("not used");
    },
    async planes() {
      return undefined;
    },
    async events() {
      return { kind: "absent" as const };
    },
    async usage() {
      return { kind: "absent" as const };
    },
    async list() {
      return { items: [] };
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
    async deleteOlderThan() {
      throw new Error("the decorator must sweep by run id, never by cutoff");
    },
    async expiredRuns(_cutoffIso: string, limit: number) {
      return [...alive]
        .sort()
        .slice(0, limit)
        .map((runId) => ({ tenant: TENANT, runId }));
    },
    async deleteRuns(runIds: readonly string[]) {
      let removed = 0;
      for (const id of runIds) if (alive.delete(id)) removed += 1;
      return removed;
    },
    async payloadRefsOf(runIds: readonly string[], limit: number, after?: TrajectoryPayloadRef) {
      asked.push([...runIds]);
      const wanted = new Set(runIds);
      return Array.from({ length: EXPIRED_RUNS }, (_, i) => ({ tenant: TENANT, runId: runIdAt(i), ref: refAt(i) }))
        .filter((row) => wanted.has(row.runId))
        .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
        .filter((row) => after === undefined || row.ref > after.ref)
        .slice(0, limit);
    },
  };
}

// Typed by the port rather than cast into it (rule `typescript`): a double built behind
// `as unknown as T` is checked by nothing, and the compiler is the only reader that notices when the port
// grows a method this sweep would then never exercise.
function artifacts(removed: string[]): TrajectoryPayloadArtifacts {
  const store: TrajectoryPayloadArtifacts = {
    async put() {
      throw new Error("the sweep never writes");
    },
    async get() {
      throw new Error("the sweep never reads bytes");
    },
    async publicUrlFor() {
      return undefined;
    },
    async remove(key: string) {
      removed.push(key);
    },
    // Empty on purpose: the prefix listing is the sweep's SECOND pass (objects no row ever named), and this
    // file is about the first one. `payload-offload.counterexample.test.ts` covers the listing.
    async listKeys() {
      return [];
    },
  };
  return store;
}

describe("the retention sweep enumerates only the runs it claimed", () => {
  it("asks for the page's run ids, not for every expired trajectory", async () => {
    // Given: 200 expired runs and a sweep whose page is 2
    const asked: string[][] = [];
    const removed: string[] = [];
    const store = new OffloadingTrajectoryStore(innerStore(asked), artifacts(removed), SWEEP_PAGE);

    // When: one sweep runs
    const swept = await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    // Then: it deleted its page…
    expect(swept).toBe(SWEEP_PAGE);
    // …and every enumeration it made was scoped to exactly that page. The premise first: the drain really
    // did run, or an empty `asked` would satisfy every assertion below.
    expect(asked.length, "the drain never ran, so this proves nothing about its scope").toBeGreaterThan(0);
    const claimed = new Set([runIdAt(0), runIdAt(1)]);
    for (const scope of asked)
      for (const id of scope)
        expect(claimed.has(id), "the drain read refs for a run this sweep had not claimed").toBe(true);
  });

  // ── AND EACH STATEMENT IS BOUNDED IN WORK, NOT ONLY IN RESULTS (perf review, measured) ─────────
  //
  // Scoping to the claimed page fixed the corpus-sized drain and left a second unbounded step: one
  // enumeration statement expands `runs × events-per-run × json-leaves-per-event`, and only the first factor
  // is chosen here. Measured, at 40 events per run: 500 runs → 311 ms, 5000 runs → 3.6 s — linear, so a
  // long-horizon workspace (hundreds of turns, tool results holding file dumps) multiplies that by ten or
  // fifty and every statement exceeds the shared `statement_timeout`. The sweep then reports `failed` for
  // ever and never converges, which is worse than the slow read it replaced.
  //
  // SEEN RED by neutralizing the chunk loop back to one call over the whole page
  // (`await this.drainRefs(runIds, page)`), observed:
  //   AssertionError: one enumeration spanned more runs than REF_SCAN_RUNS: expected 600 to be less than
  //   or equal to 250
  it("never asks one statement to span more runs than the work bound allows", async () => {
    // Given: a sweep whose claimed page is larger than one enumeration may span
    const asked: string[][] = [];
    const pageRuns = REF_SCAN_RUNS * 2 + 100;
    const store = new OffloadingTrajectoryStore(innerStore(asked), artifacts([]), pageRuns);

    // When: it runs
    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    // The premise FIRST: the page really is bigger than one statement may span, or nothing below can fail.
    expect(pageRuns).toBeGreaterThan(REF_SCAN_RUNS);
    expect(
      EXPIRED_RUNS,
      "the fixture holds fewer runs than the page claims, so the bound is never tested",
    ).toBeGreaterThanOrEqual(pageRuns);

    // Then: every statement is bounded…
    expect(asked.length, "the drain never ran").toBeGreaterThan(0);
    for (const scope of asked)
      expect(scope.length, "one enumeration spanned more runs than REF_SCAN_RUNS").toBeLessThanOrEqual(REF_SCAN_RUNS);
    // …and together they still cover the WHOLE page — a bound that dropped runs would orphan their objects,
    // which is the leak the drain exists to close.
    const covered = new Set(asked.flat());
    expect(covered.size, "the chunks did not cover every run the sweep claimed").toBe(Math.min(pageRuns, EXPIRED_RUNS));
  });

  it("still deletes the bytes of every run in the page before the rows", async () => {
    // Given: the same sweep
    const removed: string[] = [];
    const store = new OffloadingTrajectoryStore(innerStore([]), artifacts(removed), SWEEP_PAGE);

    // When: it runs
    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    // Then: the page's objects went — scoping the enumeration must not narrow what is accounted for, which
    // is the failure mode a "make it cheaper" change has (arch-review 121: the orphan the drain exists for).
    expect(removed).toHaveLength(SWEEP_PAGE);
    expect(removed[0]).toContain(payloadKeyPrefix(TENANT, runIdAt(0)));
    expect(removed[1]).toContain(payloadKeyPrefix(TENANT, runIdAt(1)));
  });

  it("converges: consecutive sweeps take the NEXT page rather than the same one", async () => {
    // Given: a store whose rows actually go away when they are deleted
    const asked: string[][] = [];
    const inner = innerStore(asked);
    const store = new OffloadingTrajectoryStore(inner, artifacts([]), SWEEP_PAGE);

    // When: two sweeps run in a row
    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");
    const before = asked.length;
    await store.deleteOlderThan("2999-01-01T00:00:00.000Z");

    // Then: the second one is working on runs the first one did not — a sweep that re-reads its own page
    // forever never reaches the tail of the corpus. (A drain makes one extra call per page to see the cursor
    // exhausted, so the assertion is over every scope it asked for rather than over their concatenation.)
    const second = asked.slice(before);
    expect(second.length, "the second sweep never drained anything").toBeGreaterThan(0);
    for (const scope of second) expect(scope).toStrictEqual([runIdAt(2), runIdAt(3)]);
  });
});
