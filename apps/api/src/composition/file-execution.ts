import { FileExecutionService, type WorkspaceFs } from "@everdict/application-control";
import type { RuntimeCompute } from "../common/runtime-compute.js";
import type { DeploymentCompute } from "./compute-env.js";

// "Run this file" is OPT-IN infrastructure, not a default capability: the lane exists only where the operator
// said so (`EVERDICT_FILE_EXECUTION_DRIVER`, or the deployment-wide `EVERDICT_COMPUTE`). Everywhere else the
// route and the run_file tool are simply absent.
//
// WHERE it runs is no longer this lane's own question. It takes the shared resolver (composition/runtime-compute),
// so a member can place the run on one of the workspace's registered runtimes — on their own cluster, inside
// that tenant's trust zone — and the deployment's own compute is just the default. Which also means a control
// plane with no docker socket can still offer "Run": it has runtimes.
//
// There is deliberately NO local-process option. LocalDriver is for code already inside a sandbox (the agent, the
// job runner); the control plane is not one, and "run the member's script in the API process" is the kind of
// fallback that is convenient exactly once.
export function buildFileExecutionService(
  fs: WorkspaceFs,
  compute: RuntimeCompute,
  deployment: DeploymentCompute | undefined,
): FileExecutionService | undefined {
  if (!deployment?.fileRuns) return undefined;
  const own = compute.defaultCompute;
  console.log(`▶ file execution: ${own?.id ?? "runtime-only"} (POST /fs/executions + run_file)`);
  return new FileExecutionService(fs, own, (tenant, runtime) => compute.computeFor(tenant, runtime));
}
