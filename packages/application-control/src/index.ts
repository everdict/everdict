// @everdict/application-control — L2b, the control-plane use-cases + ports (re-architecture P2,
// docs/architecture/rearchitecture/00-target-architecture.md). Batch driving, store/dispatch ports,
// and (incrementally) the api services move here; composition roots (apps/*) bind the adapters.
// Imports contracts + domain only. NEVER enters the agent cone (control-plane side).
export { type Dispatch, runSuite } from "./run-suite.js";
