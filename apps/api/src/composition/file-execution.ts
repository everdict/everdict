import { FileExecutionService, type WorkspaceFs } from "@everdict/application-control";
import { DockerDriver } from "@everdict/drivers";

// "Run this file" is OPT-IN infrastructure, not a default capability. The service exists only where the control
// plane can reach a container runtime (`EVERDICT_FILE_EXECUTION_DRIVER=docker`, which needs the docker socket
// mounted into the api container — see deploy/compose/docker-compose.full.yaml). Everywhere else the route and
// the run_file tool are simply absent.
//
// There is deliberately NO local-process option. LocalDriver is for code already inside a sandbox (the agent, the
// job runner); the control plane is not one, and "run the member's script in the API process" is the kind of
// fallback that is convenient exactly once.
export function buildFileExecutionService(fs: WorkspaceFs): FileExecutionService | undefined {
  const driver = process.env.EVERDICT_FILE_EXECUTION_DRIVER;
  if (driver === undefined || driver === "") return undefined;
  if (driver !== "docker") {
    console.warn(`▶ file execution: ignoring EVERDICT_FILE_EXECUTION_DRIVER='${driver}' (only 'docker' is supported)`);
    return undefined;
  }
  console.log("▶ file execution: docker (POST /fs/executions + run_file)");
  return new FileExecutionService(fs, new DockerDriver());
}
