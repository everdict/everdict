import { z } from "zod";

// Trace source — evaluation pulls the trace the harness/runtime exported to its observability platform. 5 kinds at
// parity with CommandTraceSpec + the workspace trace-source registry (real agents export to Langfuse/LangSmith/Phoenix,
// not just OTel/MLflow). authSecret = a SecretStore name (resolved to the verbatim auth-header value at dispatch — never
// plaintext in the spec). correlate = how this run's trace is found: id (runId IS the trace id) | tag (search the
// everdict.run_id the deployed agent tagged). service = otel/jaeger tag-search scope; project = mlflow experiment /
// phoenix project. Design: docs/service-harness.md + docs/architecture/suna-harness-gaps.md (G1).
export const TraceSourceSpecSchema = z.object({
  kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
  endpoint: z.string(),
  authSecret: z.string().optional(),
  correlate: z.enum(["id", "tag"]).optional(),
  service: z.string().optional(),
  project: z.string().optional(),
});
export type TraceSourceSpec = z.infer<typeof TraceSourceSpecSchema>;

// env value — a literal string or a secret reference ({ secretRef }). If a reference, no plaintext stays in the spec (registry),
// and the control plane injects the value from SecretStore just before execution (resolveHarnessSecrets). Consumption points stringify via flattenEnv.
// scope = which secret tier it points to. "workspace" (default) = shared secret, "user" = the submitter's personal secret.
// A harness that references a user secret can only be run/viewed by that user (referencesUserSecret → private).
export const EnvValueSchema = z.union([
  z.string(),
  z.object({ secretRef: z.string().min(1), scope: z.enum(["user", "workspace"]).optional() }).strict(),
]);
export type EnvValue = z.infer<typeof EnvValueSchema>;

// Service readiness polling — how long / how often to wait until an HTTP endpoint responds.
// Slow-booting services (first image pull·DB migration etc.) get longer. Unset = runtime default (60s/1s).
export const ServiceReadinessSchema = z.object({
  timeoutMs: z.number().int().positive().default(60000),
  intervalMs: z.number().int().positive().default(1000),
});
export type ServiceReadiness = z.infer<typeof ServiceReadinessSchema>;

// Service resource request — cpu (1000 = 1 vCPU; k8s millicores convention) + memoryMb. Unset = runtime default.
// Mapping across the 3 runtimes: nomad Resources.CPU(MHz)/MemoryMB · k8s requests/limits(${cpu}m / ${memoryMb}Mi) ·
// docker --cpus(=cpu/1000 cores)/--memory(${memoryMb}m). A "bigger box" variation of the same topology + fairness/cost.
export const ServiceResourcesSchema = z.object({
  cpu: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
});
export type ServiceResources = z.infer<typeof ServiceResourcesSchema>;

// Topology service (stateless → per-version warm). perRun = key names injected by the runtime.
// env = the service's static env (non-store config like MODEL/LOG_LEVEL/feature flags). Injection precedence: store connEnv (convention) < env < operational storeEnv.
// volumes = docker `-v` style mount specs ("named-vol:/data" · "/host:/container:ro"); readiness = the polling bound above.
// All three (+ resources) are declarative — the Docker/Nomad/K8s runtimes all interpret them (k8s: volumes→emptyDir/hostPath +
// readinessProbe; nomad: docker volumes + runtime HTTP wait; docker: -v + polling).
export const TopologyServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  port: z.number().int().optional(),
  needs: z.array(z.string()).default([]),
  perRun: z.array(z.string()).default([]),
  replicas: z.number().int().default(1),
  env: z.record(EnvValueSchema).default({}), // literal or { secretRef } — resolved just before execution
  volumes: z.array(z.string()).optional(),
  readiness: ServiceReadinessSchema.optional(),
  resources: ServiceResourcesSchema.optional(), // cpu/memory request — interpreted by nomad/k8s/docker (unset = runtime default)
  // Intrinsic execution requirement — WHAT the service's image needs, never WHERE (no node label / cluster specifics).
  // os = the OS the image genuinely requires (a Windows Playwright server needs Windows on ANY infra). Portable: it
  // derives to an os-<x> capability, so the placement gate excludes runtimes without such a node; each TopologyRuntime
  // realizes it natively (k8s nodeSelector / nomad ${attr.kernel.name} / docker declines). Unset / linux = no gate.
  requires: z
    .object({ os: z.enum(["linux", "windows", "macos"]).optional() })
    .strict()
    .optional(),
  // Inject a `needs` peer's runtime coordinates under BYO env var names, so an unmodified third-party image finds its
  // peers under the names IT expects (e.g. Selenium's SE_EVENT_BUS_HOST). Portable: each runtime fills these its own
  // way — co-located Nomad/Docker = the peer's loopback/alias + declared port (static); per-service Nomad = the
  // discovery template (runtime, re-resolving); K8s = Service DNS (static). hostEnv←host, portEnv←port, urlEnv←http://host:port.
  wiring: z
    .array(
      z
        .object({
          service: z.string(), // a peer service name (should be in `needs`)
          hostEnv: z.string().optional(),
          portEnv: z.string().optional(),
          urlEnv: z.string().optional(),
        })
        .strict(),
    )
    .optional(),
});
export type TopologyService = z.infer<typeof TopologyServiceSchema>;
export type ServiceWiring = NonNullable<TopologyService["wiring"]>[number];

// Dependency store (shared + per-case logical isolation). isolateBy = the isolation key kind.
// isolateBy="external" = BYO external/shared store (another cluster etc.) — Everdict does not deploy/isolate it, the service just connects.
//   The connection is out of spec, injected at deploy time via env (storeEnv)/service.env (consistent with StoreIsolation's external model).
//   The runtime excludes an external dep from provisioning/wiring and only exposes it first-class in the diagram/structure.
// service = the service that uses this store (unset = topology-wide) — for the service→store edge in the diagram.
export const TopologyDependencySchema = z.object({
  store: z.enum(["postgres", "redis", "minio"]),
  role: z.string(),
  isolateBy: z.enum(["thread_id", "key-prefix", "object-prefix", "schema", "external"]),
  service: z.string().optional(),
});
export type TopologyDependency = z.infer<typeof TopologyDependencySchema>;

// Observation delivery mode — how the judge/grader receives observations.
// reference (store-fetch, evaluation pulls) | sentinel (inlined back over the result channel) | egress (pushed to a sink).
// Unset = reference (current). The topology path implements reference only (sentinel = slice 3, egress = 4). The axis that pairs with
// placement-locality — docs/architecture/judge-placement-locality.md.
export const ObservationDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("reference") }),
  // sentinel — the observation is returned inline in the front-door response (result channel). path = the dot-path to pull the EnvSnapshot
  // from the response body (if unset, the whole body is the EnvSnapshot). The same no-eval extraction as correlate.path.
  z.object({ mode: z.literal("sentinel"), path: z.string().optional() }),
  z.object({ mode: z.literal("egress"), sink: z.string() }), // the sink to push the observation into (object store etc.)
]);
export type ObservationDelivery = z.infer<typeof ObservationDeliverySchema>;

// Target acquisition strategy (B2) — how the target environment is obtained. Unset = provision (current: the runtime spins up a per-case browser container).
// service = open the session API of a declared topology service and map response fields to wiring coordinates, close on dispose.
// → expresses a harness that has its own session browser (playwright-server/Browserbase-style) without an Everdict container.
// The open request body/header templates are follow-up (together with front-door request.headers). Design: docs/architecture/target-acquisition-generalization.md.
export const TargetAcquireSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("provision") }),
  z.object({
    mode: z.literal("service"),
    service: z.string(), // the service in spec.services that provides the session API (the endpoint-discovery target)
    open: z.string(), // session start — "POST /sessions" (method+path; wiring {var} interpolation)
    coordinates: z.record(z.string()), // wiring variable name → dot-path in the open response JSON (e.g. { target_cdp_url: "cdp_url" })
    close: z.string().optional(), // session cleanup — "DELETE /sessions/{session_id}" (on dispose; {var} ← wiring+coordinates)
    // Readiness gate — right after open the session exists, but until its client (browser etc.) self-registers via back-connect,
    // a front-door command bounces with 404. If ready is present, poll until the status URL is 200 (2xx), then hand over the coordinates.
    // service = the service to check readiness on (unset = acquire.service). poll = "GET /ready" (method+path; wiring+coordinates {var} interpolation).
    ready: z
      .object({
        service: z.string().optional(),
        poll: z.string(),
        intervalMs: z.number().int().positive().default(1000),
        timeoutMs: z.number().int().positive().default(60000),
      })
      .optional(),
  }),
]);
export type TargetAcquire = z.infer<typeof TargetAcquireSchema>;

// Target environment (II): browser (+ client extension). A fresh per-case instance + the grader's observation target.
export const TopologyTargetSchema = z.object({
  kind: z.literal("browser"),
  engine: z.literal("chromium"),
  extension: z.object({ ref: z.string() }).optional(),
  lifecycle: z.enum(["per-case-instance", "per-case-context"]).default("per-case-instance"),
  observe: z.array(z.enum(["dom", "screenshot", "url"])).default(["dom", "screenshot", "url"]),
  delivery: ObservationDeliverySchema.optional(), // unset = reference (current, no regression)
  acquire: TargetAcquireSchema.optional(), // unset = provision (current). service = acquire via session API (B2)
});
export type TopologyTarget = z.infer<typeof TopologyTargetSchema>;

// Status response matching (done/failed decision) — no arbitrary code/eval, declarative data of a dot-path field + value comparison.
export const StatusMatchSchema = z
  .object({
    field: z.string(), // dot-path in the status response JSON (e.g. "status", "data.state")
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    oneOf: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .refine((m) => m.equals !== undefined || m.oneOf !== undefined, {
    message: "One of equals or oneOf must be specified.",
  });
export type StatusMatch = z.infer<typeof StatusMatchSchema>;

// Front-door completion model (#2): how to wait for the agent to finish its N steps after submit.
// sync = the submit response is the completion (default if unset, current behavior). poll = poll a status endpoint until the terminal condition.
// stream = the submit response is an SSE event stream, decided by the terminal event (A2A message/stream). callback = fire-and-forget, then
// the agent POSTs the terminal result to {{callback_url}} → inbound await. Design: docs/architecture/completion-stream-callback.md.
export const FrontDoorCompletionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("sync") }),
  z.object({
    mode: z.literal("poll"),
    statusPath: z.string(), // e.g. "GET /runs/{run_id}/status" — interpolate wiring variables ({run_id} etc.)
    done: StatusMatchSchema,
    failed: StatusMatchSchema.optional(),
    intervalMs: z.number().int().positive().default(1000),
    timeoutMs: z.number().int().positive().default(120000),
  }),
  z.object({
    mode: z.literal("stream"),
    done: StatusMatchSchema, // dot-path match against each parsed stream event (same data matcher as poll)
    failed: StatusMatchSchema.optional(),
    timeoutMs: z.number().int().positive().default(120000), // wall-clock bound for the whole stream
  }),
  z.object({
    mode: z.literal("callback"),
    done: StatusMatchSchema.optional(), // match the inbound POST body (unset = any POST completes). If no match, treat as interim and await the next POST.
    failed: StatusMatchSchema.optional(),
    timeoutMs: z.number().int().positive().default(120000),
  }),
]);
export type FrontDoorCompletion = z.infer<typeof FrontDoorCompletionSchema>;

// Trace correlation (#3): by which id to pull this run's trace from the traceSource.
// injected = correlate by the run_id everdict injected (default if unset, current — same assumption as CommandHarness {{run_id}}).
// returned = the agent mints its own id and returns it in the submit response → correlate by that id (+ interpolate the poll statusPath with it too).
export const FrontDoorCorrelateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("injected") }),
  z.object({ mode: z.literal("returned"), path: z.string() }), // dot-path in the submit response JSON (e.g. "run_id", "data.id")
]);
export type FrontDoorCorrelate = z.infer<typeof FrontDoorCorrelateSchema>;

// Front-door request (#1): the body as a declarative template. Unset = current browser-use 5-field body (no regression).
// Substitute {{var}} tokens inside bodyTemplate's string values with per-run wiring (task/run_id/thread_id/object_prefix/target_cdp_url…)
// — the same convention as CommandHarness {{task}}. Wiring names are derived from dependencies[].isolateBy.
// headers: headers to attach to the submit/stream/callback request (values also {{var}}-interpolated — e.g. Authorization). method comes from submit's verb ("POST /runs").
// A front-door attachment (G2): carry a file from the case's repo-env files into a multipart submit. `field` = the
// multipart part name the agent expects; `from` = a path key in the case env's source.files (the attachment content);
// `filename` = the sent filename (defaults to `from`). Used only with encoding:"form". Design: docs/architecture/suna-harness-gaps.md.
export const FrontDoorFileSchema = z
  .object({ field: z.string(), from: z.string(), filename: z.string().optional() })
  .strict();
export type FrontDoorFile = z.infer<typeof FrontDoorFileSchema>;

export const FrontDoorRequestSchema = z.object({
  bodyTemplate: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  // How the body is sent: "json" (default, application/json) | "form" (multipart/form-data — bodyTemplate fields as
  // text parts + `files` as file parts). Needed for agents whose submit is multipart with file attachments (e.g. Suna's
  // /api/agent/initiate). Design: docs/architecture/suna-harness-gaps.md (G2).
  encoding: z.enum(["json", "form"]).optional(),
  files: z.array(FrontDoorFileSchema).optional(), // attachments carried from the case env into the multipart submit
});
export type FrontDoorRequest = z.infer<typeof FrontDoorRequestSchema>;

// Where the agent's step trace comes from — the sibling of correlate (which id) for the "no platform" case.
// Unset = pull it from the platform traceSource (otel/mlflow — current). inline = the agent returned a NORMALIZED
// TraceEvent[] in the front-door response body (the sentinel/result channel), mirroring the sentinel observation.
// path = dot-path to the array (unset = the whole body). No observability platform required — the judge then sees the
// agent's action steps directly, instead of only the final snapshot. Design: docs/service-harness.md (inline trace).
export const FrontDoorTraceInlineSchema = z.object({ path: z.string().optional() }).strict();
export type FrontDoorTraceInline = z.infer<typeof FrontDoorTraceInlineSchema>;

// Front-door contract — the task submit entry point (service/submit) + (optional) request body + completion-wait model + trace correlation + trace path.
export const FrontDoorSpecSchema = z.object({
  service: z.string(),
  submit: z.string(),
  trace: z.string().optional(),
  request: FrontDoorRequestSchema.optional(), // unset = current 5-field body
  completion: FrontDoorCompletionSchema.optional(), // unset = sync (current)
  correlate: FrontDoorCorrelateSchema.optional(), // unset = injected (current)
  traceInline: FrontDoorTraceInlineSchema.optional(), // unset = pull from traceSource; set = extract TraceEvent[] from the response
});
export type FrontDoorSpec = z.infer<typeof FrontDoorSpecSchema>;

// process harness: a single process (one sandbox). Claude Code/Codex.
export const ProcessHarnessSpecSchema = z.object({
  kind: z.literal("process"),
  id: z.string(),
  version: z.string(),
});

// service harness: a deployable topology. browser-use-langgraph etc.
export const ServiceHarnessSpecSchema = z.object({
  kind: z.literal("service"),
  id: z.string(),
  version: z.string(),
  services: z.array(TopologyServiceSchema),
  dependencies: z.array(TopologyDependencySchema).default([]),
  target: TopologyTargetSchema.optional(),
  frontDoor: FrontDoorSpecSchema,
  traceSource: TraceSourceSpecSchema,
});
export type ServiceHarnessSpec = z.infer<typeof ServiceHarnessSpecSchema>;

// Trace extraction for a command harness: none (result only) | platform pull (otel/mlflow/langfuse/langsmith/phoenix —
// same as @everdict/trace buildTraceSource's 5 kinds, correlate by runId).
// collect: collection location — "job" (default, pull inside the job after releasing compute; also works for cluster-internal endpoints) |
// "control-plane" (the job ends at execution; the control plane pulls + scores observations — only when the endpoint is reachable from the control plane).
// authSecret: endpoint auth (SecretStore name — the value's header placement is adapter convention: otel/mlflow=verbatim
// Authorization, langsmith=x-api-key etc.; same as pull-ingest source.authSecret). auth is transient —
// resolveHarnessSecrets fills it with the value just before dispatch (never stored in the registry).
// docs/architecture/streaming-case-pipeline.md D4
const commandTraceAuth = {
  authSecret: z.string().optional(),
  auth: z.string().optional(), // transient (resolved at dispatch) — do not put it in the registered spec
  collect: z.enum(["job", "control-plane"]).default("job"),
};
export const CommandTraceSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("otel"),
    endpoint: z.string(),
    ...commandTraceAuth,
    // Correlation mode: "id" (default) = runId is the trace id | "tag" = search by the agent resource attribute everdict.run_id
    // (the injected env OTEL_RESOURCE_ATTRIBUTES verbatim — Jaeger query API only, service required).
    correlate: z.enum(["id", "tag"]).default("id"),
    service: z.string().optional(), // search scope for tag correlation (the agent's service.name)
  }),
  z.object({
    kind: z.literal("mlflow"),
    endpoint: z.string(),
    ...commandTraceAuth,
    // Correlation mode: "id" (default) = runId is the MLflow trace_id (pull-ingest convention) | "tag" = search by the
    // everdict.run_id tag the instrumented agent left on its own trace (id is server-minted — the real agent path). tag requires experiment.
    correlate: z.enum(["id", "tag"]).default("id"),
    experiment: z.string().optional(), // search scope for tag correlation (MLflow traces/search requires locations)
  }),
  z.object({ kind: z.literal("langfuse"), endpoint: z.string(), ...commandTraceAuth }),
  z.object({ kind: z.literal("langsmith"), endpoint: z.string(), ...commandTraceAuth }),
  z.object({
    kind: z.literal("phoenix"),
    endpoint: z.string(),
    // Phoenix spans are queried only via a project (/v1/projects/{p}/spans?trace_id=) — required.
    project: z.string(),
    ...commandTraceAuth,
  }),
]);
export type CommandTraceSpec = z.infer<typeof CommandTraceSpecSchema>;

// command harness: a declarative process — register any CLI agent (aider etc.) with just a spec, no code adapter.
// setup (install) → run command (template {{task}}/{{model}}/{{run_id}}) → extract trace (none/otel/mlflow).
// The generic CommandHarness (@everdict/harnesses) interprets it. Since it runs arbitrary code, trust-zone isolation is enforced.
export const CommandHarnessSpecSchema = z.object({
  kind: z.literal("command"),
  id: z.string(),
  version: z.string(),
  image: z.string().optional(), // dispatch image (default agent image if absent). Install tools via setup.
  // Resource request for the whole job (same convention as TopologyService.resources: cpu 1000=1vCPU/nomad MHz,
  // memoryMb). Heavier harnesses declare it so nomad/k8s bin-pack correctly and starvation reads as an infra
  // failure (OOM_KILLED) instead of an agent one. Unset = backend defaults.
  resources: ServiceResourcesSchema.optional(),
  workDir: z.string().optional(), // setup/command execution directory (default "work"). Environments without a work dir (os-use etc.) use an absolute path (e.g. "/tmp").
  setup: z.array(z.string()).default([]), // run once in the sandbox (e.g. "pip install aider-chat==0.74.0")
  command: z.string(), // e.g. "aider --yes --message {{task}} --model {{model}} --edit-format {{edit_format}} ."
  env: z.record(EnvValueSchema).default({}), // literal or { secretRef } — resolved just before execution
  model: z.string().optional(),
  // Generic {{var}} substitution values — fill command's {{key}} from params[key] (excluding the reserved {{task}}/{{model}}/{{run_id}}).
  // The channel by which a variation of the same template (an instance's overrides.params) changes CLI flags. Values are not shell-escaped (author-trusted, same as {{model}}).
  params: z.record(z.string()).default({}),
  trace: CommandTraceSpecSchema.default({ kind: "none" }),
});
export type CommandHarnessSpec = z.infer<typeof CommandHarnessSpecSchema>;

export const HarnessSpecSchema = z.discriminatedUnion("kind", [
  ProcessHarnessSpecSchema,
  ServiceHarnessSpecSchema,
  CommandHarnessSpecSchema,
]);
export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
