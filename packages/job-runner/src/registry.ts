import { BadRequestError, type EvaluableHarness, type HarnessSpec } from "@everdict/contracts";
import { ClaudeCodeHarness, CommandHarness, ScriptedHarness } from "@everdict/harnesses";

// The grader spec→instance mapping is owned by @everdict/graders (re-exported here).
// makeGradersFromEnv: also includes the judge grader (injects the Judge from env; if unconfigured, only judge is skipped). Used on the dispatch path.
export { makeGraders, makeGradersFromEnv } from "@everdict/graders";

// id → harness. When a declarative command spec arrives (resolved from the registry and embedded by the
// control plane), interpret it as a generic CommandHarness — a SaaS user can register a CLI agent with no
// code adapter. Built-ins (claude-code/scripted) branch on id (preinstalled in the job-runner image).
export interface MakeHarnessOptions {
  meterUsage?: boolean; // Meter the command harness's model calls via a usage-proxy (only active when trace:none)
  // A driver-lane sandbox session (the harness playground) boots a bare environment image with no
  // preinstalled CLI — built-ins must install themselves there. The job-runner image path keeps install:false.
  sandboxInstall?: boolean;
  // The ENVIRONMENT a delegation profile pins for a built-in adapter (docs/architecture/capability-store.md):
  // resolved env (profile literals + {secretRef} values + the model connection) and the working directory the
  // conversation lives in. A process harness's own spec is {kind,id,version} and can carry none of this, so
  // this factory is where a registered environment reaches the adapter — without it, every knob a profile
  // pins would be discarded right here.
  env?: Record<string, string>;
  workDir?: string;
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
      return new ClaudeCodeHarness(version, {
        install: opts.sandboxInstall === true,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
      });
    case "scripted":
      return new ScriptedHarness(version, () => [{ tool: "bash", cmd: "echo hello > out.txt" }]);
    default:
      throw new BadRequestError("BAD_REQUEST", { harness: id });
  }
}
