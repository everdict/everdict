import { BadRequestError } from "@everdict/contracts";

// THE deployment's compute — the container runtime this control plane can HOLD OPEN, read once.
//
// Three lanes need exactly this and each used to ask for it separately: agent worlds and the harness playground
// (`EVERDICT_SANDBOX_DRIVER`), running one workspace file (`EVERDICT_FILE_EXECUTION_DRIVER`), and — through a
// different door entirely — interactive browser sessions. Same question, three answers, no check that they
// agreed; a deployment could sincerely believe it had configured "where things run" and have configured half.
//
// `EVERDICT_COMPUTE` is that one answer. The per-lane names survive as aliases (and still act as the lane's
// on-switch, so enabling one lane never silently enables another), but they cannot DISAGREE about the kind —
// that is a boot failure, like an unrecognized trust-zone mode. An unknown kind is also a boot failure: it used
// to warn and quietly disable the feature the operator had just asked for.
export type ComputeKind = "docker" | "nomad";

export interface DeploymentCompute {
  kind: ComputeKind;
  sandboxes: boolean; // agent worlds + the harness playground
  fileRuns: boolean; // "Run" in the file viewer
}

const LANES = {
  sandboxes: "EVERDICT_SANDBOX_DRIVER",
  fileRuns: "EVERDICT_FILE_EXECUTION_DRIVER",
} as const;

function kindOf(name: string, raw: string): ComputeKind {
  if (raw === "docker" || raw === "nomad") return raw;
  throw new BadRequestError(
    "BAD_REQUEST",
    { [name]: raw },
    `${name}='${raw}' is not a compute kind — expected 'docker' or 'nomad'.`,
  );
}

export function deploymentCompute(env: NodeJS.ProcessEnv = process.env): DeploymentCompute | undefined {
  const declared: Array<[string, ComputeKind]> = [];
  for (const name of ["EVERDICT_COMPUTE", LANES.sandboxes, LANES.fileRuns]) {
    const raw = env[name]?.trim();
    if (raw) declared.push([name, kindOf(name, raw)]);
  }
  const first = declared[0];
  if (!first) return undefined;
  const disagreeing = declared.find(([, kind]) => kind !== first[1]);
  if (disagreeing)
    throw new BadRequestError(
      "BAD_REQUEST",
      Object.fromEntries(declared),
      `${first[0]} and ${disagreeing[0]} name different compute kinds — this deployment has one place to run things. Set one.`,
    );
  const everywhere = env.EVERDICT_COMPUTE?.trim() !== undefined && env.EVERDICT_COMPUTE?.trim() !== "";
  return {
    kind: first[1],
    sandboxes: everywhere || Boolean(env[LANES.sandboxes]?.trim()),
    fileRuns: everywhere || Boolean(env[LANES.fileRuns]?.trim()),
  };
}
