// Self-hosted runner core — the lease loop / resilient MCP session / job-kind-branched execution shared by CLI and desktop.
// Design: docs/architecture/desktop-app.md (+ self-hosted-runner.md). GUI-agnostic, kept transport-injectable (DI).
export { detectCapabilities, probeDocker } from "./capabilities.js";
export { resetSharedTopologyRuntime, runLeasedJob, sharedTopologyRuntime } from "./run-leased-job.js";
export {
  RunnerHost,
  type RunnerHostOpts,
  type RunnerHostState,
  type RunnerHostStatus,
  type RunnerJobDone,
} from "./runner-host.js";
export { type RunnerLoopDeps, type RunnerLoopOpts, runLeaseWorkers } from "./runner-loop.js";
export { type SuperviseOpts, superviseLease } from "./runner-supervisor.js";
export {
  type ConnectClient,
  ResilientMcpSession,
  type RunnerClient,
  type ToolResult,
  mcpConnect,
} from "./runner-session.js";
