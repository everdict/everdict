// The per-runtime circuit breaker now lives in @everdict/domain — re-architecture P1d compat
// re-export (removed in the P4 sweep). New code should import @everdict/domain directly.
export { CircuitBreaker, type CircuitBreakerOpts } from "@everdict/domain";
