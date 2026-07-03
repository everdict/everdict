// 셀프-호스티드 러너 코어 — lease 루프/회복형 MCP 세션/잡 kind 분기 실행을 CLI·데스크톱이 공유한다.
// 설계: docs/architecture/desktop-app.md (+ self-hosted-runner.md). GUI-무관, 전송 주입식(DI) 유지.
export { resetSharedTopologyRuntime, runLeasedJob, sharedTopologyRuntime } from "./run-leased-job.js";
export { type RunnerLoopDeps, type RunnerLoopOpts, runLeaseWorkers } from "./runner-loop.js";
export {
  type ConnectClient,
  ResilientMcpSession,
  type RunnerClient,
  type ToolResult,
  mcpConnect,
} from "./runner-session.js";
