import type { RunRecord } from "@everdict/contracts";
import { type RunTransition, assertRunNotTerminal, terminalRunFacts } from "./run.js";

// COMMAND-run policy (review §19): a command run settles on HAVING RUN — not on the command agreeing with
// us. A non-zero exit is the script's own answer (the standing rule everywhere this surface is described),
// so the row succeeds and KEEPS the code; `failed` stays reserved for "we could not run it at all" — no
// interpreter for the extension, a sandbox that never came up. Conflating the two would make every failing
// test script look like broken infrastructure.
export function settleCommandTransition(
  record: RunRecord,
  outcome: { exitCode: number; files?: string[] },
  now: string,
): RunTransition {
  assertRunNotTerminal(record, "settleCommand");
  return {
    patch: {
      status: "succeeded",
      outputs: {
        exitCode: outcome.exitCode,
        ...(outcome.files !== undefined && outcome.files.length > 0 ? { files: outcome.files } : {}),
      },
      updatedAt: now,
    },
    facts: terminalRunFacts(record, "succeeded"),
  };
}
