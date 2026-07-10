// @everdict/application-execution — L2a, the agent-safe execution use-cases (re-architecture P2,
// docs/architecture/rearchitecture/00-target-architecture.md). One eval loop for every runner of a
// case: the control-plane backends, the dispatched agent, the self-hosted runner, and the CLI all
// compose THIS. Imports contracts + domain only (cone-enforced); adapters (drivers/harnesses/
// graders/environments) arrive via RunCaseDeps injection.
export { runCase, type RunCaseDeps } from "./run-case.js";
export { safeGrade } from "./safe-grade.js";
