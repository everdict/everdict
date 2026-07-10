// collectDeferredTrace now lives in @everdict/application-control — re-architecture P2 S3 compat
// re-export (removed in the P4 sweep). New code should import @everdict/application-control directly.
export { type CollectTraceDeps, collectDeferredTrace } from "@everdict/application-control";
