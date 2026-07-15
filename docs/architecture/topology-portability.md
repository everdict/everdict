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
| **L1 Static portability lint** (`/harnesses/validate` + register) | authoring | a non-portable spec **cannot register** |
| **L2 Single resolution authority** (`AddressResolver`) | build | logical→physical lives in ONE audited seam per backend |
| **L3 Cross-runtime conformance suite** | CI / scenario | a golden spec is **proven** identical on every backend |
| **L4 Reachability preflight + cross-runtime smoke parity** | per-run | an escape fails fast with a precise, per-runtime message |

L1 prevents, L2 shrinks the divergence surface, L3 proves, L4 catches. No single layer is trusted alone —
that is what "굉장히 견고 / very robust" means here.

### L1 — static portability lint (the highest-leverage layer)

A pure `checkPortability(spec): PortabilityIssue[]` in `@everdict/domain`
(`packages/domain/src/harness/portability.ts`), each issue carrying a **severity**. Enforcement lives at the
**registry `register`** — the single chokepoint every path (HTTP route, bundle `apply`, MCP) flows through — via
`assertPortable(resolved)`, so a non-portable spec never lands, uniformly, and only at registration (dispatch is
untouched → existing versions are grandfathered). `POST /harnesses/validate` surfaces the issues before submit.

**Severity (SHIPPED S1 — `block new, warn existing`):**
- **`error` → hard-block.** The *structural* rules (`peer-by-literal`, `needs-complete`, `addressed-has-port`,
  `reference-not-address`, `unique-ports`) — a peer addressed by its literal name, a missing `needs` edge, a
  duplicate port, a dangling reference. These resolve differently (or not at all) on another runtime with **no
  legitimate exception**, so a new registration is rejected (`BadRequestError`; existing versions grandfathered).
- **`warning` → surfaced, not blocked.** `no-literal-host` (loopback / private-IP / docker host-gateway) — often
  an *intentional* self-hosted-only choice, and its fix (declare a dependency, use a model binding) is a
  migration. Returned as `portabilityWarnings` on register/validate (like `imageWarnings`); migrated in **S2**.

Each issue names the exact field. The shipped example bundles (langgraph / browser-use / bu) trip only
`no-literal-host` (0 structural), so they still register/apply with a warning.

| rule | detects | why it breaks | anchor to make portable |
|---|---|---|---|
| **no-literal-host** | `localhost`/`127.0.0.1`/`0.0.0.0`/private-IP in any `service.env`, `frontDoor.request.bodyTemplate`, `target`/`acquire` template | resolves to self on separate-pod/alloc backends | use `{{peer}}` / a store `connEnv` var |
| **peer-by-token** | a literal `<name>:<port>` where `<name>` is a declared service | no discovery on per-service Nomad; wrong DNS on K8s | replace with `{{peer}}` (routes into the `needs`/`port` check) |
| **needs-complete** | a `{{peer}}`/reference to a service not in `needs` | per-service Nomad wires only `needs` | add the `needs` edge (already thrown at deploy — L1 moves it to submit) |
| **addressed-has-port** | a peer/front-door/target service with no `port` | nothing to publish/forward | declare `port` |
| **reference-not-address** | front-door/target/store given a raw URL instead of a declared service/dependency | pins to one backend's addressing | reference the service/dependency by name |
| **unique-ports** (co-located) | two services share a `port` | shared netns port collision (already thrown by the Nomad builder) | give distinct ports |

The lint is the L0-lint rung of the validation ladder (`docs/architecture/` — harness smoke/validation): it is
pure, cheap, and runs before any bytes are pulled.

### L2 — single resolution authority (`peer-resolver`) — SHIPPED (S3)

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
flow through one channel (`topo.endpoints` / `storeEnv`). No behavior change — the resolvers emit byte-identical
strings to the former inline lambdas; the deterministic builder tests are the net (217 topology tests green).

### L3 — cross-runtime conformance suite (the proof)

A **golden canary** `HarnessSpec` that exercises every portable construct — two services with a `needs` +
`{{peer}}` edge, a shared store, a front door with a `bodyTemplate`, a target, a trace source — is deployed on
**each** backend (env-gated `*.scenario.test.ts` + `scripts/live/topology-portability-<backend>.mjs`, per the
`testing` skill) and asserted to yield **identical observable behavior**: same `CaseResult` verdict, same
normalized trace shape, same grader outcome. This is the automated guarantee that "one definition runs
identically everywhere"; it fails CI the moment a backend diverges. Docker + Nomad + K8s all have live
scenario harnesses already (`scripts/live/service-topology-{nomad,k8s}.mjs`) to extend.

### L4 — reachability preflight + cross-runtime smoke parity (per-run backstop)

- **Bring-up reachability preflight — SHIPPED.** Each runtime's `waitForHttp` already polls the resolved endpoint
  during `ensureTopology` before it is added to `topo.endpoints`, so readiness polling *is* the control-plane-side
  reachability check. The three copies now throw ONE shared `endpointUnreachableError(url)`
  (`reachability.ts`) — "the control plane cannot reach it on this runtime" — so an unroutable address fails the
  same, clear way everywhere instead of a bare "not ready". (`service-backend` additionally guards front-door
  presence.) Remaining: **cross-runtime smoke parity** (run the single-case smoke on the ACTUAL target runtime +
  a canary-diff mode — needs the smoke-run affordance) and the **Nomad hostIP `127.0.0.1` fallback guard** (warn
  when a multi-node alloc reports no routable host).
- **Cross-runtime smoke parity:** the single-case smoke run (validation ladder L2) runs on the **actual target
  runtime**, and a "portability check" mode brings the canary up on a second backend and diffs bring-up +
  reachability. "Passed on self-hosted" must never be read as "passes on Nomad."
- **Nomad hostIP fallback:** the `HostIP===""` → `127.0.0.1` fallback (`nomad-topology.ts` `resolvePort`)
  silently masks the real address on a multi-node cluster — warn (or fail-fast when the cluster spans nodes).

## 4. Slice plan

1. **S1 — portability lint (L1).** `checkPortability` + wire into `/harnesses/validate` and register/resolve; web surfaces issues inline (the delivery-mode badge is the precedent). *Biggest leverage, cheapest, no runtime.*
2. **S2 — `{{peer}}` canonicalization + migration (L0/L1).** Literal inter-service/`localhost`/IP → hard error; migrate the example bundles + any registered specs off hardcodes (now that `e6c76c5` makes `{{peer}}` work on all four paths).
3. **S3 — peer-resolver centralization (L2) — SHIPPED.** The four inline `hostFor` lambdas → named strategies in `peer-resolver.ts` + a parity test that locks each backend's peer-host form; no behavior change (217 topology tests green).
4. **S4 — conformance suite (L3) — deterministic slice SHIPPED.** A golden canary through the pure builders asserts each backend's correct peer host (`topology-conformance.test.ts`: Nomad plain alias vs K8s `<id>-<service>` DNS, via wiring AND `{{peer}}`). Follow-up: the env-gated live 3-backend scenario (real bring-up + identical `CaseResult`).
5. **S5 — reachability preflight (L4) — SHIPPED.** The runtimes' readiness poll is the reachability check; unified into one `endpointUnreachableError` for a clear, consistent "cannot reach it on this runtime". Follow-up: cross-runtime smoke-on-target + the Nomad hostIP-fallback guard.

S1+S2 alone close the reported failure mode at authoring time; S3–S5 make it *provably* robust and keep it
that way.

## See also
`docs/service-harness.md` · `docs/architecture/nomad-colocated-topology.md` ·
`docs/architecture/front-door-generalization.md` · `docs/architecture/target-acquisition-generalization.md` ·
`docs/architecture/heterogeneous-topology-placement.md` · skill `topology`.
