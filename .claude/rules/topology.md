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
- Live runtimes: `NomadTopologyRuntime` (discover endpoints via pure `resolvePort`; clean up on
  register-then-fail; namespace-aware queries) and `K8sTopologyRuntime` (apply→rollout→`kubectl port-forward`
  for endpoints, via an injectable `Kubectl` — fake it in tests, never shell out in unit tests). Both are
  drop-in `TopologyRuntime`s; keep them isomorphic so `ServiceTopologyBackend` stays orchestrator-agnostic.
- **Warm pools are NOT shared across tenants** — key the warm pool by `(spec, version, TrustZone.id)` and carry
  the zone in the job ID/namespace. `ensureTopology`/`provisionBrowserEnv` take an optional `TrustZone`.
- **Nomad grouping is decided by ONE predicate, `needsPerServiceGroups`** — branch on it, never re-derive it.
  A homogeneous topology (every service a Linux container with `replicas: 1`) renders ONE co-located group
  (`SERVICE_GROUP_NAME`) on a `bridge` netns: peers talk over `localhost:<svc.port>`, never a dynamic host port, so
  addresses survive a reschedule and ports must be distinct (a collision throws `BadRequestError`). A non-Linux
  `requires.os`, `replicas > 1` or a host-exec service renders one group per service instead (`perServiceGroupName`,
  peers via an injected `EVERDICT_SVC_<PEER>` address). Neither mode wires Connect sidecars. K8s (Service DNS) and
  Docker (one network) do not use this. See `docs/architecture/nomad-colocated-topology.md`.
- Map failures to `AppError`.
