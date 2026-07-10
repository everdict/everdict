// The scheduling knobs now live in @everdict/application-control — re-architecture P2 S4 compat
// re-export (removed in the P4 sweep). New code should import @everdict/application-control directly.
export {
  type AutoscaleConfig,
  parseAutoscale,
  parseTenantMap,
  type TenantValueMap,
} from "@everdict/application-control";
