---
paths: "packages/topology/**"
---
# Topology rules (push)

Service-topology harnesses (multi-service + a target env). See docs/service-harness.md, skill `topology`.

- `ServiceTopologyBackend` is orchestrator-AGNOSTIC; orchestrator differences live ONLY in `TopologyRuntime`
  (Nomad vs K8s). The builders `buildNomadTopologyJob` / `buildK8sManifests` are pure (deterministic-testable).
- Efficiency: stateless services per-version warm; stores shared + per-case logical isolation
  (`thread_id` / key-prefix / object-prefix); browser per-case. per-run wiring via the front-door, not a redeploy.
- Never hardcode an orchestrator in the backend — add a `TopologyRuntime` impl. Isolation is the runtime's job (runsc/gVisor).
- Live runtime (`NomadTopologyRuntime`): discover endpoints from the alloc via pure `resolvePort` (testable);
  clean up on register-then-fail (no leaked allocs); namespace-aware job/alloc/log queries.
- **Warm pools are NOT shared across tenants** — key the warm pool by `(spec, version, TrustZone.id)` and carry
  the zone in the job ID/namespace. `ensureTopology`/`provisionBrowserEnv` take an optional `TrustZone`.
- Map failures to `AppError`.
