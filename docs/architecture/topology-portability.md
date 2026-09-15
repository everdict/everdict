---
kind: wiki
title: "Topology portability — one HarnessSpec, identical semantics on every runtime"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/harness/portability.ts, packages/topology/src/deploy/peer-resolver.ts, packages/topology/src/deploy/reachability.ts]
---
# Topology portability — one HarnessSpec, identical semantics on every runtime

> **Requirement (not best-effort).** A `HarnessSpec(kind:"service")` that runs on ONE runtime MUST run
> identically on EVERY runtime — self-hosted Docker · Nomad (co-located) · Nomad (per-service) · K8s.
> A spec that *would* behave differently across runtimes MUST be rejected at **authoring time**, never
> discovered as a late, opaque run failure. Portability is enforced, not documented-and-hoped.

## 1. Why it is hard — the same spec, four network realizations

A service topology is deployed by one of four paths, and each maps a *logical* reference (a peer, the front
door, a store) to a *different physical* address:

| logical reference | Docker (self-hosted) | Nomad (co-located) | Nomad (per-service) | K8s |
|---|---|---|---|---|
| **peer service** | network alias `svc.name` | loopback (`extra_hosts` `svc.name→127.0.0.1`, shared netns) | dynamic host port, consul-template from the native catalog | Service DNS `${id}-${svc.name}` |
| **front-door base** | `http://127.0.0.1:<published>` | `http://<allocHostIP>:<dyn>` | `http://<allocHostIP>:<dyn>` | `http://127.0.0.1:<port-forward>` |
| **store** | alias `<id>-<store>:<port>` | discovered `hostIP:port` | discovered `hostIP:port` | Service DNS `<id>-<store>:<port>` |

The framework already normalizes logical→physical per backend behind one seam — the `hostFor` callback of
`staticWiringEnv`/`interpolateServiceEnv` (`packages/topology/src/deploy/nomad-topology.ts`) and
`topo.endpoints` from `TopologyRuntime.ensureTopology`. **The framework's own resolution is consistent.** The
portability risk is therefore entirely **spec-level**: an author can *bypass* the seam by hardcoding a physical
address, and a hardcoded address only matches ONE backend.

### The one safe form vs. the footguns

- **`{{peer}}` / `{{peer.host}}` / `{{peer.port}}` / `{{peer.url}}` — PORTABLE.** `interpolatePeerTokens`
  (`nomad-topology.ts`) renders the per-backend host AND fail-fasts: a peer not in `needs` or a peer with no
  `port` throws `BadRequestError`. Correct on all four paths.
- **A literal `<other-svc>:<port>` / `localhost:<port>` / IP — NON-PORTABLE.** `PEER_TOKEN_RE` only matches
  `{{…}}`, so a literal is *not recognized as a peer reference* → it skips the `needs`/`port` checks AND gets
  no discovery template. It resolves only where a shared network happens to make the raw name/loopback work:

| author writes… | Docker | co-located Nomad | per-service Nomad | K8s |
|---|:---:|:---:|:---:|:---:|
| `{{peer}}` | ✅ | ✅ | ✅ | ✅ |
| literal `svc:port` | ✅ (alias) | ✅ (extra_hosts) | ❌ no discovery | ❌ real DNS is `${id}-svc` |
| literal `localhost:port` | ✅ | ✅ (shared netns) | ❌ | ❌ (localhost = own pod) |

The comment `nomad-topology.ts` — *"Literal localhost:<port> works regardless"* — is true **only** inside a
shared netns; read as universal it is the footgun. This is exactly the "works on the self-hosted runner, fails
on Nomad/K8s" class the requirement forbids.

External touchpoints have the same rule: the front door is reached via `topo.endpoints[frontDoor.service]`
(`service-backend.ts`) — a *service reference*, resolved per backend. A spec that instead hardcodes a
front-door/target/store URL pins itself to one runtime.

## 2. The network contract (what an author may and may not write)

1. **Address a peer ONLY with `{{peer}}` tokens.** Never a literal service name+port, never `localhost`/`127.0.0.1`/an IP.
2. **Every peer reference is backed by a `needs` edge; every addressed service declares a `port`.** (Already enforced for `{{peer}}`; L1 extends the net to catch the literal escapes.)
3. **External touchpoints are references, not addresses.** Front door = `frontDoor.service`; stores = `dependencies[]`; a service target = `target.acquire.service`. Physical addresses are **runtime-injected** (`connEnv`/`storeEnv`/`wiring`) — never authored.
4. **No ambient assumptions** about co-location, specific port numbers, DNS suffixes, or that the driver and the topology share a host beyond what the runtime guarantees.

Everything the contract forbids is a construct that only resolves on a subset of backends. Everything it
requires routes through the one per-backend seam that IS portable.

## 3. Defense-in-depth — four enforcement layers

| layer | when | guarantee |
|---|---|---|
| **L0 Contract** (this doc + `topology` skill) | authoring | the law authors and reviewers follow |
| **L1 Static portability lint** (`/harnesses/validate`, `/harness-templates/validate` + register) | authoring | a spec with a structural defect **cannot register** |
| **L2 Single resolution authority** (`peer-resolver.ts`) | build | peer-host resolution lives in ONE audited file |
| **L3 Cross-runtime conformance** (`topology-conformance.test.ts`) | test | a golden spec renders each backend's correct peer address |
| **L4 Reachability preflight** | per-run | an unroutable endpoint fails fast with one per-runtime message |

L1 prevents, L2 shrinks the divergence surface, L3 proves, L4 catches. No single layer is trusted alone.

### L1 — static portability lint (the highest-leverage layer)

A pure `checkPortability(spec): PortabilityIssue[]` in `@everdict/domain`
(`packages/domain/src/harness/portability.ts`), each issue carrying a **severity** and the exact field. Enforcement
is `assertPortable` at registration (the harness-instance registry's `register`, which the HTTP route, bundle
`apply` and MCP all reach), so a new version with a structural defect never lands; dispatch is untouched, so
existing versions are grandfathered. `POST /harnesses/validate` and `POST /harness-templates/validate` surface the
issues before submit.

**Severity — block new, warn existing:**
- **`error` → hard-block** (`BadRequestError`). The structural rules — they resolve differently, or not at all, on
  another runtime with no legitimate exception.
- **`warning` → surfaced, not blocked**, returned as `portabilityWarnings` on register/validate. Often an intentional
  self-hosted-only choice, or an inert declaration rather than a divergent one.

| rule | severity | detects |
|---|---|---|
| **peer-by-literal** | error | a declared peer addressed by its literal `<name>:<port>` — no discovery on per-service Nomad, wrong DNS on K8s; use `{{peer}}` |
| **needs-complete** | error | a peer referenced but not declared in `needs` — per-service Nomad wires only `needs` |
| **addressed-has-port** | error | an addressed peer / front-door / target service with no `port` |
| **reference-not-address** | error | a front-door / target reference to a service that is not declared |
| **unique-ports** | error | two services sharing a `port` — the co-located Nomad netns forbids it |
| **no-literal-host** | warning | `localhost` / `127.0.0.1` / private IP / docker host-gateway in an address |
| **store-by-literal** | warning | a bare container/store DNS `host:port` in service env — resolves only under Docker |
| **inject-shadowed-literal** | warning | a `service.env` literal under a key a dependency `inject` also sets — the literal is dead |
| **artifact-store-internal** | warning | an in-topology object store whose artifact URLs will not reach the judge |
| **profile-uninjectable** | warning | a saved browser profile on a target whose browser the control plane cannot reach |
| **host-program-undelivered** | warning | a host-exec service with no `exec.artifact` — the program is assumed pre-installed |
| **context-id-unread** | warning | `frontDoor.contextId` declared while the trace source does not correlate by tag |

`no-literal-host` has not been promoted to an error: some example bundles (`examples/bundles/browser-use/bundle.json`)
still carry host literals.

### L2 — single resolution authority (`peer-resolver`)

The load-bearing divergence is **peer-host** resolution (a `needs` service → its physical build-time host). It is
now centralized in `packages/topology/src/deploy/peer-resolver.ts` as named strategies — `aliasPeerHost` (docker
network alias + co-located Nomad loopback name) and `k8sPeerHost(id)` (`<id>-<service>` Service DNS) — that the
call sites (`docker-runtime`, `nomad-topology`, `k8s-topology`) pass into the already-parameterized
`staticWiringEnv` / `interpolateServiceEnv`. So the whole cross-runtime divergence for peer addressing is auditable
in **one file**, and `peer-resolver.test.ts` **locks each form** (same wiring spec → each backend's correct URL
through one seam) so a change to any resolver is caught. Per-service Nomad resolves at RUNTIME via a
consul-template render (a different mechanism, staying in `nomad-topology`'s `peerTemplateEnv`).

The other two addresses are **runtime-discovered**, not build-time computable, so they are not part of this pure
resolver: the **front-door base** (`topo.endpoints[service]`) and **store host:port** (store `connEnv`) are produced
by each runtime's `ensureTopology` (docker published port / Nomad alloc host:port / K8s port-forward) and already
flow through one channel (`topo.endpoints` / `storeEnv`).

### L3 — cross-runtime conformance

`topology-conformance.test.ts` pushes a golden canary through the pure builders and asserts each backend's correct
peer host — Nomad plain alias vs K8s `<id>-<service>` DNS, via `wiring` AND `{{peer}}`. It proves the rendered
addresses, not a live bring-up: there is no env-gated scenario that deploys one canary on every backend and compares
the `CaseResult`. The live scripts that exist exercise one backend each (`scripts/live/service-topology-nomad.mjs`,
`scripts/live/service-topology-k8s.mjs`, `scripts/live/self-hosted-service-runner.mjs`).

### L4 — reachability preflight

Each runtime's readiness poll during `ensureTopology` checks the resolved endpoint before it enters
`topo.endpoints`, so readiness polling is the control-plane-side reachability check. All three runtimes throw one
shared `endpointUnreachableError(url)` (`packages/topology/src/deploy/reachability.ts`) — "the control plane cannot
reach it on this runtime" — instead of a bare "not ready"; `service-backend` additionally guards front-door presence.

Not built:
- **Cross-runtime smoke parity** — running the single-case smoke on the actual target runtime and diffing a canary
  bring-up on a second backend. "Passed on self-hosted" must still not be read as "passes on Nomad".
- **A Nomad host-IP guard** — `resolvePort` (`nomad-topology.ts`) still falls back to `127.0.0.1` when an alloc
  reports an empty `HostIP`, which silently masks the real address on a multi-node cluster.

## See also
`docs/service-harness.md` · `docs/architecture/nomad-colocated-topology.md` ·
`docs/architecture/front-door-generalization.md` · `docs/architecture/target-acquisition-generalization.md` ·
`docs/architecture/heterogeneous-topology-placement.md` · skill `topology`.
