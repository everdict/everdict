// Semantic conventions — the attribute vocabulary a span speaks.
//
// The rule this file exists to enforce: **the standard first, `everdict.*` only for what has none.** OTel
// already names the things we were about to name ourselves (the node a job landed on, the pod it ran in, the
// model a call used, the tokens it spent), and a private key for a public concept is a key nobody else can
// read — which is the whole point of being OTel-compatible. Anything genuinely ours (the plane axis, the run
// correlation, cost) gets the prefix, and this file is where that judgement is recorded rather than made
// again at each call site.
//
// See docs/architecture/otel-trace-model.md.

// --- GenAI semantic conventions (OTel) -----------------------------------------------------------------
//
// Status: `development` upstream — these keys have moved before (message content migrated from span events
// to attributes) and may move again. Every span records the version it was written against
// (`GENAI_SEMCONV_VERSION`, stamped as `everdict.semconv`) so sealed evidence is never silently
// re-interpreted by a later reading of the same key.
export const GEN_AI = {
  // Which operation the span IS. The span name follows from it: `chat {model}` / `execute_tool {tool}` /
  // `invoke_agent {agent}`.
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name", // "anthropic" | "openai" | …
  conversationId: "gen_ai.conversation.id",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  agentName: "gen_ai.agent.name",
  // Content capture (opt-in by convention — a payload, not telemetry). This is the half that has already
  // moved once, so our own emitters write it here AND under `EVERDICT_ATTR.input/output` until the
  // convention settles; readers prefer the standard key and fall back.
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
} as const;

// The values `gen_ai.operation.name` may take that we actually emit. Not the full upstream enum — the ones
// with a live emit point here, so an unknown string is a bug rather than a dialect.
export const GEN_AI_OPERATION = {
  chat: "chat",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
} as const;
export type GenAiOperation = (typeof GEN_AI_OPERATION)[keyof typeof GEN_AI_OPERATION];

// The GenAI convention revision our emitters were written against. Stamped on every span we mint.
export const GENAI_SEMCONV_VERSION = "1.37.0";

// --- Standard OTel attributes we reuse verbatim --------------------------------------------------------
//
// These are RESOURCE attributes: they describe the emitting entity, not the operation. The placement plane
// is built from them — the node and the unit a job landed on are exactly `k8s.node.name` / `k8s.pod.name`,
// and inventing `everdict.placement.node` for them would have been a private name for a public thing.
export const OTEL_RESOURCE = {
  serviceName: "service.name", // the plane key of a multi-emitter trajectory (maintainer's decision, N5)
  serviceVersion: "service.version",
  k8sNodeName: "k8s.node.name",
  k8sPodName: "k8s.pod.name",
  k8sNamespace: "k8s.namespace.name",
  containerId: "container.id",
  hostName: "host.name",
} as const;

// Span-level standard attributes.
export const OTEL_ATTR = {
  errorType: "error.type", // pairs with span status = "error"
} as const;

// Kept as its own export because it is load-bearing far from here (the door groups planes by exactly this
// string) and readers should not have to know it lives in a resource bag.
export const OTEL_SERVICE_NAME_ATTR = OTEL_RESOURCE.serviceName;

// --- everdict.* — ours, and only where the standard has nothing -----------------------------------------
export const EVERDICT_SEMCONV = {
  runId: "everdict.run_id",
  kind: "everdict.kind",
  caseId: "everdict.case_id",
  groupId: "everdict.group_id",
} as const;

export const EVERDICT_ATTR = {
  ...EVERDICT_SEMCONV,
  // The plane axis — which face of the system this span belongs to. OTel has no equivalent: `service.name`
  // says WHO emitted, this says WHAT ROLE it played in the run.
  plane: "everdict.plane",
  // Price. The GenAI conventions define tokens and deliberately stop there, leaving cost to the platform.
  // Our graders read it, so it keeps the prefix — the one documented exception in otel-trace-model.md.
  costUsd: "everdict.cost.usd",
  // Content capture under our own key, written beside the standard one while `gen_ai.*.messages` is still
  // moving. Readers prefer the standard key.
  input: "everdict.input",
  output: "everdict.output",
  // The GenAI convention revision this span was written against.
  semconv: "everdict.semconv",
  // Orchestrator identity that OTel does not name (Nomad has no semconv of its own).
  nomadAllocId: "everdict.nomad.alloc_id",
  nomadJobId: "everdict.nomad.job_id",
  // The trajectory this span was assembled from, when it did not arrive as a span (a black-box harness's
  // point-event stream run through `eventsToSpans`). Marks inference as inference.
  assembled: "everdict.assembled",
  // Round-trip keys. The projection back to `TraceEvent` has to return the SAME event a harness emitted, or
  // making spans the record silently rewrites what judges read. These three carry the union's fields that
  // no OTel convention names: a message's speaker (the GenAI conventions carry role inside a structured
  // message list, which a single text has no room for), a log's stream, and an environment action's verb.
  messageRole: "everdict.message.role",
  logStream: "everdict.log.stream",
  envAction: "everdict.env_action",
} as const;

// The plane vocabulary — closed, because a lane the reader cannot name is a lane it cannot draw.
export const TRACE_PLANE = {
  agent: "agent", // the agent under test / the conversational agent: its own steps
  placement: "placement", // the orchestrator's account of where the run ran
  service: "service", // a service under test that pushed its own spans into the run
  eval: "eval", // our own scoring work over the trace
} as const;
export type TracePlane = (typeof TRACE_PLANE)[keyof typeof TRACE_PLANE];
