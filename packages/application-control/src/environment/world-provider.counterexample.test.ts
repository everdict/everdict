import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type OpenedWorld, WorldProvidingDispatcher, type WorldSessionProvider } from "./world-provider.js";

// ── [COUNTEREXAMPLE] THE WORLD IS OPENED BEFORE THE ACTOR AND ASKED TO CLOSE AFTER ───────────────────
//
// docs/architecture/world-and-engagement-model.md, axis 1 (provided · session). Four things this seam must
// get right, and each of them fails silently if it does not:
//   ① a world that could not be opened REFUSES the case. Dispatching anyway runs the agent against whatever
//      default its own spec carries and reports the number as if nothing had changed.
//   ② the coordinates reach the job; the ACQUIRE SPEC does not. A runner receiving it holds the means of
//      minting more sessions in a service it was never meant to talk to.
//   ③ the close is asked for even when the case FAILED — a leaked world outlives the run that opened it.
//   ④ a close that did not happen is REPORTED. Swallowing it is how a session service quietly fills up.
const job = (over: Partial<CaseJob["evalCase"]> = {}): CaseJob =>
  ({
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "prompt" },
      graders: [],
      timeoutSec: 60,
      world: {
        wiring: { keep_me: "yes" },
        session: {
          endpoint: "https://sessions.internal",
          acquire: { open: "POST /s", coordinates: { target_base_url: "url" } },
        },
      },
      ...over,
    },
    harness: { id: "cli", version: "1" },
    runId: "run-1",
  }) as unknown as CaseJob;

const result = (caseId: string): CaseResult =>
  ({ caseId, harness: "cli@1", trace: [], snapshot: { kind: "prompt", output: "" }, scores: [] }) as CaseResult;

function provider(over: Partial<OpenedWorld> = {}, opens: CaseJob[] = []): WorldSessionProvider {
  return {
    open: async () => ({
      wiring: { target_base_url: "https://session-42.internal" },
      release: async () => ({ kind: "closed" as const }),
      ...over,
      ...(opens.length >= 0 ? {} : {}),
    }),
  };
}

describe("[COUNTEREXAMPLE] a session-provided world is opened, handed over, and asked to close", () => {
  it("hands the case the coordinates and never the acquire spec", async () => {
    const seen: CaseJob[] = [];
    const released: unknown[] = [];
    const d = new WorldProvidingDispatcher(
      provider(),
      {
        dispatch: async (j) => {
          seen.push(j);
          return result(j.evalCase.id);
        },
      },
      (o) => released.push(o),
    );
    await d.dispatch(job());
    const world = seen[0]?.evalCase.world;
    expect(world?.wiring).toEqual({ keep_me: "yes", target_base_url: "https://session-42.internal" });
    expect(world?.session, "the means of minting sessions must not cross the process boundary").toBeUndefined();
    expect(released).toEqual([{ caseId: "c1", endpoint: "https://sessions.internal", result: { kind: "closed" } }]);
  });

  it("refuses the case when the world cannot be opened — it does not run it worldless", async () => {
    let dispatched = 0;
    const d = new WorldProvidingDispatcher(
      {
        open: async () => {
          throw new Error("the session pool is full");
        },
      },
      {
        dispatch: async (j) => {
          dispatched += 1;
          return result(j.evalCase.id);
        },
      },
      () => {},
    );
    await expect(d.dispatch(job())).rejects.toThrow(/session pool is full/);
    expect(dispatched).toBe(0);
  });

  it("asks for the close even when the case FAILED, and reports a close that did not happen", async () => {
    const released: Array<{ result: { kind: string } }> = [];
    const d = new WorldProvidingDispatcher(
      provider({ release: async () => ({ kind: "not_closed", reason: "503 from the session service" }) }),
      {
        dispatch: async () => {
          throw new Error("the harness exploded");
        },
      },
      (o) => released.push(o),
    );
    await expect(d.dispatch(job())).rejects.toThrow(/harness exploded/);
    expect(released[0]?.result).toEqual({ kind: "not_closed", reason: "503 from the session service" });
  });

  it("leaves a case with no session-provided world completely alone", async () => {
    const seen: CaseJob[] = [];
    const d = new WorldProvidingDispatcher(
      {
        open: async () => {
          throw new Error("nothing to open");
        },
      },
      {
        dispatch: async (j) => {
          seen.push(j);
          return result(j.evalCase.id);
        },
      },
      () => {},
    );
    await d.dispatch(job({ world: { wiring: { target_base_url: "https://hosted" } } } as never));
    expect(seen[0]?.evalCase.world).toEqual({ wiring: { target_base_url: "https://hosted" } });
  });
});
