import { BadRequestError, type EvaluableHarness, type HarnessSpec } from "@everdict/contracts";
import { ClaudeCodeHarness, CommandHarness, ScriptedHarness } from "@everdict/harnesses";

// The grader spec→instance mapping is owned by @everdict/graders (re-exported here).
// makeGradersFromEnv: also includes the judge grader (injects the Judge from env; if unconfigured, only judge is skipped). Used on the dispatch path.
export { makeGraders, makeGradersFromEnv } from "@everdict/graders";

// id → harness. When a declarative command spec arrives (resolved from the registry and embedded by the
// control plane), interpret it as a generic CommandHarness — a SaaS user can register a CLI agent with no
// code adapter. Built-ins (claude-code/scripted) branch on id (preinstalled in the agent image).
export interface MakeHarnessOptions {
  meterUsage?: boolean; // Meter the command harness's model calls via a usage-proxy (only active when trace:none)
}

export function makeHarness(
  id: string,
  version: string,
  spec?: HarnessSpec,
  opts: MakeHarnessOptions = {},
): EvaluableHarness {
  if (spec?.kind === "command") return new CommandHarness(spec, { meterUsage: opts.meterUsage });
  switch (id) {
    case "claude-code":
      return new ClaudeCodeHarness(version, { install: false });
    case "scripted":
      return new ScriptedHarness(version, () => [{ tool: "bash", cmd: "echo hello > out.txt" }]);
    default:
      throw new BadRequestError("BAD_REQUEST", { harness: id });
  }
}
