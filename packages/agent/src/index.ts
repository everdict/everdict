export { runAgentJob } from "./run.js";
export { makeHarness, makeGraders, makeGradersFromEnv } from "./registry.js";
export { runContextFromEnv, collectAuthEnv, hasClaudeAuth } from "./env.js";
export type { DriverMount } from "@everdict/drivers"; // Host-mount type the runner passes when containerizing (re-export — runner-core uses it without a new dep)
export { pullWithRegistryAuth } from "@everdict/drivers"; // Workspace-registry authenticated pull (re-export — for pre-pull on the runner's service path)
