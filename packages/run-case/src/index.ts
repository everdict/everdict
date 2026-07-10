// The eval loop now lives in @everdict/application-execution — re-architecture P2a compat re-export
// (removed in the P4 sweep). New code should import @everdict/application-execution directly.
export { runCase, type RunCaseDeps } from "@everdict/application-execution";
