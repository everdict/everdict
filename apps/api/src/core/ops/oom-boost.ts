// The OOM auto-boost now lives in @everdict/application-control — re-architecture P2 S4 compat
// re-export (removed in the P4 sweep). New code should import @everdict/application-control directly.
export { OOM_ESCALATION_CAP_MB, type OomBoostOpts, executeWithOomBoost } from "@everdict/application-control";
