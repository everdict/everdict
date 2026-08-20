import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── ONE LANE NEVER GOT THE HANDLE AT ALL (arch-review 53, Wave A) ────────────────────────────────────
//
// Wave 2 threaded `onWork` from the backend to the attempt ledger and Wave 2's own tests certify the
// in-process driver does it (`in-process-batch-driver.ts`: `onWork: (work) => void this.commit.stampWork(work)`).
// The DURABLE driver — the one a production batch actually runs under, because Temporal is what survives a
// control-plane restart — passes `onWaiting`, `onStarted` and `onStep` and no `onWork`.
//
// So the lane whose entire justification is "it outlives the process" is the lane that persists nothing to
// address its compute with after the process dies. Every managed case dispatched through a Temporal batch is
// a job whose exact handle exists for the length of one stack frame and is then dropped: cancellation for
// those cases takes the case-id fallback, and boot recovery has no handle to adopt by.
//
// This is asserted against the SOURCE rather than through a dispatch, deliberately. The defect is an absent
// call site — a behavioural test would have to first build a world where the handle would have been used,
// and that world is exactly what does not exist. Wave A replaces the assertion with the real protocol
// (a `DispatchIntent` commit that both drivers must make before submit), and this file's successor asserts
// the commit rather than the callback.

const driverSource = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

// RED as of 186f9fd9: `expected false to be true` — workflow-batch-driver.ts contains onWaiting/onStarted/
// onStep and no onWork.
describe("[R53 WAVE-A COUNTEREXAMPLE #12 — CLOSED] the durable driver persists the handle to its compute", () => {
  it("the Temporal batch lane reports the runtime work it placed, exactly as the in-process lane does", () => {
    const workflow = driverSource("workflow-batch-driver.ts");
    const inProcess = driverSource("in-process-batch-driver.ts");

    // The in-process lane is the reference: it forwards the AUTHORITY (the handle it is about to create, plus
    // the re-presentation of that reservation at the object's birth) and stamps the ledger with it. The two
    // used to be separate optional hooks and this assertion named one of them; merging them is what stopped a
    // lane from supplying half (arch-review 58 W2), and pinning the whole capability is what says so.
    expect(inProcess.includes("authority:")).toBe(true);
    // Reaching the COMMITTER, not merely containing the word: a supplier that answered `{kind:"activate"}`
    // from a literal would satisfy a token search while restoring the very gap it exists to close.
    expect(
      inProcess.includes("this.commit.activateWork("),
      "the reference lane never re-presents its reservation",
    ).toBe(true);

    // The durable lane must do at least as much. A batch that survives a restart is precisely the batch whose
    // handle has to survive it too.
    expect(
      workflow.includes("authority:"),
      "workflow-batch-driver dispatches managed work and records no handle for it",
    ).toBe(true);
    expect(
      workflow.includes("this.commit.activateWork("),
      "workflow-batch-driver creates its container without re-proving the reservation is still live",
    ).toBe(true);
  });
});

// RED as of 186f9fd9: `expected true to be false` — both stamp sites swallow the ledger write.
describe("[R53 WAVE-A COUNTEREXAMPLE #13 — CLOSED] a lost handle is not a successful dispatch", () => {
  it("recording the work an execution placed is not best-effort", () => {
    const committer = driverSource("case-outcome-committer.ts");

    // `recordWork(...).catch(() => {})` makes an unpersisted handle indistinguishable from a persisted one:
    // the dispatch returns success either way, and the only difference shows up later as a cancellation that
    // cannot address the compute it is meant to free.
    expect(
      /recordWork\([^)]*\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/.test(committer),
      "the attempt ledger's work stamp is still swallowed",
    ).toBe(false);
  });
});
