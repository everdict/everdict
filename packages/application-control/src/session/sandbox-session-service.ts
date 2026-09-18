import {
  BadRequestError,
  type ComputeHandle,
  ConflictError,
  type DelegateDeliveryMode,
  type DelegateReport,
  DelegateReportSchema,
  type DelegateState,
  type DelegationBrief,
  type DomainFact,
  type Driver,
  type EvaluableHarness,
  ForbiddenError,
  GIT_MACHINE_IDENTITY,
  type HarnessSpec,
  IMAGE_GRANT_USERNAME,
  type NetworkPolicy,
  NotFoundError,
  RateLimitError,
  type RegistryAuth,
  type RunRecord,
  type RunStatus,
  type TraceEvent,
  UpstreamError,
  gitAuthEnv,
  shq,
} from "@everdict/contracts";
import {
  type BudgetTracker,
  type CliIdentityChoice,
  DELEGATE_REPORT_FILE,
  IMAGE_REPOSITORY_NAME,
  type IssueDelegationBriefInput,
  Run,
  type UsageMeter,
  interruptedFrom,
  issueDelegationBrief,
  pinDigest,
  planDelivery,
  renderDelegationBrief,
} from "@everdict/domain";
import { admitCausedWork } from "../admission/admission.js";
import type { CampaignService } from "../evolution/campaign-service.js";
import { stampFacts } from "../platform-event/outbox.js";
import type { EnvelopeStore } from "../ports/envelope-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { LiveSessionRow, RunStore } from "../ports/run-store.js";
import type { ResolvedServiceConversation, ServiceConversation } from "../ports/service-conversation.js";
import { settleRun } from "../ports/settle.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";
import type { WorkspaceImages } from "../ports/workspace-images.js";
import { FrontDoorTurnRunner } from "./frontdoor-turn-runner.js";
import { scopedComputeHandle } from "./scoped-compute.js";
import { SessionTaskRunner } from "./session-task-runner.js";

// Session runs (execution-model.md P6, master plan W5): "run this environment image and shell in."
// The RECORD lives on the universal Run ledger (kind "sandbox", lifetime "session" — visible in the
// activity console, settled like any run); only the live ComputeHandle stays in this process-local map
// (the BrowserSessionService split, generalized). Disposal is the invariant: the container is provisioned
// BEFORE the record exists (no orphan record on a failed provision), torn down in a `finally` on every
// close path, and the hard deadline lives ON THE ROW (`session.expiresAt`) so the durable reaper rung can
// tear down from the row alone. Every exec is appended to the session's trajectory and sealed at teardown —
// a shell session leaves evidence, not just side effects.
const DEFAULT_TTL_SEC = 900; // the browser sessions' 15m prior
const MAX_TTL_SEC = 4 * 3600;
const DEFAULT_EXEC_TIMEOUT_SEC = 60;
const MAX_EXEC_TIMEOUT_SEC = 600;
const MAX_TRACE_OUTPUT_CHARS = 20_000;
const DEFAULT_TASK_TIMEOUT_SEC = 600;
const MAX_TASK_TIMEOUT_SEC = 3600;
const TASK_PREVIEW_CHARS = 200;
const TEARDOWN_TASK_GRACE_MS = 5_000;
// How long past a row's deadline the orphan sweep waits before reaping it (sweepOrphans) — long enough for
// the process that actually holds the handle (this one or another writer on the same store) to finish its
// own normal teardown, short enough that a crashed writer's row cannot hold a slot for more than a beat.
const ORPHAN_GRACE_MS = 120_000;
// How many live sessions ONE agent may hold (W3). One by default: a world is meant to be worked in, then
// hibernated — an agent that needs several at once is a deployment decision, not a default.
const DEFAULT_MAX_PER_AGENT = 1;
// The working directory a session's repository lands in — the same `work` every harness and grader already
// assumes, so a cloned session and an eval case agree on where "the code" is.
const DEFAULT_REPO_DIR = "work";
const GIT_TIMEOUT_SEC = 600; // a clone/push of a real repository is minutes, not the 60s exec default
// What a placement-independent capture reads (W4): the session's own working root. NOT the whole filesystem —
// a tar of `/` over an exec channel is neither affordable nor meaningful (it would capture /proc and the
// container's own runtime), and everything a world accumulates lives under the base directory by convention.
const CAPTURE_DIR = "/everdict";
const CAPTURE_TIMEOUT_SEC = 1800; // a real tree compresses for minutes; the exec default would truncate it
const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB compressed — base64 in memory bounds this

// The tag or digest a snapshot's base is addressed by, given the ref the session booted. The registry is
// asked for a reference WITHIN the repository, so the host/namespace prefix is dropped and a digest pin wins
// over the tag it carries (`repo:v3@sha256:…` resolves by digest — the tag is for humans).
function baseReferenceOf(image: string): string {
  const atDigest = image.lastIndexOf("@");
  if (atDigest !== -1) return image.slice(atDigest + 1);
  const lastSlash = image.lastIndexOf("/");
  const name = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  const colon = name.lastIndexOf(":");
  return colon === -1 ? "latest" : name.slice(colon + 1);
}

export interface SandboxActor {
  tenant: string;
  subject: string;
  isAdmin: boolean;
  // Which agent is acting for this member, when one is (the MCP session declares it at initialize). Every
  // fact the session emits then carries `causedBy: agent:<id>:<conversation>` — loop guard #1 keys on that
  // exact prefix, so an autonomous agent that snapshots a world never wakes on its own snapshot (W3).
  agent?: SandboxAgentAttribution;
}

export interface SandboxAgentAttribution {
  agentId: string;
  conversationId?: string;
  // The agent's CURRENT ledger run — what this session stamps as origin.causedByRunId so it draws from that
  // turn's delegated envelope and is counted by the depth / in-flight guards (§5.1). Never client-supplied.
  runId?: string;
}

// The run `trigger` that names THIS pool. Session runs share `kind: "sandbox"` (held-open isolated compute)
// but not their caps — a login browser is bounded separately — and the trigger is what tells them apart.
const SANDBOX_TRIGGER = "sandbox";
// Front-door conversation sessions hold a tenant-cluster warm-topology slot (+ optionally a browser), not a
// control-plane container — different scarcity, so a separate pool with its own caps: chat sessions must not
// starve shell sandboxes, and vice versa.
const FRONTDOOR_TRIGGER = "frontdoor";

// The rows that are actually holding a slot right now. A row past its deadline is due for teardown either
// way, and counting it would let one crashed writer consume a workspace's session pool permanently — a state
// no member can recover from. Judged with the SERVICE's clock, the same one that wrote `expiresAt`.
function holding(rows: LiveSessionRow[], nowIso: string): LiveSessionRow[] {
  const now = Date.parse(nowIso);
  return rows.filter((r) => r.expiresAt === undefined || Date.parse(r.expiresAt) > now);
}

// When the earliest-expiring session frees its slot — the one fact that makes a capacity refusal actionable
// (wait this long, or go close something). Computed from the rows the caller already read, so a refusal costs
// one ledger query, not one per message.
function nextFreeSlot(rows: LiveSessionRow[]): { freesAt?: string } {
  const deadlines = rows.map((r) => r.expiresAt).filter((at): at is string => at !== undefined);
  if (deadlines.length === 0) return {};
  return { freesAt: deadlines.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) };
}

function freesAtSuffix(rows: LiveSessionRow[]): string {
  const { freesAt } = nextFreeSlot(rows);
  return freesAt === undefined ? "" : ` — the next slot frees at ${freesAt}`;
}

function causedByOf(agent: SandboxAgentAttribution | undefined): string | undefined {
  if (!agent?.agentId) return undefined;
  return `agent:${agent.agentId}:${agent.conversationId ?? "unknown"}`;
}

// The facts a transition produced, attributed to the agent behind the call when there is one. Applied at
// every emit point in this service rather than inside the domain: legality is the aggregate's business,
// WHO caused it is the caller's.
function attributed(facts: DomainFact[], agent: SandboxAgentAttribution | undefined): DomainFact[] {
  const causedBy = causedByOf(agent);
  return causedBy === undefined ? facts : facts.map((fact) => ({ ...fact, causedBy }));
}

export interface CreateSandboxInput {
  // Run as a NAMED identity instead of the submitter's own — "run as the team's CI account". Omitted, the
  // session resolves the submitter's registered identity for the CLI it is about to run, which is the whole
  // point of registering one: register it once and no call has to name it again.
  identity?: { source?: string; id: string; version?: string };
  tenant: string;
  createdBy: string;
  // What to boot: an adopted environment capability (resolved to its image via the injected resolver), an
  // ad-hoc image ref, or a HARNESS to drive test cases through (the playground). Exactly one is required.
  // `harness.conversation` boots the playground in CONVERSATION mode: every submitted task continues one
  // conversation (stable workdir + the harness's own resume mechanism) instead of running independent cases.
  // The session picks its mode at boot and never flips; a harness without the `conversational` capability
  // marker refuses the flag up front (silently-fresh turns would be a lie).
  // A DELEGATION PROFILE (a `delegation` capability) is the fifth target and the one everdict delegates
  // through: one reference resolves the whole environment a registered work-agent needs (image · which
  // conversational harness · model binding · env/secrets · standing instructions), so a delegation is a
  // reference plus a brief instead of a pile of re-specified knobs. A profile session is ALWAYS a
  // conversation — that is what delegating means.
  profile?: { source?: string; id: string; version?: string };
  // The per-delegation handoff (goal · context · references · constraints · done-criteria). Materialized into
  // the delegate's working directory as a file it reads, and sealed on the session trajectory as evidence.
  // Only meaningful with `profile`.
  brief?: DelegationBrief;
  // ── DELEGATE AN ISSUE ────────────────────────────────────────────────────────────────────────────
  //
  // The high-level handoff: name the issue and the brief is ASSEMBLED from what the tracker already holds —
  // the description, the commits already linked to it, the issues it points at, and what the workspace has
  // learned about them. Excludes `brief`, because two briefs is a question with no rule for answering it.
  //
  // Why it belongs here rather than in a caller that reads the issue and types a brief: everything the
  // assembly must NOT say (a related issue's resolution, which reads as the answer) is only enforceable
  // where the assembly happens. A convention that says "do not paste the resolution" is advice, and advice
  // at the seam where the next effect begins is the annotation failure rule `protocol` is about.
  issueId?: string;
  // The supervisor's own checks, beyond the repository's gates — they become criteria the delegate answers
  // by id rather than prose it may or may not address.
  extraChecks?: string[];
  campaignId?: string;
  environment?: { source?: string; id: string; version?: string };
  image?: string;
  harness?: { id: string; version?: string; image?: string; conversation?: boolean };
  // Agent worlds (W1): open the session AS a world — boot the world's latest snapshot (its environment
  // capability), or found the world from `image` when it has no versions yet (the genesis base). The world
  // id doubles as the snapshot repository name, so it must be a valid single-segment repository.
  world?: { id: string };
  // Auto-snapshot at teardown (close and expiry both) — defaults ON for world sessions: an expiring world
  // session HIBERNATES instead of losing its filesystem. Meaningless without `world`.
  hibernate?: boolean;
  // Agent worlds (W2): clone a repository into the session before it is handed over. A private repo resolves a
  // read credential through the injected git seam; a public one clones anonymously. Combines with any target.
  repo?: { git: string; ref?: string; dir?: string };
  agent?: SandboxAgentAttribution; // stamps causedBy on this session's facts (loop guard #1)
  // WHERE to place this session (W4): a runtime the workspace registered, the same axis a run's
  // `placement.target` names. Unset = the deployment's default compute (this host, or the operator's
  // configured cluster) — a workspace with its own infrastructure should not have to borrow ours.
  runtime?: string;
  ttlSec?: number;
}

// A registered harness resolved for session use — built by the composition root (registry + secrets +
// model binding + makeHarness). Secret VALUES live only here (process memory): apiKeyEnv reaches the
// container via RunContext, spec env via the harness — never a record, a trace, or a marker.
export interface ResolvedSessionHarness {
  id: string;
  version: string;
  // What SHAPE of harness this is — the web branches its playground UI on it ("process" = a built-in CLI
  // adapter like claude-code, "command" = a declarative CLI spec). Service harnesses never reach this
  // resolver (they boot through the front-door conversation seam instead).
  kind: "process" | "command";
  spec?: HarnessSpec; // fully resolved ({secretRef} + model binding already substituted to strings)
  harness: EvaluableHarness;
  apiKeyEnv: Record<string, string>;
  image?: string; // the spec's image (command kind); undefined = the caller must provide harness.image
}

// A delegation profile resolved for session use — the registered environment (image + a harness whose adapter
// already carries the profile's env/workDir) plus what the session must seed and stamp. Built by the
// composition root behind the same injected-closure seam as resolveSessionHarness.
// A registered CLI identity, already resolved: its secret references read, its files' contents in hand.
// Secret VALUES live only here (process memory) — never on the record, the spec or the trajectory.
export interface ResolvedCliIdentity {
  ref: { source: string; id: string; version: string };
  env: Record<string, string>;
  home: Array<{ path: string; content: string }>;
}

export interface ResolvedDelegationProfile {
  ref: { source: string; id: string; version: string }; // what was delegated to, for the record + the evidence
  harness: ResolvedSessionHarness;
  image: string;
  workDir: string; // the conversation's stable cwd — also where the brief lands
  instructions: string; // the profile's STANDING brief (what is true of every delegation into it)
  instructionsFile: string; // the convention file this agent reads (CLAUDE.md · AGENTS.md · …)
  ttlSec?: number;
  // The network the delegate may reach, carried to the provision (code-evolution-loop.md, placement). Absent
  // = the runtime's default. A driver that cannot enforce the declared mode refuses the boot.
  network?: NetworkPolicy;
}

// One submitted test case: its child run id + the live cursor buffer the web polls. Kept until the
// session closes (short-lived by TTL); after settle the sealed trajectory serves the same events.
interface TaskEntry {
  runId: string;
  caseId: string;
  task: string;
  submittedAt: string;
  status: RunStatus;
  events: TraceEvent[];
  fresh?: boolean; // conversation sessions only: this turn deliberately started a new thread
}

// Conversation mode (set at boot, never flips): `resume` is the harness's provider-native token that
// continues the previous turn — process-local by design (a CP restart orphans the session anyway, and its
// container died with the token's context). `threadSeq` counts `fresh` resets for the trajectory.
interface ConversationState {
  resume?: string;
  threadSeq: number;
}

// ── THE MAILBOX ──────────────────────────────────────────────────────────────────────────────────────
//
// What a supervisor said to a delegate that was not ready to hear it. Before this existed there was no such
// place: a message to a busy delegate was a `409`, so the supervisor's only options were to wait for the turn
// to end or to kill the session, and the queue lived in the supervisor's head.
//
// ⚠️ OUR BOUNDARY IS THE END OF A TURN, NOT A MESSAGE BOUNDARY INSIDE ONE. codex can deliver mid-sampling
// because it owns the model loop; we spawn a harness CLI and wait for it, so there is no seam to inject at.
// The `task` mode therefore means "queued, and it starts the moment this turn finishes" rather than "handed
// over while it works". That is still the difference between a supervisor who can hand off the next
// instruction and one who must choose between waiting and interrupting — but it is not the same thing, and
// saying it was would make the next reader look for an injection point that is not there.
interface QueuedDelivery {
  id: string;
  mode: "message" | "task";
  text: string;
  at: string;
  by: string;
}

// Everything the supervisor said while the delegate could not hear it, rendered ahead of the message that
// starts this turn. Notes and work are kept APART in the prompt: a delegate that cannot tell "here is context"
// from "here is your next task" will either act on the context or ignore the task, and both look like it
// misread the instruction.
function drainMailbox(mailbox: QueuedDelivery[], task: string): string {
  if (mailbox.length === 0) return task;
  const notes = mailbox.filter((m) => m.mode === "message");
  const work = mailbox.filter((m) => m.mode === "task");
  const body = [...work.map((w) => w.text), task].filter((t) => t.trim() !== "").join("\n\n");
  if (notes.length === 0) return body;
  const preamble = [
    "## Messages that arrived while you were working",
    "",
    ...notes.map((n) => `- ${n.by}: ${n.text}`),
  ].join("\n");
  return body === "" ? preamble : `${preamble}\n\n---\n\n${body}`;
}

interface PlaygroundState {
  resolved: ResolvedSessionHarness;
  taskSeq: number;
  tasks: TaskEntry[];
  // What the supervisor has said that the delegate has not yet read. Drained in order into the next turn.
  mailbox: QueuedDelivery[];
  // What this delegate IS, from the supervisor's side. Kept explicitly rather than derived from `active`,
  // because three of the seven states (`interrupted`, `completed` with its report, `errored`) are facts about
  // something that ALREADY happened and cannot be reconstructed from whether a promise is pending.
  state: DelegateState;
  active?: { runId: string; abort: AbortController; done: Promise<void> };
  conversation?: ConversationState;
  // Present when this session was booted from a DELEGATION PROFILE: who was delegated to (for the read model)
  // and the working directory its context was seeded into — the same cwd every turn must run in, or the
  // delegate loses both its instructions and its conversation.
  delegation?: { ref: { source: string; id: string; version: string }; workDir: string };
}

// A front-door conversation session's live half (the service-harness sibling of PlaygroundState): the bound
// conversation + the same one-at-a-time turn feed. Always conversational — a service session that runs
// independent cases is the eval lane's job, not this one's.
interface FrontdoorState {
  resolved: ResolvedServiceConversation;
  conversation: ServiceConversation;
  runtime: string; // the workspace runtime the topology runs on — stamped as each turn's placement target
  taskSeq: number;
  tasks: TaskEntry[];
  active?: { runId: string; abort: AbortController; done: Promise<void> };
}

interface LiveSession {
  // The container handle + the driver that provisioned it. Absent for front-door conversation sessions —
  // their compute is a warm topology on a workspace runtime, reached over HTTP, with nothing to exec into.
  handle?: ComputeHandle;
  tenant: string;
  createdBy: string;
  // What the browse row calls this session's evidence — the environment the member asked for. Kept here
  // because the seal happens at teardown, long after the request that knew it.
  label: string;
  expiresAtMs: number;
  trace: TraceEvent[];
  t: number; // monotonic trajectory step
  execCount: number;
  world?: string; // agent worlds (W1): the environment capability this session snapshots into
  hibernate: boolean; // auto-snapshot at teardown (world sessions default true)
  bootImage?: string; // W4: the image this session started from — the base a captured layer extends
  // W4: the compute this session actually runs on (the deployment default, or the workspace's own runtime).
  // Held because teardown must dispose through the SAME driver that provisioned.
  driver?: Driver;
  repo?: { git: string; ref?: string; dir: string }; // W2: what was cloned in, and where
  // The agent behind this session, remembered because teardown and expiry emit facts long after the request
  // that knew who asked — an expiry fact must carry the same causedBy the creation one did.
  agent?: SandboxAgentAttribution;
  playground?: PlaygroundState; // present only for harness-target sessions
  frontdoor?: FrontdoorState; // present only for service-harness conversation sessions
}

// The reattach/monitor read model (GET /sandboxes, GET /sandboxes/:id).
export interface SandboxTaskSummary {
  runId: string;
  caseId: string;
  status: RunStatus;
  taskPreview: string;
  submittedAt: string;
  eventCount: number;
  fresh?: boolean; // conversation sessions only: this turn started a new thread
}

export interface SandboxSessionView {
  record: RunRecord;
  // Absent = not live on THIS control plane (settled, or lost to a restart — the reaper settles it).
  live?: {
    expiresAt: string;
    busy: boolean;
    harness?: { id: string; version: string; kind: "process" | "command" | "service" };
    conversation: boolean; // true = the task feed is one conversation (turns), not independent cases
    // Who this session delegates to, when it was booted from a delegation profile — so a surface can say
    // WHOSE environment is doing the work, not just which harness binary is running.
    profile?: { source: string; id: string; version: string };
    // The delegate's own state, carrying its report when it has filed one. Absent for a shell session and a
    // front-door conversation — neither is a supervised handoff.
    delegate?: DelegateState;
    // What the supervisor has said that the delegate has not read yet. The TEXT is deliberately not here:
    // a monitor showing every queued instruction in full is a wall, and the one place the wording matters is
    // the next turn's prompt, where it is already delivered verbatim.
    mailbox?: { id: string; mode: "message" | "task"; at: string; by: string }[];
    tasks: SandboxTaskSummary[];
  };
}

// What the tracker hands over for an issue-shaped brief. Exactly the assembler's input and nothing more —
// a port that returned the whole IssueRecord would let this lane read a resolution note it must not pass on,
// and the exclusion would then depend on nobody noticing it could.
export type IssueBriefSource = IssueDelegationBriefInput;

// What reaching a delegate DID. A union because two of the three delivery modes start nothing, and a caller
// that cannot tell "queued" from "started" cannot decide whether there is a trace to poll.
export type SandboxDeliveryOutcome =
  | { delivered: "started"; run: RunRecord; state?: DelegateState }
  | { delivered: "queued"; queued: number; state: DelegateState };

// One page of a task's live trace (the 2s poll target). `done` = terminal — stop polling; the same events
// then serve from the sealed trajectory (GET /runs/:id/trajectory).
export interface SandboxTaskTrace {
  status: RunStatus;
  events: TraceEvent[];
  nextCursor: number;
  done: boolean;
}

// What a snapshot published, and what retention removed to make room for it (W3). `prunedVersions` is
// present only when something was actually dropped — a caller reporting a bound must be able to name it.
export interface WorldSnapshotResult {
  world: string;
  version: string;
  image: string;
  prunedVersions?: string[];
}

export interface SandboxSessionServiceDeps {
  campaigns?: Pick<CampaignService, "issueEvidenceGrant">;
  // Reading the tracker for `issueId`. A narrow port rather than the IssueService itself: this lane needs to
  // READ an issue and the knowledge about it, and handing it a service that can also close one would make
  // "the delegate must not record its own verdict" a matter of discipline instead of reach.
  issueBriefSource?: {
    read: (tenant: string, id: string) => Promise<IssueBriefSource | undefined>;
  };
  store: RunStore;
  // The deployment's default container compute. Optional since front-door conversations: a deployment with
  // registered runtimes but no local compute still serves conversations — the container lanes then refuse
  // by name at create.
  driver?: Driver;
  trajectories?: TrajectoryStore; // sealed at teardown — the session's evidence
  events?: PlatformEventEmitter; // E0 facts ride the store writes; this is the latency nudge
  // environment ref → the concrete image + resolved version. apps/api wires the capability store + the
  // consume gate behind this; absent = ad-hoc images only (environment refs 404).
  resolveEnvironmentImage?: (
    tenant: string,
    subject: string,
    ref: { source?: string; id: string; version?: string },
  ) => Promise<{ image: string; version: string } | undefined>;
  // harness ref → a session-ready harness (registry get + secret resolution + model binding + makeHarness).
  // apps/api wires it; absent = harness sandboxes not configured (the playground 400s).
  resolveSessionHarness?: (
    tenant: string,
    subject: string,
    ref: { id: string; version?: string },
  ) => Promise<ResolvedSessionHarness | undefined>;
  // delegation-profile ref → the registered work environment (capability get + consume gate + secrets + model
  // binding + makeHarness with the profile's env/workDir). apps/api wires it; absent = delegation profiles are
  // not configured (a `profile` boot 400s). Undefined RESULT = no such profile for this workspace (404).
  resolveDelegationProfile?: (
    tenant: string,
    subject: string,
    ref: { source?: string; id: string; version?: string },
  ) => Promise<ResolvedDelegationProfile | undefined>;
  // Which registered CLI identity this session runs as — the submitter's own for the CLI about to run, or the
  // one the caller named. apps/api wires it; absent = identities are not configured and a session runs the way
  // it always did (the flat auth-env tiers).
  //
  // Returns the domain's THREE-VALUED choice, never `undefined` on failure: "you registered none" is an answer
  // a session records and continues from, while a store that could not answer must THROW and stop the boot. The
  // clone path in this same file is the counterexample — its `readToken(...).catch(() => undefined)` makes those
  // two indistinguishable, and a private clone then fails with a git message that names nothing.
  resolveCliIdentity?: (
    tenant: string,
    subject: string,
    input: { cli: string; ref?: { source?: string; id: string; version?: string } },
  ) => Promise<CliIdentityChoice<ResolvedCliIdentity>>;
  // harness ref → a bootable front-door CONVERSATION, when the ref is a kind:"service" harness (registry get
  // + secret resolution + the topology environment for the named runtime). Returns undefined for any other
  // kind — the process resolver above then answers. The resolver itself refuses a service harness with no
  // `runtime` (the user decision: conversations run on registered workspace runtimes only) and one whose
  // runtime is not topology-capable. apps/api wires it; absent = service harnesses fall through to the
  // process resolver's honest 404/400.
  resolveServiceConversation?: (
    tenant: string,
    subject: string,
    ref: { id: string; version?: string },
    opts: { runtime?: string },
  ) => Promise<ResolvedServiceConversation | undefined>;
  budget?: BudgetTracker; // admission (402 before a container or a child run exists) + cost settle
  // The causal leg of the same gate: an agent's session draws from its turn's delegated envelope.
  envelopes?: EnvelopeStore;
  admissionMaxInFlight?: number;
  usage?: UsageMeter; // per-model metering of task cost lines (billingCharges)
  // The durable reaper (orchestration.md T-b): start reaper:<runId> at create (a deadline timer that
  // survives every process), signal it on close (prompt completion — correctness never depends on it,
  // reap skips a settled record). Absent = the in-process sweep is the only expiry (rung-1 behavior).
  // `extend` re-arms the deadline on touch (W1) — optional and best-effort like the other two.
  reaper?: {
    start(input: { runId: string; tenant: string; expiresAt: string }): Promise<void>;
    signalClosed(runId: string): Promise<void>;
    extend?(input: { runId: string; tenant: string; expiresAt: string }): Promise<void>;
  };
  // Agent worlds (W1): the managed image store the snapshots publish into, and the closure that registers a
  // pushed snapshot as an environment-capability version (apps/api wires CapabilityService behind it — the
  // same injected-closure seam as resolveEnvironmentImage). Either absent = world sessions 400 at create.
  images?: Pick<WorkspaceImages, "endpoint" | "namespaceFor" | "listTags" | "inspect" | "mintPushGrant">;
  // Pull credentials for the image this session boots — the SAME seam the dispatch lane uses
  // (`buildImagePullAuths`: managed grants + BYO registries). Without it a session cannot boot an image from
  // our own registry, which is every world snapshot and every managed-store environment. Best-effort by
  // contract: no credential just means the pull is anonymous, and the registry says what it thinks of that.
  resolvePullAuths?: (tenant: string, imageRefs: string[]) => Promise<RegistryAuth[]>;
  // Agent worlds (W2): the workspace's git access, injected as a seam (apps/api binds the GitHub App service
  // behind it — peer services never call each other). Read and write are SEPARATE calls on purpose: a session
  // clones with a read credential and holds nothing, and a push mints a write credential at the moment of the
  // push. Nothing here is ever stored on the session — a token that outlives its command is a token that
  // travels inside a snapshot.
  git?: {
    // Read credential for a clone. `undefined` = no installation covers this repo → clone anonymously (a
    // public repo still works; a private one fails at git with the remote's own message).
    readToken(tenant: string, gitUrl: string): Promise<string | undefined>;
    // Write credential for a push, minted per call. Throws when no installation covers the repo.
    writeToken(tenant: string, gitUrl: string): Promise<string>;
    openPullRequest(
      tenant: string,
      gitUrl: string,
      input: { branch: string; title: string; body?: string },
    ): Promise<{ url: string; base: string }>;
  };
  publishWorldVersion?: (
    tenant: string,
    actor: { subject: string; isAdmin: boolean },
    world: string,
    input: { image: string; sessionRunId: string; name?: string; description?: string; instructions?: string },
  ) => Promise<{ version: string }>;
  // Retention (W3): drop the world's oldest snapshots past the operator's bound, image bytes included. A world
  // gains a version per hibernate and the registry has no GC, so autonomy without this is a disk that fills.
  // Best-effort AFTER a successful publish: pruning failure never fails the snapshot the caller is waiting on.
  // The PLACEMENT-INDEPENDENT capture (W4): the driver's own snapshot needs a daemon the control plane can
  // reach, which is true on this host and false for a session placed on a cluster. This seam takes the tar of
  // the session's work tree — read out over the same exec channel every placement already has — and publishes
  // it as one more layer on the image the session booted. Preferred order is `driver.snapshot` (cheaper: the
  // bytes never travel through the control plane) with this as the fallback, so a deployment that has neither
  // is refused at CREATE rather than hours later.
  publishLayerSnapshot?: (input: {
    tenant: string;
    world: string;
    tag: string;
    baseReference: string;
    baseImage: string; // the FULL ref the session booted — founding a world copies it into the world's repository
    layerGzip: Buffer;
    createdBy: string;
  }) => Promise<{ digest: string }>;
  pruneWorldVersions?: (
    tenant: string,
    actor: { subject: string; isAdmin: boolean },
    world: string,
  ) => Promise<{ prunedVersions: string[] }>;
  defaultTtlSec?: number;
  maxTtlSec?: number;
  maxPerTenant?: number; // undefined = unlimited (dev); production sets both
  // W3: how many live sessions ONE agent may hold (default 1). Bounds an autonomous loop against itself;
  // the per-tenant cap additionally keeps its last slot for a member.
  maxPerAgent?: number;
  // W4: the ceiling on a placement-independent capture (compressed bytes). Past it the snapshot is refused by
  // name — a truncated capture would publish an image that boots missing files.
  maxCaptureBytes?: number;
  // Resolve the compute for a session placed on a workspace-REGISTERED runtime (W4). `driver` above stays the
  // deployment default; this answers "this tenant's own cluster". Returning undefined means the tenant has no
  // such runtime, which is a 404 naming it — never a silent fall back to the default, because that would run a
  // tenant's code somewhere they did not choose.
  driverFor?: (tenant: string, runtime: string) => Promise<Driver | undefined>;
  maxTotal?: number;
  // The front-door conversation pool's own caps (the "frontdoor" trigger) — a warm-topology slot is a
  // different scarcity than a control-plane container, so the pools never share caps.
  frontdoorMaxPerTenant?: number;
  frontdoorMaxTotal?: number;
  newId?: () => string;
  now?: () => string;
}

export class SandboxSessionService {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly taskRunner: SessionTaskRunner;
  private readonly frontdoorRunner: FrontDoorTurnRunner;

  constructor(private readonly deps: SandboxSessionServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
    const runnerDeps = {
      store: deps.store,
      ...(deps.trajectories !== undefined ? { trajectories: deps.trajectories } : {}),
      ...(deps.events !== undefined ? { events: deps.events } : {}),
      ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
      ...(deps.usage !== undefined ? { usage: deps.usage } : {}),
      newId: this.newId,
      now: this.now,
    };
    this.taskRunner = new SessionTaskRunner(runnerDeps);
    this.frontdoorRunner = new FrontDoorTurnRunner(runnerDeps);
  }

  // The compute a session runs on: the workspace's OWN registered runtime when it named one, else the
  // deployment default. A named-but-missing runtime is a 404 that says so — never a quiet fallback to the
  // default, which would place a tenant's code somewhere they did not choose.
  private async driverFor(tenant: string, runtime: string | undefined): Promise<Driver> {
    if (runtime === undefined) {
      if (!this.deps.driver)
        throw new BadRequestError(
          "BAD_REQUEST",
          {},
          "This deployment has no default sandbox compute — name a runtime this workspace registered.",
        );
      return this.deps.driver;
    }
    const resolved = this.deps.driverFor ? await this.deps.driverFor(tenant, runtime) : undefined;
    if (!resolved)
      throw new NotFoundError(
        "NOT_FOUND",
        { runtime },
        `No runtime '${runtime}' this workspace can place a session on (register it, or omit runtime to use the default compute).`,
      );
    return resolved;
  }

  // Boot a session: capacity → resolve the image → provision → ONLY THEN the ledger record (born running,
  // run.submitted fact via the E0 outbox). The id is minted before the record so the map and the row agree.
  async create(rawInput: CreateSandboxInput): Promise<RunRecord> {
    let input = rawInput;

    // ── DELEGATE AN ISSUE ────────────────────────────────────────────────────────────────────────
    //
    // Name the issue; the brief is assembled from what the tracker already holds. Before this, delegating an
    // issue meant typing the issue back out, and the parts most likely to be dropped were the ones hardest
    // to notice missing — the knowledge from a previous attempt, and the checks somebody would apply.
    if (input.issueId !== undefined) {
      if (input.brief !== undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { issue: input.issueId },
          "Give an issue OR a brief, not both — an assembled brief and a typed one are two answers to the " +
            "same question, and there is no rule for choosing between them.",
        );
      if (input.profile === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { issue: input.issueId },
          "Delegating an issue needs a `profile` — the brief says what to do, the profile says who does it.",
        );
      if (!this.deps.issueBriefSource)
        throw new BadRequestError("BAD_REQUEST", {}, "Delegating an issue is not configured on this deployment.");
      const source = await this.deps.issueBriefSource.read(input.tenant, input.issueId);
      if (!source)
        throw new NotFoundError(
          "NOT_FOUND",
          { issue: input.issueId },
          `No issue '${input.issueId}' this workspace can read.`,
        );
      input = {
        ...input,
        brief: issueDelegationBrief({
          ...source,
          ...(input.extraChecks !== undefined ? { extraChecks: input.extraChecks } : {}),
        }),
      };
    }

    let campaignGrant: Awaited<ReturnType<CampaignService["issueEvidenceGrant"]>> | undefined;
    if (input.campaignId !== undefined) {
      if (!input.profile || input.brief || input.world || input.hibernate)
        throw new BadRequestError(
          "BAD_REQUEST",
          {},
          "A campaign delegate requires a profile and platform-authored context; custom briefs and persistent worlds are not permitted.",
        );
      if (!this.deps.campaigns)
        throw new BadRequestError("BAD_REQUEST", {}, "Campaign evidence grants are not configured.");
      campaignGrant = await this.deps.campaigns.issueEvidenceGrant(input.tenant, input.campaignId);
      input = {
        ...input,
        ttlSec: Math.min(input.ttlSec ?? 900, 3600),
        brief: {
          goal: "Propose a candidate improvement using the permitted target evidence.",
          context: JSON.stringify(campaignGrant.view),
          references: [],
          doneWhen: [
            {
              id: "proposal-returned",
              statement: "Return the proposed change and its rationale to the orchestrator.",
            },
          ],
          constraints: [
            "Read campaign evidence with the credential in CAMPAIGN_EVIDENCE.json. It expires after one hour.",
            "Keep evaluation and adoption with the orchestrator. Workspace credentials must not be passed to this delegate.",
          ],
        },
      };
    }
    this.sweep();
    // A kind:"service" harness ref routes to the front-door conversation branch (a warm topology on a
    // workspace runtime, driven over HTTP). Resolution is a read — no slot, no compute — so probing it before
    // the capacity gate is safe, and it is what lets each branch enforce ITS OWN pool.
    if (input.harness && this.deps.resolveServiceConversation) {
      const resolved = await this.deps.resolveServiceConversation(
        input.tenant,
        input.createdBy,
        {
          id: input.harness.id,
          ...(input.harness.version !== undefined ? { version: input.harness.version } : {}),
        },
        { ...(input.runtime !== undefined ? { runtime: input.runtime } : {}) },
      );
      if (resolved) return this.createFrontdoorSession(input, resolved);
    }
    await this.enforceCapacity(input.tenant, input.agent);
    // The singular gate (§5.1 order), before any compute is taken: caused work draws from its causer's
    // envelope and answers the depth / in-flight guards, then the tenant's own budget. A session that an
    // agent opens used to answer neither — an agent loop could hold sessions open spending against nobody.
    const causedByRunId = input.agent?.runId;
    // The session record id is minted BEFORE the gate and doubles as the admission's request identity (H6)
    // — a re-admission of this same session creation is the same right, never a second charge.
    const sessionRunId = this.newId();
    const envelope = causedByRunId
      ? await admitCausedWork(
          {
            runStore: this.deps.store,
            ...(this.deps.envelopes ? { envelopes: this.deps.envelopes } : {}),
            ...(this.deps.events ? { events: this.deps.events } : {}),
            ...(this.deps.admissionMaxInFlight !== undefined ? { maxInFlight: this.deps.admissionMaxInFlight } : {}),
          },
          input.tenant,
          causedByRunId,
          1,
          { requestId: `adm:session:${sessionRunId}` },
        )
      : undefined;
    this.deps.budget?.admit(input.tenant); // 402 past the tenant cap — before a container exists
    let resolved: Awaited<ReturnType<SandboxSessionService["resolveTarget"]>>;
    let registryAuths: RegistryAuth[] | undefined;
    let driver: Driver;
    try {
      resolved = await this.resolveTarget(input);
      registryAuths = await this.deps.resolvePullAuths?.(input.tenant, [resolved.image]).catch(() => []);
      driver = await this.driverFor(input.tenant, input.runtime);
    } catch (err) {
      // Regression (found alongside the conversation refusal): a post-admit resolution failure — unknown
      // harness/runtime, a refused conversation — used to leak the budget reservation it had just taken.
      this.deps.budget?.release(input.tenant);
      throw err;
    }
    // A delegation profile carries its own default budget — the caller's explicit ttlSec still wins.
    const ttlSec = Math.min(
      input.ttlSec ?? resolved.delegation?.ttlSec ?? this.deps.defaultTtlSec ?? DEFAULT_TTL_SEC,
      this.maxTtl(),
    );
    let handle: ComputeHandle;
    try {
      handle = await driver.provision({
        os: "linux",
        image: resolved.image,
        needs: ["shell"],
        // WHOSE session this is — a driver that places on shared infrastructure resolves the tenant's trust
        // zone from it; a host-local driver ignores it.
        tenant: input.tenant,
        ...(registryAuths !== undefined && registryAuths.length > 0 ? { registryAuths } : {}),
        // The delegation profile's network policy, when it declared one — the box the delegate runs in, decided
        // by the profile the workspace registered rather than by whatever the lane defaults to.
        ...(resolved.delegation?.network !== undefined ? { network: resolved.delegation.network } : {}),
      });
    } catch (err) {
      this.deps.budget?.release(input.tenant); // the admit reservation must not leak on a failed provision
      if (err instanceof BadRequestError) throw err;
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { image: resolved.image },
        `Could not start '${resolved.image}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      // Warm install BEFORE the record exists (the provision-before-record rule, extended): a harness whose
      // install fails leaves no row and no leaked container — the thrown error is the whole story.
      const delegation = resolved.delegation;
      if (resolved.playground) {
        try {
          await handle.exec(`mkdir -p ${shq(delegation?.workDir ?? "work")}`);
          await resolved.playground.harness.install(handle);
        } catch (err) {
          throw new UpstreamError(
            "HARNESS_INSTALL_FAILED",
            { harness: resolved.harness.id, image: resolved.image },
            `Could not install '${resolved.harness.id}' into the session: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // WHO THE CLI RUNS AS. Resolved once the container exists and before any turn, because a delegate that
      // starts logged out fails at its first call — far from the person who could have registered an identity.
      //
      // The files land under the container's own $HOME, asked for rather than assumed: the paths a CLI reads
      // are relative to it, and an image that runs as someone other than root would otherwise get its identity
      // written into a directory nobody reads. They are also OUTSIDE `workDir` by construction, which matters
      // here specifically — `cloneRepo` below does `rm -rf <workDir>`, and that is how a delegation's brief
      // gets destroyed when a repo is cloned into the same directory.
      const identity = delegation !== undefined ? await this.resolveIdentity(input, delegation) : undefined;
      if (delegation !== undefined && identity !== undefined && identity.kind !== "none") {
        const home = (await handle.exec('printf %s "$HOME"')).stdout.trim() || "/root";
        try {
          for (const file of identity.identity.home) await handle.writeFile(`${home}/${file.path}`, file.content);
        } catch (err) {
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { identity: identity.identity.ref.id },
            `Could not reproduce the identity's files in the session: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // The identity WINS over the flat auth-env tiers. Registering one is how a member says "this account,
        // mine" — a workspace secret outranking it is the precedence this whole record exists to replace.
        delegation.harness.apiKeyEnv = { ...delegation.harness.apiKeyEnv, ...identity.identity.env };
      }
      // Clone BEFORE the delegation context is seeded — the ORDER is the fix (2026-09-17).
      //
      // `cloneRepo` runs `rm -rf <dir> && git clone … <dir>`, and both default to "work": the profile's
      // `workDir` and `DEFAULT_REPO_DIR` are the same directory. Seeding first therefore wrote CLAUDE.md and
      // BRIEF.md and then deleted them, while the trajectory went on recording `seededTo: work/BRIEF.md`. A
      // delegate handed a repository received no goal, no constraints and no standing instructions, and the
      // delegator found out from an answer that did not match the job.
      //
      // Measured both ways on a live session: profile alone → work/ held BRIEF.md + CLAUDE.md; profile + repo →
      // work/ held .git and README and neither file.
      const repo = input.repo !== undefined ? await this.cloneRepo(input.tenant, handle, input.repo) : undefined;

      // The delegation's CONTEXT, seeded before the record for the same reason the install is: a delegate that
      // silently never received its brief is a failure the delegator would only discover from the answer.
      const briefMarkdown = input.brief !== undefined ? renderDelegationBrief(input.brief) : undefined;
      if (delegation) {
        try {
          await handle.writeFile(`${delegation.workDir}/${delegation.instructionsFile}`, delegation.instructions);
          if (campaignGrant)
            await handle.writeFile(
              `${delegation.workDir}/CAMPAIGN_EVIDENCE.json`,
              JSON.stringify({
                token: campaignGrant.token,
                campaignId: campaignGrant.campaignId,
                expiresAt: campaignGrant.expiresAt,
                path: `/campaigns/${encodeURIComponent(campaignGrant.campaignId)}/evidence-view`,
              }),
            );
          if (briefMarkdown !== undefined) await handle.writeFile(`${delegation.workDir}/BRIEF.md`, briefMarkdown);
        } catch (err) {
          throw new UpstreamError(
            "UPSTREAM_ERROR",
            { profile: delegation.ref.id },
            `Could not seed the delegation context into the session: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const hibernate = resolved.world !== undefined ? (input.hibernate ?? true) : false;
      // A delegation is a conversation by definition — you do not hand work over one message at a time.
      const conversation =
        delegation !== undefined || (resolved.playground !== undefined && input.harness?.conversation === true);
      const record = Run.newSandboxSession({
        id: sessionRunId,
        tenant: input.tenant,
        ...(causedByRunId !== undefined
          ? { origin: { cause: "member" as const, actor: input.createdBy, causedByRunId } }
          : {}),
        ...(envelope !== undefined ? { envelope } : {}),
        harness: resolved.harness,
        image: resolved.image,
        ttlSec,
        createdBy: input.createdBy,
        ...(handle.id !== undefined ? { computeId: handle.id } : {}),
        ...(resolved.world !== undefined ? { world: resolved.world, hibernate } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(resolved.playground ? { attach: ["exec" as const, "tasks" as const] } : {}),
        ...(conversation ? { conversation: true } : {}),
        now: this.now(),
      });
      const stamped = stampFacts(input.tenant, attributed(Run.creationFacts(record), input.agent), {
        newId: this.newId,
        now: this.now,
      });
      await this.deps.store.create(
        record,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      this.sessions.set(record.id, {
        handle,
        tenant: input.tenant,
        createdBy: input.createdBy,
        label: record.harness.id,
        bootImage: resolved.image,
        driver,
        ...(resolved.world !== undefined ? { world: resolved.world } : {}),
        hibernate,
        ...(repo !== undefined ? { repo } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        expiresAtMs: new Date(this.now()).getTime() + ttlSec * 1000,
        trace: [
          // M3 — the sandbox's infra-plane record: the driver container identity, so the sealed trajectory says
          // WHERE this session physically ran (the sandbox twin of the backend's placement record).
          {
            t: 0,
            kind: "infra",
            scope: "placement",
            event: "provisioned",
            message: `sandbox container${handle.id !== undefined ? ` ${handle.id}` : ""} (image ${resolved.image})`,
            ...(handle.id !== undefined ? { unit: handle.id } : {}),
            at: this.now(),
          },
          {
            t: 0,
            kind: "env_action",
            action: "session.start",
            detail: {
              image: resolved.image,
              ttlSec,
              ...(resolved.world !== undefined ? { world: resolved.world } : {}),
              ...(repo !== undefined ? { repo: repo.git, dir: repo.dir } : {}),
              ...(resolved.playground ? { harness: `${resolved.harness.id}@${resolved.harness.version}` } : {}),
              ...(conversation ? { conversation: true } : {}),
              ...(delegation
                ? { profile: `${delegation.ref.source}/${delegation.ref.id}@${delegation.ref.version}` }
                : {}),
            },
          },
          // ⚠️ WHO THE DELEGATE RUNS AS, on the ledger — because it is otherwise unobservable. The identity's
          // env is merged into the HARNESS's environment, not the container's, so `sandbox_exec` and
          // `printenv` cannot see it (correctly: a credential in the process environment is broader exposure
          // than the CLI needs). That left a supervisor unable to tell "running as my account" from "running
          // as nobody" — the two produce identical sessions until the first call fails, far from the person
          // who could have registered an identity.
          //
          // Measured while wiring the credential, 2026-09-17: proving the token had arrived took booting a
          // session, running a turn, and reading a 401 out of the harness trace. The marker names the
          // identity and NEVER its value — `env` is the list of variable NAMES it set.
          ...(delegation !== undefined
            ? [
                {
                  t: 0,
                  kind: "env_action" as const,
                  action: "delegation.identity",
                  detail:
                    identity === undefined || identity.kind === "none"
                      ? { resolved: false, reason: "no CLI identity registered for this delegate" }
                      : {
                          resolved: true,
                          // `mine` = the submitter's own, resolved implicitly; `explicit` = one the caller named.
                          how: identity.kind,
                          identity: identity.identity.ref,
                          env: Object.keys(identity.identity.env),
                          files: identity.identity.home.map((f) => f.path),
                        },
                },
              ]
            : []),
          // The handoff, on the ledger: WHAT this delegate was actually asked to do, in the same rendering it
          // received as a file. Member-authored text — the profile's resolved env/secrets never come here.
          ...(delegation !== undefined && briefMarkdown !== undefined
            ? [
                {
                  t: 0,
                  kind: "env_action" as const,
                  action: "delegation.brief",
                  detail: {
                    profile: `${delegation.ref.source}/${delegation.ref.id}@${delegation.ref.version}`,
                    seededTo: `${delegation.workDir}/BRIEF.md`,
                    brief: briefMarkdown,
                  },
                },
              ]
            : []),
        ],
        t: 1,
        execCount: 0,
        ...(resolved.playground
          ? {
              playground: {
                resolved: resolved.playground,
                taskSeq: 0,
                tasks: [],
                mailbox: [],
                state: { status: "pending_init" },
                ...(conversation ? { conversation: { threadSeq: 1 } } : {}),
                ...(delegation !== undefined
                  ? { delegation: { ref: delegation.ref, workDir: delegation.workDir } }
                  : {}),
              },
            }
          : {}),
      });
      // Durable expiry (T-b): best-effort — a Temporal outage never blocks the session (the in-process
      // sweep still bounds the TTL while this process lives). Best-effort is not silent: a session whose
      // durable timer failed to arm is one crash away from a permanent `running` row, so the failure is
      // logged by name (the orphan sweep is the safety net that then ends it at deadline + grace).
      if (record.session !== undefined) {
        const expiresAt = record.session.expiresAt;
        void this.deps.reaper?.start({ runId: record.id, tenant: input.tenant, expiresAt }).catch((err) => {
          console.warn(
            `[sandbox] durable reaper start failed for session ${record.id} (in-process sweep + orphan sweep still bound the TTL): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return record;
    } catch (err) {
      await handle.dispose().catch(() => undefined); // no record → no leak either
      throw err;
    }
  }

  // Boot a front-door CONVERSATION session (a kind:"service" harness on a workspace runtime): its own
  // capacity pool → the same admission spine (caused-work gate → budget) → boot the conversation (warm
  // topology + optional per-session target = the provision-before-record step) → ONLY THEN the ledger
  // record. No container, no computeId — the crash-path reaper settles row-only, and the warm topology's
  // lifecycle stays the cluster idle TTL's.
  private async createFrontdoorSession(
    input: CreateSandboxInput,
    resolved: ResolvedServiceConversation,
  ): Promise<RunRecord> {
    if (input.runtime === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { harness: resolved.harness.id },
        "A service-topology harness session runs on a registered runtime — provide `runtime`.",
      );
    if (input.world !== undefined || input.repo !== undefined || input.hibernate !== undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { harness: resolved.harness.id },
        "A service-harness conversation has no container — world, repo and hibernate do not apply.",
      );
    await this.enforceCapacity(input.tenant, input.agent, {
      trigger: FRONTDOOR_TRIGGER,
      ...(this.deps.frontdoorMaxPerTenant !== undefined ? { maxPerTenant: this.deps.frontdoorMaxPerTenant } : {}),
      ...(this.deps.frontdoorMaxTotal !== undefined ? { maxTotal: this.deps.frontdoorMaxTotal } : {}),
    });
    const causedByRunId = input.agent?.runId;
    // Same H6 discipline as the sandbox path: the record id IS the admission's request identity.
    const id = this.newId();
    const envelope = causedByRunId
      ? await admitCausedWork(
          {
            runStore: this.deps.store,
            ...(this.deps.envelopes ? { envelopes: this.deps.envelopes } : {}),
            ...(this.deps.events ? { events: this.deps.events } : {}),
            ...(this.deps.admissionMaxInFlight !== undefined ? { maxInFlight: this.deps.admissionMaxInFlight } : {}),
          },
          input.tenant,
          causedByRunId,
          1,
          { requestId: `adm:session:${id}` },
        )
      : undefined;
    this.deps.budget?.admit(input.tenant); // 402 past the tenant cap — before any topology work
    const ttlSec = Math.min(input.ttlSec ?? this.deps.defaultTtlSec ?? DEFAULT_TTL_SEC, this.maxTtl());
    const conversation = resolved.open(id);
    let booted: { frontDoorBase: string; cdpBase?: string };
    try {
      booted = await conversation.boot(); // the provision-before-record step: a failed boot leaves no row
    } catch (err) {
      this.deps.budget?.release(input.tenant);
      await conversation.close().catch(() => undefined); // a half-acquired target must not leak
      throw err;
    }
    try {
      const image = resolved.frontDoorImage ?? `${resolved.harness.id}@${resolved.harness.version}`;
      const record = Run.newSandboxSession({
        id,
        tenant: input.tenant,
        ...(causedByRunId !== undefined
          ? { origin: { cause: "member" as const, actor: input.createdBy, causedByRunId } }
          : {}),
        ...(envelope !== undefined ? { envelope } : {}),
        harness: resolved.harness,
        image,
        ttlSec,
        createdBy: input.createdBy,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        runtime: input.runtime,
        trigger: FRONTDOOR_TRIGGER,
        conversation: true,
        attach: ["tasks"],
        now: this.now(),
      });
      const stamped = stampFacts(input.tenant, attributed(Run.creationFacts(record), input.agent), {
        newId: this.newId,
        now: this.now,
      });
      await this.deps.store.create(
        record,
        stamped.map((f) => f.record),
      );
      if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
      this.sessions.set(record.id, {
        tenant: input.tenant,
        createdBy: input.createdBy,
        label: record.harness.id,
        hibernate: false,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        expiresAtMs: new Date(this.now()).getTime() + ttlSec * 1000,
        trace: [
          {
            t: 0,
            kind: "infra",
            scope: "placement",
            event: "provisioned",
            message: `front-door conversation on runtime ${input.runtime} (${booted.frontDoorBase})`,
            at: this.now(),
          },
          {
            t: 0,
            kind: "env_action",
            action: "session.start",
            detail: {
              harness: `${resolved.harness.id}@${resolved.harness.version}`,
              runtime: input.runtime,
              conversation: true,
              ...(booted.cdpBase !== undefined ? { cdpBase: booted.cdpBase } : {}),
            },
          },
        ],
        t: 1,
        execCount: 0,
        frontdoor: { resolved, conversation, runtime: input.runtime, taskSeq: 0, tasks: [] },
      });
      if (record.session !== undefined) {
        const expiresAt = record.session.expiresAt;
        void this.deps.reaper?.start({ runId: record.id, tenant: input.tenant, expiresAt }).catch((err) => {
          console.warn(
            `[sandbox] durable reaper start failed for session ${record.id} (in-process sweep + orphan sweep still bound the TTL): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return record;
    } catch (err) {
      await conversation.close().catch(() => undefined); // no record → the held target must not leak
      throw err;
    }
  }

  // Exec into the live session. Attach is not a read: creator-or-admin, checked BEFORE anything runs.
  // Every exec lands on the session's trajectory (the evidence a judge or a teammate later reads).
  async exec(
    actor: SandboxActor,
    runId: string,
    input: { command: string; timeoutSec?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can exec.");
    const handle = live.handle;
    if (!handle)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session is a service-harness conversation — it has no container to exec into.",
      );
    if (typeof input.command !== "string" || input.command.trim() === "")
      throw new BadRequestError("BAD_REQUEST", {}, "command is required.");
    const timeoutSec = Math.min(input.timeoutSec ?? DEFAULT_EXEC_TIMEOUT_SEC, MAX_EXEC_TIMEOUT_SEC);
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await handle.exec(input.command, { timeoutSec });
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: runId },
        `exec failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const id = `exec-${++live.execCount}`;
    live.trace.push({ t: live.t++, kind: "tool_call", id, name: "exec", args: { command: input.command } });
    live.trace.push({
      t: live.t++,
      kind: "tool_result",
      id,
      ok: result.exitCode === 0,
      output: clamp(`${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`),
    });
    return result;
  }

  // Agent worlds (W1): publish this session's filesystem as the world's next snapshot — an image in the
  // managed store plus a new environment-capability version pinned to its digest. Creator-or-admin; refused
  // while a playground task runs (a mid-task capture is a half-written world, a foot-gun not a feature).
  async snapshot(
    actor: SandboxActor,
    runId: string,
    input: { name?: string; description?: string; instructions?: string } = {},
  ): Promise<WorldSnapshotResult> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can snapshot.");
    if (live.playground?.active)
      throw new ConflictError(
        "CONFLICT",
        { run: runId, activeRun: live.playground.active.runId },
        "A test case is running in this session — snapshot after it finishes.",
      );
    return this.snapshotLive(runId, live, { subject: actor.subject, isAdmin: actor.isAdmin }, input);
  }

  // Agent worlds (W2): push the session's working tree to its remote, optionally opening a pull request.
  // The credential is minted HERE, used for this one command, and discarded — it is never stored on the
  // session and never enters an image. Committing stays the caller's job through exec (it needs no
  // credential); the one thing a container cannot do for itself is authenticate.
  async gitPush(
    actor: SandboxActor,
    runId: string,
    input: { dir?: string; branch?: string; remote?: string; pullRequest?: { title: string; body?: string } },
  ): Promise<{ branch: string; remote: string; pushed: string; pullRequest?: { url: string; base: string } }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can push.");
    const handle = live.handle;
    if (!handle)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session is a service-harness conversation — it has no working tree to push from.",
      );
    const git = this.deps.git;
    if (!git) throw new BadRequestError("BAD_REQUEST", {}, "Git access is not configured for this deployment.");
    const dir = input.dir ?? live.repo?.dir ?? DEFAULT_REPO_DIR;
    const remote = input.remote ?? "origin";
    // The remote URL comes from the CONTAINER, not from the create-time record: the working tree is the truth
    // about what is being pushed, and a session may have cloned or re-pointed a second repo through exec.
    const remoteUrl = (await handle.exec(`git remote get-url ${shq(remote)}`, { cwd: dir })).stdout.trim();
    if (remoteUrl === "")
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId, dir, remote },
        `No git remote '${remote}' in '${dir}' — clone a repository into the session first.`,
      );
    const branch = input.branch ?? (await handle.exec("git rev-parse --abbrev-ref HEAD", { cwd: dir })).stdout.trim();
    if (branch === "" || branch === "HEAD")
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId, dir },
        "The working tree is on no branch (detached HEAD) — name a branch to push.",
      );
    const token = await git.writeToken(actor.tenant, remoteUrl);
    const push = await handle.exec(`git push ${shq(remote)} HEAD:refs/heads/${shq(branch)}`, {
      cwd: dir,
      env: gitAuthEnv(token, remoteUrl),
      timeoutSec: GIT_TIMEOUT_SEC,
    });
    if (push.exitCode !== 0)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: runId, branch },
        `git push failed: ${clamp(push.stderr || push.stdout)}`,
      );
    const pullRequest = input.pullRequest
      ? await git.openPullRequest(actor.tenant, remoteUrl, { branch, ...input.pullRequest })
      : undefined;
    // Evidence, never the credential: what was pushed and where, on the session's own trajectory.
    live.trace.push({
      t: live.t++,
      kind: "env_action",
      action: "git.push",
      detail: { remote: remoteUrl, branch, ...(pullRequest ? { pullRequest: pullRequest.url } : {}) },
    });
    return {
      branch,
      remote: remoteUrl,
      pushed: push.stderr.trim() || push.stdout.trim(),
      ...(pullRequest !== undefined ? { pullRequest } : {}),
    };
  }

  // Keep-alive (touch): push the session's hard deadline out to now+ttl (never in — extendSession's max
  // rule), in all three places it lives: process memory, the row, and the durable reaper's timer.
  async touch(actor: SandboxActor, runId: string, input: { ttlSec?: number } = {}): Promise<{ expiresAt: string }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can touch it.");
    const ttlSec = Math.min(input.ttlSec ?? this.deps.defaultTtlSec ?? DEFAULT_TTL_SEC, this.maxTtl());
    live.expiresAtMs = Math.max(live.expiresAtMs, new Date(this.now()).getTime() + ttlSec * 1000);
    let expiresAt = new Date(live.expiresAtMs).toISOString();
    const current = await this.deps.store.get(runId);
    if (current) {
      const transition = Run.from(current).extendSession(ttlSec, this.now());
      // Under the settle CAS: extending a session another process closed between the read and this write
      // would re-open a settled row (arch-review 27's guard found this one).
      await this.deps.store.update(runId, transition.patch, [], { expectNonTerminal: true });
      const patched = transition.patch.session;
      if (patched?.expiresAt !== undefined) expiresAt = patched.expiresAt;
    }
    // Re-arm the durable deadline — best-effort like start/signalClosed. A missed extend leaves the OLD
    // timer armed; reap() guards against exactly that by re-checking the authoritative deadline before
    // tearing anything down, so a stale timer fires a no-op, never an early teardown.
    void this.deps.reaper?.extend?.({ runId, tenant: live.tenant, expiresAt }).catch(() => {});
    live.trace.push({ t: live.t++, kind: "env_action", action: "session.touch", detail: { ttlSec, expiresAt } });
    return { expiresAt };
  }

  // Submit a test case into a live harness session (the playground). One task at a time per session: one
  // container workdir sequence, one warm toolchain — a second submit while one runs is a 409, not a queue.
  // The child run is born RUNNING on the ledger before the harness starts (its record is what the caller
  // monitors); the drive happens async — errors settle the child, never this call.
  // ── REACHING A DELEGATE ──────────────────────────────────────────────────────────────────────────
  //
  // `delivery` says what this does to the turn the delegate is in — `planDelivery` (domain) owns that
  // decision and this method executes it. Omitted it is `task`, which is what every existing caller meant.
  //
  // The outcome is a UNION rather than always a run, because two of the three modes deliberately start
  // nothing: a queued message has no child run to hand back, and returning a stale one (or `undefined` where
  // a record was promised) would make "I queued it" and "I started a turn" indistinguishable to the caller
  // that has to decide whether to poll.
  async submitTask(
    actor: SandboxActor,
    runId: string,
    input: { task: string; timeoutSec?: number; fresh?: boolean; delivery?: DelegateDeliveryMode },
  ): Promise<SandboxDeliveryOutcome> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can submit tasks.");
    if (live.frontdoor) {
      // The front-door lane has no mailbox and no delegate state — it is a service conversation, not a
      // supervised handoff. Its one mode is "start a turn", so a delivery it cannot honour is refused here
      // rather than silently downgraded to the one behaviour it has.
      if (input.delivery !== undefined && input.delivery !== "task")
        throw new BadRequestError(
          "BAD_REQUEST",
          { run: runId, delivery: input.delivery },
          `A front-door conversation has no mailbox — '${input.delivery}' applies to delegate sessions only.`,
        );
      return { delivered: "started", run: await this.submitTurn(actor, runId, live, live.frontdoor, input) };
    }
    const playground = live.playground;
    const handle = live.handle;
    if (!playground || !handle)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session has no harness — create it with harness:{id} to submit test cases.",
      );
    // An empty task is legitimate for exactly one caller: the settle hook draining a mailbox that already
    // holds queued work. Everywhere else it is a submit with nothing to say.
    if (
      typeof input.task !== "string" ||
      (input.task.trim() === "" && !playground.mailbox.some((m) => m.mode === "task"))
    )
      throw new BadRequestError("BAD_REQUEST", {}, "task is required.");
    const conversation = playground.conversation;
    if (input.fresh === true && conversation === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session runs independent test cases — fresh applies only to conversation sessions.",
      );
    // ⚠️ THIS REPLACES A FLAT 409. "A test case is already running — wait for it to finish" answered one
    // question ("is it busy?") for three different intentions, and answered all of them the most disruptive
    // way available: refuse, leaving the supervisor to choose between waiting and killing the container.
    const delivery = input.delivery ?? "task";
    const plan = planDelivery(playground.state, delivery);
    if (plan.kind === "queue") {
      const entry: QueuedDelivery = {
        id: `m-${playground.mailbox.length + 1}`,
        mode: delivery === "message" ? "message" : "task",
        text: input.task,
        at: this.now(),
        by: actor.subject,
      };
      playground.mailbox.push(entry);
      live.trace.push({
        t: live.t++,
        kind: "env_action",
        action: "delegate.queued",
        detail: { id: entry.id, mode: entry.mode, startsTurn: plan.startsTurn },
      });
      return { delivered: "queued", queued: playground.mailbox.length, state: playground.state };
    }
    if (plan.kind === "abortThenStart" && playground.active) {
      // Stop the turn and let the drive settle its child before the next one starts. Without the wait the new
      // turn races the old one's `finally`, and whichever lands second decides what `active` points at.
      const stopping = playground.active;
      stopping.abort.abort();
      playground.state = {
        status: "interrupted",
        at: this.now(),
        by: actor.subject,
        previous: interruptedFrom(playground.state),
      };
      await Promise.race([stopping.done, new Promise((r) => setTimeout(r, TEARDOWN_TASK_GRACE_MS))]);
    }
    this.deps.budget?.admit(actor.tenant); // 402 before any child record exists
    const timeoutSec = Math.min(input.timeoutSec ?? DEFAULT_TASK_TIMEOUT_SEC, MAX_TASK_TIMEOUT_SEC);
    // "Reset the chat, keep the environment": fresh drops the resume token (the next turn starts a new
    // provider thread) while the workdir — the files the conversation produced — deliberately stays.
    if (conversation !== undefined && input.fresh === true) {
      conversation.resume = undefined;
      conversation.threadSeq += 1;
    }
    // The mailbox rides along. Everything the supervisor said while the delegate was busy is delivered here,
    // in order, ahead of the message that starts this turn — which is the whole reason queuing beats refusing.
    const prompt = drainMailbox(playground.mailbox, input.task);
    playground.mailbox = [];
    const seq = ++playground.taskSeq;
    const caseId = conversation !== undefined ? `turn-${seq}` : `task-${seq}`;
    const id = this.newId();
    const record = Run.newSessionCase({
      id,
      tenant: actor.tenant,
      harness: { id: playground.resolved.id, version: playground.resolved.version },
      sessionRunId: runId,
      caseId,
      task: prompt,
      timeoutSec,
      createdBy: actor.subject,
      ...(conversation !== undefined ? { role: "turn" as const } : {}),
      now: this.now(),
    });
    const stamped = stampFacts(actor.tenant, attributed(Run.creationFacts(record), actor.agent), {
      newId: this.newId,
      now: this.now,
    });
    try {
      await this.deps.store.create(
        record,
        stamped.map((f) => f.record),
      );
    } catch (err) {
      this.deps.budget?.release(actor.tenant); // the admit reservation must not leak on a failed create
      throw err;
    }
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    const entry: TaskEntry = {
      runId: id,
      caseId,
      task: prompt,
      submittedAt: this.now(),
      status: "running",
      events: [],
      ...(conversation !== undefined && input.fresh === true ? { fresh: true } : {}),
    };
    playground.tasks.push(entry);
    // The session's own trajectory keeps POINTERS (task boundaries), never the events — the child run owns its trace.
    live.trace.push({ t: live.t++, kind: "env_action", action: "task.start", detail: { run: id, caseId } });
    const abort = new AbortController();
    const done = (async () => {
      const status = await this.taskRunner.drive({
        tenant: actor.tenant,
        record,
        harness: playground.resolved.harness,
        // A conversation lives in ONE stable workdir (the harness keys its session store off the cwd —
        // per-task rebasing would break resume structurally); independent cases keep their tasks/<n>
        // isolation. A delegation runs where its context was seeded — the profile's own working directory.
        compute:
          playground.delegation !== undefined
            ? handle // the profile's workDir is already the adapter's cwd; scoping it again would move the delegate away from its brief
            : scopedComputeHandle(handle, conversation !== undefined ? "conversation" : `tasks/${seq}`),
        apiKeyEnv: playground.resolved.apiKeyEnv,
        task: prompt,
        timeoutSec,
        events: entry.events,
        signal: abort.signal,
        ...(conversation !== undefined
          ? {
              conversation: {
                ...(conversation.resume !== undefined ? { resume: conversation.resume } : {}),
                onToken: (token: string) => {
                  conversation.resume = token;
                },
              },
            }
          : {}),
      });
      entry.status = status;
      live.trace.push({ t: live.t++, kind: "env_action", action: "task.end", detail: { run: id, status } });
      // A turn that was ABORTED leaves the delegate `interrupted` — the state the interrupt already wrote.
      // Overwriting it with `completed` here would report a finish for a turn somebody stopped.
      if (playground.state.status !== "interrupted") {
        const report = await this.readDelegateReport(live, playground);
        // ⚠️ A REPORT WITH QUESTIONS IS NOT A FINISHED DELEGATE. It stopped on a decision it must not make
        // alone, and only an answer moves it. Distinguished here rather than left for a reader to notice,
        // because at scale "done" and "stuck on you" are opposite calls to action and look identical until
        // something separates them — a supervisor watching twenty delegates must not open twenty reports.
        playground.state =
          status !== "succeeded"
            ? { status: "errored", at: this.now(), message: `the turn settled ${status}` }
            : report !== undefined && report.questions.length > 0
              ? { status: "awaiting", at: this.now(), report }
              : { status: "completed", at: this.now(), ...(report ? { report } : {}) };
        if (report)
          live.trace.push({
            t: live.t++,
            kind: "env_action",
            action: "delegate.reported",
            detail: {
              run: id,
              answers: report.answers.length,
              blockers: report.blockers.length,
              // The questions travel on the ledger, not only in the live state: a supervisor reading back
              // afterwards needs to know the delegate stopped ASKING rather than stopped finishing.
              questions: report.questions.map((q) => q.id),
            },
          });
      }
    })()
      .catch((err: unknown) => {
        entry.status = "failed";
        if (playground.state.status !== "interrupted")
          playground.state = {
            status: "errored",
            at: this.now(),
            message: err instanceof Error ? err.message : String(err),
          };
      })
      .finally(() => {
        if (playground.active?.runId === id) playground.active = undefined;
        // A queued TASK is work the supervisor already handed over; the turn ending is its boundary. Messages
        // alone do not wake a delegate — they wait for the next task and ride along as context.
        if (playground.mailbox.some((m) => m.mode === "task"))
          void this.submitTask(actor, runId, { task: "", delivery: "task" }).catch(() => {
            // The auto-start is best-effort: a session closed between the settle and here is the ordinary
            // cause, and the queued text stays in the mailbox for whoever looks at the session next.
          });
      });
    playground.active = { runId: id, abort, done };
    playground.state = { status: "running", turnRunId: id, startedAt: this.now() };
    return { delivered: "started", run: record, state: playground.state };
  }

  // Submit one TURN into a live front-door conversation session — the service-harness twin of the playground
  // submit: same one-at-a-time 409, same budget admission, same child-run-as-monitoring-handle, but the drive
  // is a front-door HTTP turn (FrontDoorTurnRunner) instead of a container harness run, and the child records
  // its runtime placement (group role "turn").
  private async submitTurn(
    actor: SandboxActor,
    runId: string,
    live: LiveSession,
    frontdoor: FrontdoorState,
    input: { task: string; timeoutSec?: number; fresh?: boolean },
  ): Promise<RunRecord> {
    if (typeof input.task !== "string" || input.task.trim() === "")
      throw new BadRequestError("BAD_REQUEST", {}, "task is required.");
    if (input.fresh === true)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "A service conversation's thread is its session — open a new session to start over.",
      );
    if (frontdoor.active)
      throw new ConflictError(
        "CONFLICT",
        { run: runId, activeRun: frontdoor.active.runId },
        "A turn is already running in this session — wait for it to finish.",
      );
    this.deps.budget?.admit(actor.tenant); // 402 before any child record exists
    const timeoutSec = Math.min(input.timeoutSec ?? DEFAULT_TASK_TIMEOUT_SEC, MAX_TASK_TIMEOUT_SEC);
    const seq = ++frontdoor.taskSeq;
    const caseId = `turn-${seq}`;
    const id = this.newId();
    const record = Run.newSessionCase({
      id,
      tenant: actor.tenant,
      harness: frontdoor.resolved.harness,
      sessionRunId: runId,
      caseId,
      task: input.task,
      timeoutSec,
      createdBy: actor.subject,
      role: "turn",
      placement: { where: "runtime", target: frontdoor.runtime, isolation: "container" },
      now: this.now(),
    });
    const stamped = stampFacts(actor.tenant, attributed(Run.creationFacts(record), actor.agent), {
      newId: this.newId,
      now: this.now,
    });
    try {
      await this.deps.store.create(
        record,
        stamped.map((f) => f.record),
      );
    } catch (err) {
      this.deps.budget?.release(actor.tenant); // the admit reservation must not leak on a failed create
      throw err;
    }
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    const entry: TaskEntry = {
      runId: id,
      caseId,
      task: input.task,
      submittedAt: this.now(),
      status: "running",
      events: [],
    };
    frontdoor.tasks.push(entry);
    // The session's own trajectory keeps POINTERS (turn boundaries), never the events — the child run owns its trace.
    live.trace.push({ t: live.t++, kind: "env_action", action: "task.start", detail: { run: id, caseId } });
    const abort = new AbortController();
    const done = (async () => {
      const status = await this.frontdoorRunner.drive({
        tenant: actor.tenant,
        record,
        conversation: frontdoor.conversation,
        task: input.task,
        timeoutSec,
        events: entry.events,
        signal: abort.signal,
      });
      entry.status = status;
      live.trace.push({ t: live.t++, kind: "env_action", action: "task.end", detail: { run: id, status } });
    })()
      .catch(() => {
        entry.status = "failed";
      })
      .finally(() => {
        if (frontdoor.active?.runId === id) frontdoor.active = undefined;
      });
    frontdoor.active = { runId: id, abort, done };
    return record;
  }

  // The reattach surface: every session live in THIS process for the tenant (bounded by maxTotal — no
  // pagination). Historical sessions stay on /runs.
  // ── THE LEDGER ANSWERS, THE MAP ENRICHES ─────────────────────────────────────────────────────────
  //
  // ⚠️ THIS USED TO READ THE MAP ALONE, and the Map is process memory. Measured 2026-09-17: ten sandbox runs
  // in the `digo` ledger that day, `list_sandboxes` answering ZERO — four redeploys had emptied it. The
  // supervisor's one way to find what it had delegated reported an empty lane, and "no delegate is running"
  // and "this process forgot" rendered identically. That is the L2 collapse in the place a supervisor looks
  // first, and it is the same shape as a dead cron staying silent.
  //
  // So the ledger is the source of WHICH sessions exist and the Map is what enriches them — the merge
  // codex's own `AgentGraphStore` trait describes when it explains why its listings are stably ordered
  // ("so callers can merge persisted graph state with live in-memory state"). A row this process does not
  // hold is `orphaned`: its container died with whatever process owned it, so there is nothing to ask, and
  // saying so is not the same as claiming it ended cleanly.
  async listSessions(actor: SandboxActor): Promise<SandboxSessionView[]> {
    this.sweep();
    const rows = await this.deps.store.liveSessions({ tenant: actor.tenant });
    const views: SandboxSessionView[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const record = await this.deps.store.get(row.id);
      if (!record || record.tenant !== actor.tenant || record.kind !== "sandbox") continue;
      const live = this.sessions.get(row.id);
      views.push({
        record,
        live:
          live !== undefined
            ? this.liveView(live)
            : {
                // Not live HERE. Everything below is what the ledger alone can say; the delegate's state is
                // the third value rather than a guess in either direction.
                expiresAt: row.expiresAt ?? record.updatedAt,
                busy: false,
                conversation: false,
                delegate: {
                  status: "orphaned",
                  since: record.updatedAt,
                  cause: "this control plane does not hold the session — its container died with the process that did",
                },
                tasks: [],
              },
      });
    }
    // A session this process holds that the ledger's live query did not return — it settled between the two
    // reads, or the row was written by a path the query does not cover. Kept rather than dropped: the Map
    // holding a handle is itself evidence that something is running.
    for (const [id, live] of this.sessions) {
      if (live.tenant !== actor.tenant || seen.has(id)) continue;
      const record = await this.deps.store.get(id);
      if (record) views.push({ record, live: this.liveView(live) });
    }
    return views;
  }

  // Read one session: the ledger record always answers (settled sessions included); `live` only while this
  // process holds the handle.
  async getSession(actor: SandboxActor, runId: string): Promise<SandboxSessionView> {
    this.sweep();
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== actor.tenant || record.kind !== "sandbox")
      throw new NotFoundError("NOT_FOUND", { run: runId }, "Sandbox session not found.");
    const live = this.sessions.get(runId);
    return { record, ...(live !== undefined ? { live: this.liveView(live) } : {}) };
  }

  // One page of a task's trace since a cursor (the 2s poll). Live buffer first; after settle the sealed
  // trajectory serves the SAME events (a refresh mid-completion still answers). Tenant-scoped read — the
  // same visibility as GET /runs/:id/trajectory.
  // ── THE REPORT COMES BACK THE WAY THE BRIEF WENT IN ──────────────────────────────────────────────
  //
  // The brief lands in the delegate's working directory as a FILE, because a delegate that has to hold its
  // instructions in context loses them. The report leaves the same way, for the same reason and one more: the
  // delegate has no channel to this control plane at all (no tool surface, no credential), so a file in the
  // directory we already own is the only place it can put something we will reliably find.
  //
  // ⚠️ A MISSING OR MALFORMED REPORT IS NOT AN ERROR. A delegate may finish without filing one, and that is a
  // fact the supervisor needs — `completed` with no report reads as "it stopped without telling me what it
  // did", which is different from both "still running" and "it failed". Throwing here would turn a delegate's
  // omission into a failure of the turn it may well have completed.
  private async readDelegateReport(
    live: LiveSession,
    playground: PlaygroundState,
  ): Promise<DelegateReport | undefined> {
    const handle = live.handle;
    const dir = playground.delegation?.workDir;
    if (!handle || dir === undefined) return undefined;
    try {
      const path = `${dir}/${DELEGATE_REPORT_FILE}`;
      const read = await handle.exec(`cat ${JSON.stringify(path)} 2>/dev/null`);
      if (read.exitCode !== 0 || read.stdout.trim() === "") return undefined;
      const parsed = DelegateReportSchema.safeParse(JSON.parse(read.stdout));
      if (!parsed.success) {
        // The delegate TRIED to report and the file does not parse. That is worth recording where the
        // supervisor will see it — silently returning undefined would render as "it never reported".
        live.trace.push({
          t: live.t++,
          kind: "env_action",
          action: "delegate.report_unreadable",
          detail: { path, problem: parsed.error.issues[0]?.message ?? "does not match the report schema" },
        });
        return undefined;
      }
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  // ── STOP THE TURN, KEEP THE DELEGATE ─────────────────────────────────────────────────────────────
  //
  // Before this existed the only way to stop a delegate going the wrong way was `close_sandbox`, which killed
  // the container and every uncommitted change in it. So the cost of being wrong about "this is going badly"
  // was the whole session, and the rational move was to wait and watch it finish — which is not supervision.
  //
  // The machinery was already here: every turn holds an `AbortController` wired to the drive's signal, and
  // the only caller was teardown. This is the same abort with the container left standing.
  async interruptTask(actor: SandboxActor, runId: string, reason?: string): Promise<DelegateState> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can interrupt it.");
    const playground = live.playground;
    if (!playground)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session has no delegate to interrupt — it is a shell or a front-door conversation.",
      );
    // `interruptedFrom` refuses a delegate that has no turn to stop, and it keeps the ORIGINAL account when
    // something already interrupted is interrupted again.
    const previous = interruptedFrom(playground.state);
    const active = playground.active;
    playground.state = {
      status: "interrupted",
      at: this.now(),
      by: actor.subject,
      previous,
      ...(reason !== undefined ? { reason } : {}),
    };
    live.trace.push({
      t: live.t++,
      kind: "env_action",
      action: "delegate.interrupted",
      detail: { previous, ...(reason !== undefined ? { reason } : {}), ...(active ? { run: active.runId } : {}) },
    });
    if (active) {
      active.abort.abort();
      await Promise.race([active.done, new Promise((r) => setTimeout(r, TEARDOWN_TASK_GRACE_MS))]);
    }
    return playground.state;
  }

  async readTaskTrace(
    actor: SandboxActor,
    sessionRunId: string,
    taskRunId: string,
    since: number,
  ): Promise<SandboxTaskTrace> {
    this.sweep();
    const live = this.sessions.get(sessionRunId);
    if (live && live.tenant === actor.tenant) {
      const entry =
        live.playground?.tasks.find((t) => t.runId === taskRunId) ??
        live.frontdoor?.tasks.find((t) => t.runId === taskRunId);
      if (entry) {
        const events = entry.events.slice(since);
        return {
          status: entry.status,
          events,
          nextCursor: since + events.length,
          done: entry.status !== "running" && entry.status !== "queued",
        };
      }
    }
    // Sealed fallback: the child run must exist, belong to the tenant, and group to this session.
    const record = await this.deps.store.get(taskRunId);
    if (!record || record.tenant !== actor.tenant || record.group?.id !== sessionRunId)
      throw new NotFoundError("NOT_FOUND", { run: taskRunId }, "No such test case in this session.");
    // This reader was already a pager — `since` is its cursor — and it used to get its page by pulling the
    // WHOLE sealed trajectory and slicing. Now it asks for the window it wanted. `too_large` is left to
    // throw from the collector rather than caught into an empty page: a caller polling a task's output must
    // not be told "no more events" by a size limit.
    const page = await this.deps.trajectories?.events(actor.tenant, taskRunId, { after: since });
    const events = page?.kind === "page" ? page.page.events : (record.result?.trace ?? []).slice(since);
    return {
      status: record.status,
      events,
      nextCursor: since + events.length,
      done: Run.from(record).isTerminal(),
    };
  }

  private liveView(live: LiveSession): NonNullable<SandboxSessionView["live"]> {
    const summaries = (tasks: TaskEntry[]): SandboxTaskSummary[] =>
      tasks.map((t) => ({
        runId: t.runId,
        caseId: t.caseId,
        status: t.status,
        taskPreview: t.task.length > TASK_PREVIEW_CHARS ? `${t.task.slice(0, TASK_PREVIEW_CHARS)}…` : t.task,
        submittedAt: t.submittedAt,
        eventCount: t.events.length,
        ...(t.fresh === true ? { fresh: true } : {}),
      }));
    return {
      expiresAt: new Date(live.expiresAtMs).toISOString(),
      busy: (live.playground?.active ?? live.frontdoor?.active) !== undefined,
      // A front-door session is ALWAYS a conversation; a playground session is one when it booted that way.
      conversation: live.frontdoor !== undefined || live.playground?.conversation !== undefined,
      ...(live.playground !== undefined
        ? {
            harness: {
              id: live.playground.resolved.id,
              version: live.playground.resolved.version,
              kind: live.playground.resolved.kind,
            },
            ...(live.playground.delegation !== undefined ? { profile: live.playground.delegation.ref } : {}),
            // WHAT THE DELEGATE IS, not merely whether a promise is pending. `busy` above cannot distinguish
            // "finished and waiting for your review" from "you stopped it" from "it never started" — and
            // those are three different next moves for the supervisor.
            delegate: live.playground.state,
            mailbox: live.playground.mailbox.map((m) => ({ id: m.id, mode: m.mode, at: m.at, by: m.by })),
            tasks: summaries(live.playground.tasks),
          }
        : live.frontdoor !== undefined
          ? {
              harness: {
                id: live.frontdoor.resolved.harness.id,
                version: live.frontdoor.resolved.harness.version,
                kind: "service" as const,
              },
              tasks: summaries(live.frontdoor.tasks),
            }
          : { tasks: [] }),
    };
  }

  // Member close. Idempotent over an already-settled record; a running record with NO live handle here
  // (a control-plane restart) is adopted as "orphaned" — the row settles even though the container is gone
  // from our reach (the durable reaper rung makes that teardown crash-proof). `snapshot` overrides the
  // session's hibernate default for THIS teardown (close-without-saving, or save-a-non-hibernate-session).
  async close(actor: SandboxActor, runId: string, input: { snapshot?: boolean } = {}): Promise<RunRecord | undefined> {
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== actor.tenant || record.kind !== "sandbox")
      throw new NotFoundError("NOT_FOUND", { run: runId }, "Sandbox session not found.");
    if (record.createdBy && record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can close it.");
    const live = this.sessions.get(runId);
    if (!live) {
      if (Run.from(record).isTerminal()) return record;
      return this.settle(runId, record.tenant, "orphaned");
    }
    return this.teardown(runId, live, "closed", input);
  }

  // The durable reaper's teardown (T-b, called over the internal bridge when reaper:<runId> fires). Three
  // cases: a live handle here → the normal expiry teardown; a running row with NO handle → the crash case,
  // where the ROW still remembers enough (session.computeId → Driver.reap the stray container) and the
  // ledger settles as orphaned (the in-memory trajectory died with the old process — that loss is the
  // documented rung-1 cost); an already-settled row → the timer fired a no-op (close won the race).
  async reap(tenant: string, runId: string): Promise<{ reaped: boolean }> {
    const nowMs = new Date(this.now()).getTime();
    const live = this.sessions.get(runId);
    if (live && live.tenant === tenant) {
      // A touched session outlives the timer armed before the touch (extend is best-effort) — the deadline
      // HERE is authoritative, so a stale timer fires a no-op instead of tearing down live work.
      if (live.expiresAtMs > nowMs) return { reaped: false };
      await this.teardown(runId, live, "expired");
      return { reaped: true };
    }
    const record = await this.deps.store.get(runId);
    if (!record || record.tenant !== tenant || record.kind !== "sandbox") return { reaped: false };
    if (Run.from(record).isTerminal()) return { reaped: false };
    // Same stale-timer guard for the crash case — the row's deadline was touched too (extendSession).
    const rowExpiry = record.session?.expiresAt;
    if (rowExpiry !== undefined && new Date(rowExpiry).getTime() > nowMs) return { reaped: false };
    const computeId = record.session?.computeId;
    // Crash-path hibernate (W1): the row remembers enough (world + hibernate + computeId + creator) to
    // capture the orphan's filesystem BEFORE removing it — a control plane dying with the live handle no
    // longer costs the world its state. Best-effort: a snapshot failure still reaps (the leak would be worse).
    if (
      computeId !== undefined &&
      record.createdBy !== undefined &&
      record.session?.world !== undefined &&
      record.session.hibernate === true
    ) {
      await this.publishSnapshot({
        tenant,
        runId,
        world: record.session.world,
        computeId,
        actor: { subject: record.createdBy, isAdmin: false },
        ...(record.session.agent !== undefined ? { agent: record.session.agent } : {}),
      }).catch(() => undefined);
    }
    // Reap through the driver that PROVISIONED it: the row records where the session was placed, and a
    // default-driver reap would silently miss a container living on the workspace's own cluster.
    const orphanDriver = await this.driverFor(tenant, record.runtime).catch(() => undefined);
    if (computeId !== undefined && orphanDriver?.reap) await orphanDriver.reap(computeId).catch(() => undefined);
    await this.settle(runId, tenant, "orphaned", record.session?.agent);
    return { reaped: true };
  }

  // TTL sweep — called at the top of every public method and from the composition root's interval. The
  // in-process half of "the reaper is the finally"; the Temporal reaper rung survives this process dying.
  sweep(): void {
    const nowMs = new Date(this.now()).getTime();
    for (const [id, live] of this.sessions) {
      if (live.expiresAtMs <= nowMs) void this.teardown(id, live, "expired").catch(() => undefined);
    }
  }

  // The LEDGER half of the sweep — the safety net that ends the zombie class. A running session row whose
  // deadline has passed and whose handle this process does not hold is an orphan no matter HOW its timer was
  // lost: a durable reaper that never armed, a control plane that died with the handle, a row written by a
  // process where no reaper was wired at all. reap() re-checks everything (terminal, live handle, the row's
  // own deadline), so this scan is safe to run on an interval and at boot. The grace window exists for the
  // multi-writer reality this store already has: another live process may hold the handle and be tearing the
  // session down through its own sweep — give its normal close a head start before declaring the row orphaned.
  async sweepOrphans(): Promise<number> {
    const nowMs = new Date(this.now()).getTime();
    // Both pools this service owns: container sandboxes AND front-door conversation sessions — a crashed
    // writer's conversation row must settle exactly like a container one (its warm topology is the cluster
    // idle TTL's business; the row-only settle is the whole teardown).
    const rows = [
      ...(await this.deps.store.liveSessions({ trigger: SANDBOX_TRIGGER })),
      ...(await this.deps.store.liveSessions({ trigger: FRONTDOOR_TRIGGER })),
    ];
    let reaped = 0;
    for (const row of rows) {
      if (this.sessions.has(row.id)) continue; // live here — the in-process sweep owns its deadline
      if (row.expiresAt === undefined) continue; // no deadline on the row = nothing to judge it against
      if (Date.parse(row.expiresAt) + ORPHAN_GRACE_MS > nowMs) continue;
      const done = await this.reap(row.tenant, row.id).catch((err) => {
        console.warn(
          `[sandbox] orphan sweep could not reap session ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { reaped: false };
      });
      if (done.reaped) reaped += 1;
    }
    if (reaped > 0) console.warn(`[sandbox] orphan sweep settled ${reaped} session run(s) past their deadline`);
    return reaped;
  }

  liveCount(): number {
    return this.sessions.size;
  }

  // Clone a repository into a fresh session (W2). A read credential is resolved through the git seam and
  // reaches git through the environment only (never argv, never `.git/config` — a token written into the
  // clone's config would travel inside every later snapshot of this world). Full clone, not depth-1: this
  // tree is meant to be worked in and pushed from, and a shallow tree cannot do either well.
  private async cloneRepo(
    tenant: string,
    handle: ComputeHandle,
    repo: { git: string; ref?: string; dir?: string },
  ): Promise<{ git: string; ref?: string; dir: string }> {
    const dir = repo.dir ?? DEFAULT_REPO_DIR;
    // A FAILED read is not "this workspace has no installation for that owner" (protocol L2). The swallowing
    // catch that used to stand here collapsed both into `undefined`, so a private clone failed with git's own
    // `could not read Username for 'https://github.com'` — a message that names no link in the chain, over a
    // path where the App, the installation, the mint and the URL parse all verify individually. The absence is
    // still an answer (a public repo clones without a credential); the failure now says which step it was.
    const token = await this.deps.git?.readToken(tenant, repo.git).catch((err: unknown) => {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { repo: repo.git, step: "credential" },
        `Could not resolve a credential for '${repo.git}': ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const env = token !== undefined ? gitAuthEnv(token, repo.git) : {};
    // WHAT THE CREDENTIAL LOOKED LIKE, on the error and never in the clear. git's own message for a failed
    // clone is `could not read Username`, which is what it says whether the credential was absent, scoped to
    // the wrong prefix, or presented under a scheme the endpoint refuses — three different fixes behind one
    // sentence. It cost a full session to tell those apart from outside, so the refusal now carries the shape:
    // whether a token was resolved at all, and which config keys were handed to git. Never the value.
    const credential = {
      credentialResolved: token !== undefined,
      gitConfigKeys: Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG")),
      ...(env.GIT_CONFIG_KEY_0 !== undefined ? { credentialScope: env.GIT_CONFIG_KEY_0 } : {}),
      ...(env.GIT_CONFIG_VALUE_0 !== undefined
        ? { credentialScheme: env.GIT_CONFIG_VALUE_0.replace(/^Authorization: (\S+).*$/, "$1") }
        : {}),
    };
    const fail = (step: string, result: { stdout: string; stderr: string }): never => {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { repo: repo.git, step, ...credential },
        `Could not ${step} '${repo.git}': ${clamp(result.stderr || result.stdout)}`,
      );
    };
    // `git clone` INTO the directory, never `rm -rf` over it. The delete used to destroy whatever another step
    // had already put there — and with `workDir` and `DEFAULT_REPO_DIR` both defaulting to "work", the thing it
    // destroyed was the delegation's own brief and standing instructions. Cloning into an existing empty
    // directory is something git does; a non-empty one it REFUSES, which is the honest answer to "two steps
    // both think they own this directory" and far better than one of them silently winning.
    const cloned = await handle.exec(`mkdir -p ${shq(dir)} && git clone ${shq(repo.git)} ${shq(dir)}`, {
      env,
      timeoutSec: GIT_TIMEOUT_SEC,
    });
    if (cloned.exitCode !== 0) fail("clone", cloned);
    if (repo.ref !== undefined) {
      const checkout = await handle.exec(`git checkout ${shq(repo.ref)}`, {
        cwd: dir,
        env,
        timeoutSec: GIT_TIMEOUT_SEC,
      });
      if (checkout.exitCode !== 0) fail(`check out '${repo.ref}' in`, checkout);
    }
    // A committer identity, so `git commit` inside the session works without the caller discovering it doesn't.
    await handle
      .exec(
        `git config user.email ${shq(GIT_MACHINE_IDENTITY.email)} && git config user.name ${shq(GIT_MACHINE_IDENTITY.name)}`,
        { cwd: dir },
      )
      .catch(() => undefined);
    return { git: repo.git, ...(repo.ref !== undefined ? { ref: repo.ref } : {}), dir };
  }

  // The live-session snapshot path: the core publisher plus the trajectory record (the sealed evidence of
  // what this shell published).
  private async snapshotLive(
    runId: string,
    live: LiveSession,
    actor: { subject: string; isAdmin: boolean },
    input: { name?: string; description?: string; instructions?: string },
  ): Promise<WorldSnapshotResult> {
    const world = live.world;
    if (world === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session has no world — create it with world:{id} to snapshot.",
      );
    const handle = live.handle;
    const bootImage = live.bootImage;
    if (!handle || bootImage === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session holds no container — nothing to snapshot.",
      );
    const computeId = handle.id;
    if (computeId === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId },
        "This session's driver exposes no compute identity — snapshots need one.",
      );
    const result = await this.publishSnapshot({
      tenant: live.tenant,
      runId,
      world,
      computeId,
      actor,
      // The compute itself — the capture path reads through it, and it must survive teardown's map delete.
      compute: { handle, bootImage },
      ...(live.agent !== undefined ? { agent: live.agent } : {}),
      ...input,
    });
    live.trace.push({ t: live.t++, kind: "env_action", action: "session.snapshot", detail: { ...result } });
    return result;
  }

  // Capture the session's work tree over the exec channel and publish it as one more layer on the image the
  // session booted (W4). Base64 is the wire because it is the ONE encoding every exec transport agrees on —
  // docker exec, `nomad alloc exec`, `kubectl exec` — which is exactly what makes this path placement
  // independent. It costs a third more bytes and holds them in memory, so the capture is bounded and a tree
  // past the bound is REFUSED by name rather than silently truncated into an image that boots missing files.
  private async captureAsLayer(
    input: { tenant: string; runId: string; world: string; computeId: string },
    ctx: {
      tag: string;
      publishLayer: NonNullable<SandboxSessionServiceDeps["publishLayerSnapshot"]>;
      // The live compute, PASSED IN rather than looked up: teardown removes the session from the map before
      // it hibernates (so a concurrent close stays idempotent), and a capture that re-read the map would find
      // nothing exactly when hibernation matters most. A live drill found this the honest way — the cluster
      // session closed clean and published no snapshot at all.
      handle: ComputeHandle;
      bootImage: string;
    },
  ): Promise<void> {
    const live = { handle: ctx.handle, bootImage: ctx.bootImage };
    const layerGzip = await this.captureRoots(live.handle, [CAPTURE_DIR], input.runId);
    await ctx.publishLayer({
      tenant: input.tenant,
      world: input.world,
      tag: ctx.tag,
      // The image the session BOOTED is the base — so a snapshot is always "this world, plus what changed".
      baseReference: baseReferenceOf(live.bootImage),
      baseImage: live.bootImage,
      layerGzip,
      createdBy: `everdict snapshot of ${CAPTURE_DIR} (session ${input.runId})`,
    });
  }

  // ── THE ONE CAPTURE PIPELINE (a world's snapshot and a campaign's candidate build share it) ───────────
  //
  // The tar is rooted at `/` and names the directories, NOT taken from inside them. An image layer's paths are
  // root-relative, so `tar -C /everdict .` produces `./proj/…`, which unpacks to `/proj/…` — the files land
  // beside the place they came from and the image boots looking untouched. Found by a live drill, where the
  // snapshot published cleanly and the next session read the OLD file.
  //
  // `tar | gzip | base64 -w0` — one pipeline, so nothing lands on the container's disk. The size check runs in
  // the container too: refusing after transferring 4 GiB would be a refusal that already cost the money.
  private async captureRoots(handle: ComputeHandle, roots: readonly string[], runId: string): Promise<Buffer> {
    const limit = this.deps.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    const relative = roots.map((r) => shq(r.replace(/^\/+/, ""))).join(" ");
    const label = roots.join(", ");
    const sized = await handle.exec(`tar -C / -czf - ${relative} | wc -c`, { timeoutSec: CAPTURE_TIMEOUT_SEC });
    const bytes = Number.parseInt(sized.stdout.trim(), 10);
    if (Number.isFinite(bytes) && bytes > limit)
      throw new BadRequestError(
        "BAD_REQUEST",
        { run: runId, bytes, limit },
        `${label} is ${bytes} bytes compressed, past the ${limit}-byte capture bound — snapshot from a host-attached driver, or set EVERDICT_WORLD_MAX_CAPTURE_BYTES.`,
      );
    const captured = await handle.exec(`tar -C / -czf - ${relative} | base64 -w0`, { timeoutSec: CAPTURE_TIMEOUT_SEC });
    if (captured.exitCode !== 0)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { run: runId, roots },
        `Could not capture ${label}: ${clamp(captured.stderr || captured.stdout)}`,
      );
    return Buffer.from(captured.stdout.trim(), "base64");
  }

  // ── PUBLISH A BUILD AS A LAYER ON THE IMAGE THIS SESSION BOOTED (code-evolution-loop.md, D2) ─────────
  //
  // The campaign's candidate build: a session booted from a harness slot's image ran the template's build
  // steps, and the declared roots are published as ONE layer on that base into the caller's repository in the
  // managed store — the same registry-protocol path a world snapshot takes, with the repository and tag the
  // BUILD chooses rather than the world's `v<n>`. Nothing here registers a capability; the build service that
  // called it mints the harness version from the digest it gets back.
  async publishBuildLayer(
    actor: SandboxActor,
    runId: string,
    input: { repository: string; tag: string; roots: string[]; createdBy: string },
  ): Promise<{ digest: string }> {
    this.sweep();
    const live = this.sessions.get(runId);
    if (!live || live.tenant !== actor.tenant)
      throw new NotFoundError("NOT_FOUND", { run: runId }, "No live sandbox session with that id.");
    if (live.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError("FORBIDDEN", { run: runId }, "Only the session's creator or an admin can publish.");
    const handle = live.handle;
    const bootImage = live.bootImage;
    if (!handle || bootImage === undefined)
      throw new BadRequestError("BAD_REQUEST", { run: runId }, "This session holds no container — nothing to publish.");
    const publishLayer = this.deps.publishLayerSnapshot;
    if (!publishLayer)
      throw new BadRequestError("BAD_REQUEST", {}, "Registry layer publishing is not configured on this deployment.");
    if (input.roots.length === 0 || input.roots.some((r) => !r.startsWith("/")))
      throw new BadRequestError("BAD_REQUEST", { roots: input.roots }, "capture roots must be absolute paths");
    const layerGzip = await this.captureRoots(handle, input.roots, runId);
    const published = await publishLayer({
      tenant: live.tenant,
      world: input.repository, // the publisher's "world" IS the repository name in the workspace namespace
      tag: input.tag,
      baseReference: baseReferenceOf(bootImage),
      baseImage: bootImage,
      layerGzip,
      createdBy: input.createdBy,
    });
    live.trace.push({
      t: live.t++,
      kind: "env_action",
      action: "session.build_published",
      detail: { repository: input.repository, tag: input.tag, digest: published.digest, roots: input.roots },
    });
    return { digest: published.digest };
  }

  // The snapshot core (live and crash paths share it): mint the next v<n> tag → commit+push HOST-side with
  // a transient grant (the credential never enters the container, so it can never be captured INTO the
  // snapshot) → read the digest back from the registry (authoritative — what it actually stored) → publish
  // the environment-capability version → append the snapshot to the session row with its fact.
  private async publishSnapshot(input: {
    tenant: string;
    runId: string;
    world: string;
    computeId: string;
    actor: { subject: string; isAdmin: boolean };
    // Present only when THIS process holds the session. The layer-capture path reads through it; the crash
    // path (a reaper in a later process) has no exec channel and can only use a driver that can commit.
    compute?: { handle: ComputeHandle; bootImage: string };
    agent?: SandboxAgentAttribution;
    name?: string;
    description?: string;
    instructions?: string;
  }): Promise<WorldSnapshotResult> {
    const images = this.deps.images;
    const publish = this.deps.publishWorldVersion;
    // The driver that holds THIS session — not the deployment default. A session on a cluster has no daemon
    // to commit with even where the default driver does, so asking the wrong one would take a path that
    // cannot reach this container.
    const sessionDriver = this.sessions.get(input.runId)?.driver ?? this.deps.driver;
    const snapshot = sessionDriver?.snapshot !== undefined ? sessionDriver.snapshot.bind(sessionDriver) : undefined;
    const publishLayer = this.deps.publishLayerSnapshot;
    if (!images || !publish || (!snapshot && !publishLayer))
      throw new BadRequestError("BAD_REQUEST", {}, "World snapshots are not configured.");
    const tags = await images.listTags(input.tenant, input.world).catch(() => [] as string[]);
    let next = 1;
    for (const tag of tags) {
      const m = /^v(\d+)$/.exec(tag);
      if (m) next = Math.max(next, Number(m[1]) + 1);
    }
    const tag = `v${next}`;
    const ref = `${images.endpoint}/${images.namespaceFor(input.tenant)}/${input.world}:${tag}`;
    if (snapshot) {
      // The driver holds the compute: it commits and pushes without the bytes ever crossing the control
      // plane. Cheapest path, and the only one that captures the WHOLE filesystem rather than the work tree.
      const grant = await images.mintPushGrant(input.tenant, input.world);
      await snapshot(input.computeId, ref, {
        host: grant.endpoint,
        username: IMAGE_GRANT_USERNAME,
        password: grant.token,
      });
    } else if (publishLayer) {
      if (!input.compute)
        throw new BadRequestError(
          "BAD_REQUEST",
          { run: input.runId },
          "This session is not held by this control plane, and a registry snapshot captures through its exec channel — a crash-orphaned session on a daemonless placement cannot be hibernated.",
        );
      await this.captureAsLayer(input, { tag, publishLayer, ...input.compute });
    }
    // Pin the digest WITH the tag (pinDigest) so a human still reads a version off the ref. No digest →
    // the tag ref stands and the capability publish itself warns mutable-tag.
    const digest = await images
      .inspect(input.tenant, input.world, tag)
      .then((i) => i.digest)
      .catch(() => undefined);
    const image = digest !== undefined ? pinDigest(ref, digest) : ref;
    const published = await publish(input.tenant, input.actor, input.world, {
      image,
      sessionRunId: input.runId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    });
    const current = await this.deps.store.get(input.runId);
    if (current && !Run.from(current).isTerminal()) {
      const transition = Run.from(current).recordSnapshot({
        world: input.world,
        version: published.version,
        image,
        now: this.now(),
      });
      const stamped = stampFacts(input.tenant, attributed(transition.facts, input.agent), {
        newId: this.newId,
        now: this.now,
      });
      const written = await this.deps.store.update(
        input.runId,
        transition.patch,
        stamped.map((f) => f.record),
        { expectNonTerminal: true },
      );
      // …and a lost CAS announces nothing: the guarded write inserted no durable event, so pushing the
      // pre-stamped batch would put a fact on the live bus the ledger never recorded.
      if (written !== undefined && stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    }
    // Retention runs AFTER the publish and never blocks it: the snapshot the caller asked for already
    // exists, and a registry that refuses a delete must not turn that success into a failure. What it
    // removed is reported, not swallowed — a bound that silently eats versions is indistinguishable from
    // data loss (no silent caps).
    const pruned = await this.deps.pruneWorldVersions?.(input.tenant, input.actor, input.world).catch(() => undefined);
    return {
      world: input.world,
      version: published.version,
      image,
      ...(pruned !== undefined && pruned.prunedVersions.length > 0 ? { prunedVersions: pruned.prunedVersions } : {}),
    };
  }

  private async teardown(
    runId: string,
    live: LiveSession,
    reason: "closed" | "expired",
    opts?: { snapshot?: boolean },
  ): Promise<RunRecord | undefined> {
    this.sessions.delete(runId); // delete first — a concurrent close finds no handle and stays idempotent
    try {
      // A task mid-flight when the session ends: abort it and give the drive a short grace to settle the
      // child (failed{CANCELLED}) BEFORE the session seals and the container dies. If the drive is stuck on
      // an exec, the dispose below kills the container, the exec settles, and the child still settles late —
      // the grace only bounds how long teardown waits, never whether the child gets its terminal write.
      const active = live.playground?.active ?? live.frontdoor?.active;
      if (active) {
        active.abort.abort();
        await Promise.race([active.done, new Promise((r) => setTimeout(r, TEARDOWN_TASK_GRACE_MS))]);
      }
      // Hibernate (agent worlds W1): a world session's teardown captures the filesystem BEFORE the container
      // dies — expiry stops meaning loss. A failure never blocks teardown (the trajectory records it; the
      // world simply gains no new version this time).
      const wantSnapshot = live.world !== undefined && (opts?.snapshot ?? live.hibernate);
      if (wantSnapshot) {
        await this.snapshotLive(runId, live, { subject: live.createdBy, isAdmin: false }, {}).catch((err) => {
          live.trace.push({
            t: live.t++,
            kind: "env_action",
            action: "session.snapshot_failed",
            detail: { message: err instanceof Error ? err.message : String(err) },
          });
        });
      }
      live.trace.push({ t: live.t++, kind: "env_action", action: "session.close", detail: { reason } });
      // Seal the session's trajectory (P5 discipline: evidence before anything reads it; first write wins).
      await this.deps.trajectories
        // A shell session is personal work (`runAudience`), so its record is the member's — the browse ledger
        // must not hand one member's terminal history to the workspace.
        ?.seal({
          runId,
          tenant: live.tenant,
          source: "run",
          events: live.trace,
          owner: live.createdBy,
          // What the browse row calls it: a shell session, named by the environment the member asked for.
          kind: "sandbox",
          label: live.label,
        })
        .catch(() => undefined);
      const settled = await this.settle(runId, live.tenant, reason, live.agent);
      // Prompt reaper completion (best-effort) — a missed signal just lets the timer fire a no-op later.
      void this.deps.reaper?.signalClosed(runId).catch(() => {});
      return settled;
    } finally {
      // The reaper IS the finally — whichever compute this session holds: the container handle, or the
      // conversation's per-session target (the warm topology deliberately survives, on its own idle TTL).
      await live.handle?.dispose().catch(() => undefined);
      await live.frontdoor?.conversation.close().catch(() => undefined);
    }
  }

  private async settle(
    runId: string,
    tenant: string,
    reason: "closed" | "expired" | "orphaned",
    agent?: SandboxAgentAttribution,
  ): Promise<RunRecord | undefined> {
    const current = await this.deps.store.get(runId);
    if (!current || Run.from(current).isTerminal()) return current;
    const transition = Run.from(current).closeSession(reason, this.now());
    const stamped = stampFacts(tenant, attributed(transition.facts, agent), { newId: this.newId, now: this.now });
    const updated = await settleRun(
      this.deps.store,
      runId,
      transition.patch,
      stamped.map((f) => f.record),
    );
    // A lost CAS means somebody else closed it first — their facts are the ones on the ledger, so this
    // close publishes nothing and reports the row as it now stands.
    if (updated !== undefined && stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated ?? (await this.deps.store.get(runId));
  }

  private async resolveTarget(input: CreateSandboxInput): Promise<{
    image: string;
    harness: { id: string; version: string };
    playground?: ResolvedSessionHarness;
    world?: string;
    delegation?: ResolvedDelegationProfile;
  }> {
    // WHO works is a separate axis from WHERE. A delegation profile is resolved FIRST and then overlaid on
    // whichever target the caller named — a plain image, an adopted environment, a WORLD (the delegate picks
    // up where the last one left off) or a world's GENESIS (the profile's own image founds it). Delegation is
    // not a boot mode; refusing to combine it would mean a delegate could never work in a persistent world.
    const delegation = input.profile ? await this.resolveProfile(input) : undefined;
    if (input.profile && input.harness)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "profile and harness both say WHO runs — name one (a profile already pins its own agent).",
      );
    if (input.brief !== undefined && delegation === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        {},
        "A brief is the handoff to a delegation profile — boot with profile:{id} to send one.",
      );
    // The delegate's own environment when the caller named no other target — and the genesis base when they
    // founded a world without naming an image.
    const overlay = (image: string, harness: { id: string; version: string }, world?: string) => ({
      image,
      harness,
      ...(delegation !== undefined ? { playground: delegation.harness, delegation } : {}),
      ...(world !== undefined ? { world } : {}),
    });
    if (input.world) {
      // A world session is snapshot-bound by definition — refuse at CREATE when the deployment cannot
      // snapshot, not at the first snapshot hours of work later.
      if (input.harness)
        throw new BadRequestError("BAD_REQUEST", {}, "world and harness are mutually exclusive on one session.");
      const canSnapshot = this.deps.driver?.snapshot !== undefined || this.deps.publishLayerSnapshot !== undefined;
      if (!this.deps.images || !this.deps.publishWorldVersion || !canSnapshot)
        throw new BadRequestError(
          "BAD_REQUEST",
          {},
          "World sessions are not configured (a managed image store and a way to snapshot — a snapshot-capable driver or the registry layer-append path — are required).",
        );
      const world = input.world.id;
      // The world id doubles as its snapshot repository — the managed store's single-segment rule applies.
      if (!IMAGE_REPOSITORY_NAME.test(world))
        throw new BadRequestError(
          "BAD_REQUEST",
          { world },
          `world '${world}' is not a usable repository name — lowercase letters, digits, '.', '_', '-'.`,
        );
      // Boot the world's latest snapshot when it exists; otherwise `image` is the genesis base it is
      // founded from. The environment resolver goes through the same consume gate as any capability boot.
      if (this.deps.resolveEnvironmentImage) {
        const resolved = await this.deps.resolveEnvironmentImage(input.tenant, input.createdBy, { id: world });
        if (resolved) return overlay(resolved.image, { id: world, version: resolved.version }, world);
      }
      // GENESIS: the base this world is founded from — an explicit image, or the delegate's own environment
      // when a profile is doing the founding (delegating into a brand-new world must not require the caller
      // to know which image that profile runs in).
      const genesis = input.image?.trim() !== "" ? input.image : undefined;
      const base = genesis ?? delegation?.image;
      if (base !== undefined) return overlay(base, { id: world, version: "genesis" }, world);
      throw new NotFoundError(
        "NOT_FOUND",
        { world },
        "World not found — provide image (or a delegation profile) to found it: the genesis base this session starts from.",
      );
    }
    if (input.harness) {
      if (!this.deps.resolveSessionHarness)
        throw new BadRequestError("BAD_REQUEST", {}, "Harness sandboxes are not configured.");
      const resolved = await this.deps.resolveSessionHarness(input.tenant, input.createdBy, {
        id: input.harness.id,
        ...(input.harness.version !== undefined ? { version: input.harness.version } : {}),
      });
      if (!resolved)
        throw new NotFoundError("NOT_FOUND", { harness: input.harness.id }, "Harness not found in this workspace.");
      // Conversation mode needs the harness's cooperation (its own resume mechanism). Refused HERE — before
      // any container is provisioned — because the alternative is every turn silently starting fresh.
      if (input.harness.conversation === true && resolved.harness.conversational !== true)
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          `Harness '${input.harness.id}' does not support multi-turn conversation — each message would silently start fresh. Boot without conversation to run independent test cases.`,
        );
      const image = resolved.image ?? input.harness.image;
      if (image === undefined || image.trim() === "")
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: input.harness.id },
          `Harness '${input.harness.id}' declares no image — provide harness.image to boot it into a session.`,
        );
      return {
        image,
        harness: { id: resolved.id, version: resolved.version },
        playground: { ...resolved, image },
      };
    }
    if (input.environment) {
      if (!this.deps.resolveEnvironmentImage)
        throw new BadRequestError("BAD_REQUEST", {}, "Environment-backed sandboxes are not configured.");
      const resolved = await this.deps.resolveEnvironmentImage(input.tenant, input.createdBy, input.environment);
      if (!resolved)
        throw new NotFoundError(
          "NOT_FOUND",
          { environment: input.environment.id },
          "Environment not found (or not consumable by this workspace).",
        );
      return overlay(resolved.image, { id: input.environment.id, version: resolved.version });
    }
    if (input.image !== undefined && input.image.trim() !== "")
      return overlay(input.image, { id: input.image, version: "adhoc" });
    // No target named: the delegate's OWN environment is the session (the common case — "hand this job to
    // that profile" should not also require naming an image).
    if (delegation) return overlay(delegation.image, delegation.harness);
    throw new BadRequestError("BAD_REQUEST", {}, "Either image, environment, harness or profile is required.");
  }

  // The delegation profile behind `input.profile` — resolved through the composition's seam (capability get +
  // consume gate + secrets + model binding + the adapter that carries them).
  // The CLI about to run comes from the profile's own harness id — the caller never says it twice. An explicit
  // `identity` on the call is passed through and always wins; the domain owns what happens when there are none
  // or several (`chooseCliIdentity`).
  private async resolveIdentity(
    input: CreateSandboxInput,
    delegation: ResolvedDelegationProfile,
  ): Promise<CliIdentityChoice<ResolvedCliIdentity> | undefined> {
    if (!this.deps.resolveCliIdentity) return undefined;
    return this.deps.resolveCliIdentity(input.tenant, input.createdBy, {
      cli: delegation.harness.id,
      ...(input.identity !== undefined ? { ref: input.identity } : {}),
    });
  }

  private async resolveProfile(input: CreateSandboxInput): Promise<ResolvedDelegationProfile> {
    const ref = input.profile;
    if (!ref) throw new BadRequestError("BAD_REQUEST", {}, "profile is required.");
    if (!this.deps.resolveDelegationProfile)
      throw new BadRequestError("BAD_REQUEST", {}, "Delegation profiles are not configured.");
    const resolved = await this.deps.resolveDelegationProfile(input.tenant, input.createdBy, ref);
    if (!resolved)
      throw new NotFoundError(
        "NOT_FOUND",
        { profile: ref.id },
        "Delegation profile not found (or not consumable by this workspace).",
      );
    return resolved;
  }

  // Who may open a session when slots are scarce (W3). A flat per-tenant cap was written for members
  // clicking a button; an autonomous agent holding world sessions across hibernates changes what that cap
  // MEANS — two agents in one workspace collide on it immediately, and worse, a background agent can hold
  // the last slot against the person waiting to debug something. Two rules, the same shape as the
  // scheduler's class fairness (interactive must never starve behind background work):
  //   1. an agent holds at most `maxPerAgent` sessions of its own, and
  //   2. agents never take the LAST tenant slot — one stays reserved for a member.
  // Both refusals name what is holding the capacity and when it frees, because "retry shortly" is not
  // something a caller — human or agent — can act on.
  // Counted from the LEDGER, not from this process's map. A control plane running more than one replica used
  // to admit its cap once per replica — each instance could only see the sessions it happened to hold — so a
  // 3-instance deployment gave every workspace three times the session pool it was configured for. The ledger
  // is the one place that knows what a workspace is actually holding open.
  private async enforceCapacity(
    tenant: string,
    agent: SandboxAgentAttribution | undefined,
    pool?: { trigger: string; maxPerTenant?: number; maxTotal?: number },
  ): Promise<void> {
    // Default pool = the container sandboxes; the front-door conversation branch passes its own trigger +
    // caps (a warm-topology slot is a different scarcity — the pools never share).
    const trigger = pool?.trigger ?? SANDBOX_TRIGGER;
    const maxTotal = pool !== undefined ? pool.maxTotal : this.deps.maxTotal;
    const maxPerTenant = pool !== undefined ? pool.maxPerTenant : this.deps.maxPerTenant;
    const live = holding(await this.deps.store.liveSessions({ trigger }), this.now());
    if (maxTotal !== undefined && live.length >= maxTotal)
      throw new RateLimitError(
        "RATE_LIMITED",
        { scope: "global", limit: maxTotal, ...nextFreeSlot(live) },
        `Sandbox session capacity is full (${maxTotal} across all workspaces)${freesAtSuffix(live)}.`,
      );
    const owned = live.filter((row) => row.tenant === tenant);
    if (agent !== undefined) {
      const maxPerAgent = this.deps.maxPerAgent ?? DEFAULT_MAX_PER_AGENT;
      const mine = owned.filter((row) => row.agentId === agent.agentId).length;
      if (mine >= maxPerAgent)
        throw new RateLimitError(
          "RATE_LIMITED",
          { scope: "agent", agent: agent.agentId, limit: maxPerAgent, ...nextFreeSlot(owned) },
          `Agent '${agent.agentId}' already holds ${mine} sandbox session(s) — close one (or snapshot the world and close it) before opening another.`,
        );
    }
    if (maxPerTenant === undefined) return;
    // The member reserve: only when the cap leaves room for one (a 1-slot deployment would otherwise ban
    // agents outright, which is a different decision than "keep a slot for people").
    const agentCeiling = agent !== undefined && maxPerTenant >= 2 ? maxPerTenant - 1 : maxPerTenant;
    if (owned.length >= agentCeiling)
      throw new RateLimitError(
        "RATE_LIMITED",
        { scope: "tenant", limit: agentCeiling, ...nextFreeSlot(owned) },
        agent !== undefined && agentCeiling < maxPerTenant
          ? `This workspace has ${owned.length} of ${maxPerTenant} sandbox session(s) open, and the last slot is reserved for a member${freesAtSuffix(owned)}.`
          : `This workspace already has ${owned.length} open sandbox session(s) — close one first${freesAtSuffix(owned)}.`,
      );
  }

  private maxTtl(): number {
    return this.deps.maxTtlSec ?? MAX_TTL_SEC;
  }
}

function clamp(text: string): string {
  return text.length > MAX_TRACE_OUTPUT_CHARS ? `${text.slice(0, MAX_TRACE_OUTPUT_CHARS)}…[truncated]` : text;
}
