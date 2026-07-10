// The batch driver now lives in @everdict/application-control — re-architecture P2c compat
// re-export (removed in the P4 sweep). New code should import @everdict/application-control directly.
export { type Dispatch, runSuite } from "@everdict/application-control";
