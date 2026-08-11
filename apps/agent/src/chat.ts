import { createHash } from "node:crypto";
import {
  type AgentEvent,
  type ChatMessage,
  type McpInvoke,
  type PermissionHook,
  type SubagentType,
  ToolRegistry,
  type WaitRequest,
  buildSummarizer,
  extractTodosFromHistory,
  renderTodoCarryover,
  runAgentLoop,
  wellFormedArguments,
} from "@everdict/agent-runtime";
import type { AgentSessionStore, AnalysisArtifactStore, Metrics } from "@everdict/application-control";
import {
  type AgentMessageRecord,
  type AgentReference,
  type AgentReferenceType,
  type AgentToolCall,
  type AgentWakeIntent,
  type AnalysisArtifactRecord,
  NotFoundError,
  type TaskEnvelope,
  type TraceSpan,
  memberMemoryDirectory,
  memberMemorySlug,
  traceIdForRun,
} from "@everdict/contracts";
import { assertTaskEnvelope } from "@everdict/domain";
import type { LlmTransport, ReasoningCarrier } from "@everdict/llm";
import { type AgentDraft, buildAgentDraftTools } from "./agent-draft-tool.js";
import type { AgentTryEvent, AgentTryResult } from "./agent-try.js";
import { buildRunAnalysisTool } from "./analysis-script-tool.js";
import { buildArtifactTools } from "./artifact-tools.js";
import type { CodeToolRuntime } from "./code-tools.js";
import type { ToolProvider } from "./mcp-tools.js";
import {
  MEMORY_DIRECTORY,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_PATH,
  buildMemoryExtractor,
  maintainMemoryExtraction,
  turnWroteMemory,
} from "./memory-extraction.js";
import type { ModelByIdResolver, ModelResolver } from "./model.js";
import type { ForwardHeaders, Principal } from "./principal.js";
import type { ProfileResolver } from "./profile.js";
import type { AgentTurnUsage } from "./run-trace.js";
import { buildEnvironmentSection } from "./system-prompt.js";
import { TurnSpanRecorder } from "./turn-spans.js";
import type { AgentRunEventReport } from "./usage.js";
import { buildViewConfigTool } from "./view-config-tool.js";

// An @-reference resolves to the workspace read tool that fetches that entity's full record. `trace` is the exception:
// it is keyed by (source, id=traceId), so it resolves via inspect_trace with those args (see referenceArgs).
const REFERENCE_TOOL: Record<AgentReferenceType, string> = {
  harness: "get_harness_instance",
  runtime: "get_runtime",
  run: "get_run",
  dataset: "get_dataset",
  scorecard: "get_scorecard",
  judge: "get_judge",
  view: "get_view",
  skill: "get_skill",
  knowledge: "get_knowledge_entry", // a reified claim — the record carries its body AND its lineage fields
  environment: "get_capability", // an environment IS a capability of kind `environment` — one store entity, one read
  tool: "get_capability", // ditto for the tool kinds (mcp | code) — Settings › Agent › Tools hands the agent the spec
  trace: "inspect_trace",
  issue: "get_issue", // the tracker's unit of intent — what problem is under evaluation, how it closed, whether it regressed
};

// The read-tool arguments for a reference. Most entities read by (id, version?); a `trace` reads by (name=source,
// traceId=id) — inspect_trace's own signature — so the context injection hands the model the trace's normalized events.
// A `tool` may live in ANOTHER workspace (a first-party default is `_everdict`-owned, an adopted tool belongs to its
// publisher), so its owner rides along as get_capability's `source`.
function referenceArgs(ref: AgentReference): Record<string, unknown> {
  if (ref.type === "trace") return { name: ref.source ?? "", traceId: ref.id };
  return {
    id: ref.id,
    ...(ref.version ? { version: ref.version } : {}),
    ...(ref.type === "tool" && ref.source ? { source: ref.source } : {}),
  };
}

const MAX_REFERENCE_CHARS = 4_000;

// Auto-recall (Claude Code's relevant_memories reinterpreted): map each @-reference to its knowledge-graph node
// ref and ask get_task_context ONCE for what the workspace already knows about those anchors — claims/decisions/
// conventions + skill candidates, projected onto the reference's own version coordinate (the anchor-relative
// as-of model). Precision-first: no embedding search — the user's references ARE the anchors; a message with no
// references recalls nothing. `trace` has no knowledge node type (external observability id) — skipped.
const KNOWLEDGE_NODE_TYPE: Partial<Record<AgentReferenceType, string>> = {
  harness: "harness",
  runtime: "runtime",
  run: "run",
  dataset: "dataset",
  scorecard: "scorecard",
  judge: "judge",
  view: "view",
  skill: "skill",
  knowledge: "knowledge",
  environment: "capability", // an environment IS a capability of kind `environment` (same node identity)
  tool: "capability",
};
const MAX_KNOWLEDGE_CHARS = 4_000;

// Recall the workspace's knowledge about the referenced anchors into a turn preamble. Best-effort like reference
// resolution: an unreachable knowledge layer (or zero mappable refs) recalls nothing rather than failing the turn.
async function recallKnowledge(call: McpInvoke, references: AgentReference[]): Promise<string | undefined> {
  const refs = references.flatMap((ref) => {
    const type = KNOWLEDGE_NODE_TYPE[ref.type];
    if (!type) return [];
    return [{ type, key: ref.id, ...(ref.version ? { version: ref.version } : {}) }];
  });
  if (refs.length === 0) return undefined;
  try {
    const r = await call("get_task_context", { refs });
    if (r.isError || r.content.trim().length === 0) return undefined;
    const detail =
      r.content.length > MAX_KNOWLEDGE_CHARS ? `${r.content.slice(0, MAX_KNOWLEDGE_CHARS)}\n… [truncated]` : r.content;
    return `The workspace already KNOWS things about the referenced entities (claims/decisions/conventions from the knowledge layer, projected onto each reference's own version). Inherit them — do not re-derive or contradict them without saying so:\n\n${detail}`;
  } catch {
    return undefined;
  }
}

// Workspace auto-memory recall (Claude Code's MEMORY.md index reinterpreted over the workspace filesystem): the
// agents' own cross-conversation memory lives at memory/ on the TENANT's workspace filesystem — one file per fact,
// memory/MEMORY.md as the index — written with the ordinary attributed fs tools (write_file), never the
// control plane's local disk (multi-tenant: the per-workspace bucket IS the isolation boundary). The index is
// injected every turn so the agent knows what past conversations learned; bodies stay out of context until the
// agent get_file's one it judges relevant (index + body split — only the index pays rent in every window).
export { MEMORY_DIRECTORY, MEMORY_INDEX_PATH } from "./memory-extraction.js";
// TWO caps, because either alone is gameable and both failure shapes are real: a byte cap alone admits 300 useless
// one-liners, and a line cap alone admits an index of essays (Claude Code measured a 197KB index that was still
// UNDER its 200-line cap). Truncation then NAMES the cap that fired and prescribes the fix, because "shorten it"
// does not tell the agent whether it wrote too many entries or entries that are too long.
const MAX_MEMORY_INDEX_LINES = 200;
const MAX_MEMORY_INDEX_CHARS = 12_000;
const DAY_MS = 86_400_000;

// Age in whole days, rendered the way a model can actually reason about it. An ISO timestamp does not trigger
// staleness reasoning — "47 days ago" does — and day precision keeps the injected block byte-identical across a
// day's turns (the same prompt-cache discipline as the environment date).
function daysAgo(iso: string, now: number): number | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

function renderAge(days: number): string {
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// Annotate each index line with the age of the memory it points at. The ages come from ONE `list_files` on the
// memory directory (every FsEntry carries modifiedAt), never a per-file stat: the index is the manifest, so the
// only thing missing from it is time. A line whose target we cannot resolve is left exactly as the agent wrote it.
function withAges(index: string, ages: Map<string, number>): string {
  return index
    .split("\n")
    .map((line) => {
      const target = /\]\(([^)]+\.md)\)/.exec(line)?.[1];
      if (target === undefined) return line;
      const days = ages.get(target.replace(/^\.?\//, ""));
      return days === undefined ? line : `${line} _(${renderAge(days)})_`;
    })
    .join("\n");
}

// Memories the index does not point at. A memory is only recalled through the index, so a body with no line is
// invisible no matter how good it is — and we KNOW how they get there: the turn-end extractor publishes the body
// first and then the index, so a lost index race (or a failed second write) leaves exactly this. Nothing noticed
// until now, which is what made "the consolidation pass reconciles it" a comment rather than a behaviour.
function unlistedMemories(index: string, files: readonly string[], directory: string): string | undefined {
  const listed = new Set<string>();
  for (const m of index.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const target = m[1];
    if (target !== undefined) listed.add(target.replace(/^\.?\//, ""));
  }
  const orphans = files.filter((name) => name.endsWith(".md") && name !== MEMORY_INDEX_FILE && !listed.has(name));
  if (orphans.length === 0) return undefined;
  const shown = orphans.slice(0, 5).join(", ");
  const rest = orphans.length > 5 ? `, and ${orphans.length - 5} more` : "";
  return `NOTE: ${orphans.length} file(s) under ${directory}/ are not listed in the index (${shown}${rest}) — they were saved but their index line never landed, so nobody can recall them. Read each one and either add its line to ${directory}/${MEMORY_INDEX_FILE} or delete it if it no longer holds.`;
}

// Truncate on BOTH caps, cutting at a line boundary, and report which cap fired with its own remedy.
function capIndex(content: string, indexPath: string): { index: string; warning?: string } {
  const lines = content.split("\n");
  const overLines = lines.length > MAX_MEMORY_INDEX_LINES;
  const overChars = content.length > MAX_MEMORY_INDEX_CHARS;
  if (!overLines && !overChars) return { index: content };
  let kept = overLines ? lines.slice(0, MAX_MEMORY_INDEX_LINES) : lines;
  if (kept.join("\n").length > MAX_MEMORY_INDEX_CHARS) {
    const out: string[] = [];
    let used = 0;
    for (const line of kept) {
      if (used + line.length + 1 > MAX_MEMORY_INDEX_CHARS) break;
      used += line.length + 1;
      out.push(line);
    }
    kept = out;
  }
  // Both caps are judged against the ORIGINAL size: a long-line index that only breaches bytes must be told so,
  // and measuring after line-truncation would understate it.
  const reason = overLines
    ? overChars
      ? `${lines.length} lines and ${content.length} characters (limits: ${MAX_MEMORY_INDEX_LINES} lines, ${MAX_MEMORY_INDEX_CHARS} characters) — there are too many entries AND they are too long`
      : `${lines.length} lines (limit: ${MAX_MEMORY_INDEX_LINES}) — there are too many entries`
    : `${content.length} characters (limit: ${MAX_MEMORY_INDEX_CHARS}) — the entries are too long`;
  return {
    index: kept.join("\n"),
    warning: `WARNING: ${indexPath} is ${reason}. Only part of it was loaded, so some memories are invisible to you right now. Keep each index entry to ONE line under ~150 characters and move detail into its topic file; merge or delete memories that overlap (the memory_consolidation skill does this pass).`,
  };
}

// The acting member's own memory directory. Derived from the SAME rule the control plane scopes by
// (memberMemorySlug), so the agent asks for the exact path the filesystem will serve it — and if it ever asked
// for someone else's, it would simply get NOT FOUND.
function memberMemoryDirectoryFor(subject: string): string {
  return memberMemoryDirectory(memberMemorySlug(subject, (input) => createHash("sha256").update(input).digest("hex")));
}

// ONE memory scope, rendered: its index (capped, aged) plus whatever the directory read has to report. Returns
// undefined when the scope holds nothing — a member who has never been written about costs no tokens.
async function memoryScopeBlock(
  call: McpInvoke,
  directory: string,
  heading: string,
  now: number,
): Promise<string | undefined> {
  const indexPath = `${directory}/${MEMORY_INDEX_FILE}`;
  const r = await call("get_file", { path: indexPath });
  if (r.isError) return undefined; // nothing here yet (NOT_FOUND), or an unreachable fs — recall nothing
  const file = JSON.parse(r.content) as { content?: unknown; encoding?: unknown };
  if (typeof file.content !== "string" || file.content.trim().length === 0 || file.encoding === "base64")
    return undefined;
  const { index: capped, warning } = capIndex(file.content, indexPath);

  // One directory read serves two purposes, and neither is a precondition for recall: per-entry ages, and the
  // files that exist but no index line points at. Best-effort — an unreachable listing just means neither.
  const ages = new Map<string, number>();
  const files: string[] = [];
  try {
    const listed = await call("list_files", { path: directory });
    if (!listed.isError) {
      for (const e of JSON.parse(listed.content) as { name?: unknown; modifiedAt?: unknown }[]) {
        if (typeof e.name !== "string") continue;
        files.push(e.name);
        if (typeof e.modifiedAt !== "string") continue;
        const days = daysAgo(e.modifiedAt, now);
        if (days !== undefined) ages.set(e.name, days);
      }
    }
  } catch {
    // no ages and no orphan check this turn — the index still recalls
  }
  // Judged against the FULL index, never the capped one: a truncated index would otherwise report everything
  // past the cut as unlisted.
  const orphans = unlistedMemories(file.content, files, directory);
  return [
    heading,
    "",
    withAges(capped, ages),
    ...(warning ? ["", warning] : []),
    ...(orphans ? ["", orphans] : []),
  ].join("\n");
}

// Recall, for both scopes a workspace has. `memberDirectory` is the acting member's own area — the control plane
// serves it only to them (MemberScopedWorkspaceFs), so this is a scope, not a naming convention. The two reads run
// together: they are independent, and the member should not pay two round trips for what is one recall.
export async function workspaceMemoryPreamble(
  call: McpInvoke,
  now = Date.now(),
  memberDirectory?: string,
): Promise<string | undefined> {
  try {
    const [shared, mine] = await Promise.all([
      memoryScopeBlock(
        call,
        MEMORY_DIRECTORY,
        `Workspace memory index (${MEMORY_INDEX_PATH} — what agents learned in PAST conversations; shared by the whole workspace):`,
        now,
      ),
      memberDirectory === undefined
        ? Promise.resolve(undefined)
        : memoryScopeBlock(
            call,
            memberDirectory,
            `This member's own memory index (${memberDirectory}/${MEMORY_INDEX_FILE} — about THIS member; only they and the agents acting for them can read it):`,
            now,
          ),
    ]);
    if (shared === undefined && mine === undefined) return undefined;

    const discipline = [
      "Read a listed memory's body with get_file when it bears on THIS task, or grep across memories with search_files.",
      "The age beside each entry is when it was last written — a memory is a claim about the workspace AS IT WAS THEN, so verify an old one before acting on it.",
      memberDirectory === undefined
        ? `Save a new memory under ${MEMORY_DIRECTORY}/.`
        : `Save what is true of the WORKSPACE under ${MEMORY_DIRECTORY}/, and what is true of THIS MEMBER (their role, preferences, working habits — type: member) under ${memberDirectory}/. Putting a person's preferences in the shared area publishes them to everyone.`,
      "If the user asks you to ignore memory, proceed as if these indexes were empty.",
    ].join(" ");
    return [...(shared ? [shared] : []), ...(mine ? [mine] : []), "", discipline].join("\n\n");
  } catch {
    return undefined; // best-effort — memory must never fail a turn
  }
}

// Stale-file reminders (Claude Code's edited_text_file attachment reinterpreted over the revision ledger): the
// mid-conversation counterpart of the write path's 409 + three-way merge. Files THIS conversation touched
// (get_file/write_file calls in the replayed transcript) are checked against the ledger's newest revision at the
// turn boundary; a revision published AFTER the conversation's last touch by someone ELSE — a member, or an agent
// in ANOTHER conversation — earns a warning, so the agent re-reads before relying on (or overwriting) stale
// knowledge. Best-effort and capped: an unreachable ledger or an unparsable record just means no reminder.
const STALE_CHECK_MAX_FILES = 8;

// path → ISO time of the conversation's LAST touch (read or write; a later own-write supersedes an earlier read —
// the agent's knowledge is current as of its own publish).
function touchedFilesOf(records: AgentMessageRecord[]): Map<string, string> {
  const touched = new Map<string, string>();
  for (const r of records) {
    if (r.role !== "assistant" || !r.toolCalls) continue;
    for (const tc of r.toolCalls) {
      if (tc.name !== "get_file" && tc.name !== "write_file") continue;
      try {
        const args = JSON.parse(tc.arguments) as { path?: unknown };
        if (typeof args.path === "string" && args.path.length > 0) touched.set(args.path, r.createdAt);
      } catch {
        // unparsable arguments (a truncated call) — not a touch
      }
    }
  }
  return touched;
}

export async function staleFileReminder(
  call: McpInvoke,
  records: AgentMessageRecord[],
  sessionId: string,
): Promise<string | undefined> {
  const touched = touchedFilesOf(records);
  if (touched.size === 0) return undefined;
  const recent = [...touched.entries()].slice(-STALE_CHECK_MAX_FILES); // the most recently touched files
  const lines = await Promise.all(
    recent.map(async ([path, touchedAt]): Promise<string | undefined> => {
      try {
        const r = await call("list_file_revisions", { path, limit: 1 });
        if (r.isError) return undefined;
        const revisions = JSON.parse(r.content) as Array<{
          revision?: number;
          createdAt?: string;
          message?: string;
          actor?: { kind?: string; subject?: string; agentId?: string; agentName?: string; conversationId?: string };
        }>;
        const latest = Array.isArray(revisions) ? revisions[0] : undefined;
        if (!latest || typeof latest.createdAt !== "string") return undefined;
        if (latest.actor?.conversationId === sessionId) return undefined; // this conversation's own publish
        if (latest.createdAt <= touchedAt) return undefined; // nothing newer than the conversation's last touch
        const by =
          latest.actor?.kind === "agent"
            ? `agent ${latest.actor.agentName ?? latest.actor.agentId ?? "unknown"}`
            : (latest.actor?.subject ?? "someone");
        const note = latest.message ? ` ("${latest.message}")` : "";
        return `- ${path} — revision ${latest.revision ?? "?"} published by ${by} at ${latest.createdAt}${note}`;
      } catch {
        return undefined; // best-effort — a ledger hiccup never fails the turn
      }
    }),
  );
  const flagged = lines.filter((l): l is string => l !== undefined);
  if (flagged.length === 0) return undefined;
  return `Files you used earlier in this conversation have been REVISED since, by someone else. Re-read them with get_file before relying on or overwriting their content:\n${flagged.join("\n")}`;
}

// Resolve each @-reference via its read tool and assemble a context preamble the model reads before the user's
// words. Best-effort: an unresolved reference degrades to a note rather than failing the turn.
async function resolveReferences(call: McpInvoke, references: AgentReference[]): Promise<string> {
  const blocks: string[] = [];
  for (const ref of references) {
    const args = referenceArgs(ref);
    let detail: string;
    try {
      const r = await call(REFERENCE_TOOL[ref.type], args);
      detail = r.isError ? `(could not resolve: ${r.content.slice(0, 200)})` : r.content;
    } catch (err) {
      detail = `(could not resolve: ${err instanceof Error ? err.message : String(err)})`;
    }
    if (detail.length > MAX_REFERENCE_CHARS) detail = `${detail.slice(0, MAX_REFERENCE_CHARS)}\n… [truncated]`;
    const tag = ref.version ? `${ref.id}@${ref.version}` : ref.id;
    blocks.push(`### Referenced ${ref.type}: ${ref.label} (${tag})\n${detail}`);
  }
  return `The user attached the following workspace context via @-references. Use it to answer.\n\n${blocks.join("\n\n")}`;
}

const MAX_ATTACHMENT_CHARS = 8_000;

// A file the user attached — content is the read text (folded into the model context, not persisted).
export interface AgentAttachmentInput {
  name: string;
  mimeType?: string;
  size?: number;
  content?: string;
}

// The analysis canvas the member is looking at RIGHT NOW (docs/architecture/analysis-studio.md C). The web
// captures it per turn (a synchronous same-window round-trip right before send), so multi-turn refinement —
// "make it a bar chart", "regroup by model" — grounds on the live state INCLUDING the member's manual picker
// changes, not on whatever the agent last applied. config is the stored-form vocabulary apply_view_config takes.
export interface CanvasState {
  config: Record<string, string>;
  viewId?: string | undefined;
}

// The agent-crafting canvas the member has open RIGHT NOW (docs/architecture/agent-automation.md B2/B3 — the
// analysis-canvas pattern applied to crafting). The web captures the draft per turn (same-window round-trip
// right before send), so multi-turn refinement grounds on the live draft INCLUDING the member's manual edits.
export interface AgentDraftState {
  draft: AgentDraft;
  agentId?: string | undefined; // editing an existing registered agent (the canvas opened on it)
}

// Fold the open crafting canvas into the turn context: current draft + the patch rule (craft_agent changes
// only what you send), the verify path (try_agent_draft = shadow run) and the save path (create_agent), so
// craft → try → save closes inside one conversation. The crafted agent is DECLARATION over the same agentic
// loop this conversation runs on — never code, never a second runtime.
function buildDraftPreamble(state: AgentDraftState): string {
  const target = state.agentId ? `the registered agent '${state.agentId}'` : "a new, unsaved agent";
  return [
    `The user has the AGENT CRAFTING canvas open (${target}). The draft's CURRENT state — the exact vocabulary craft_agent patches — is:`,
    JSON.stringify(state.draft),
    "Shape it with craft_agent (a PATCH — send only the fields that change; `clear` unsets). Verify behavior with " +
      "try_agent_draft (a shadow activation: reads run live, mutations are captured as would-have-done and denied) — " +
      "prefer replaying a REAL past event's kind/payload found via list_platform_events. When the user wants to save, " +
      "call create_agent with the agent id and the FULL spec assembled from the draft (set enabled:true only when they " +
      "explicitly want it activated). The crafted agent runs on the SAME agentic loop as this conversation — its spec " +
      "is pure declaration (instructions/task/triggers/permission mode), never code.",
  ].join("\n");
}

// Fold the open canvas into the turn context, with the delta-editing rule spelled out (apply_view_config resets
// unset keys, so "change one thing" means re-sending the kept keys too) and the save path (create_view /
// update_view take this exact config), so "save this analysis" closes in the same conversation.
function buildCanvasPreamble(canvas: CanvasState): string {
  const target = canvas.viewId ? `the saved View '${canvas.viewId}'` : "an unsaved analysis on the analyze dashboard";
  // A BLANK canvas is the new-analysis entry: the surface has no pickers, so nothing appears on it until this
  // turn draws it. Say so plainly — "{}" alone reads as "an analysis that happens to be empty".
  const empty = Object.keys(canvas.config).length === 0;
  const intro = empty
    ? `The user has the analysis canvas open (${target}) and it is EMPTY — nothing is drawn yet. The canvas has no pickers: apply_view_config is the ONLY way anything appears on it, so put a first lens up (ask what they want, or propose a useful breakdown and apply it). Its stored-form config — the exact vocabulary apply_view_config takes — is currently:`
    : `The user has the analysis canvas open (${target}). Its CURRENT stored-form config — the exact vocabulary apply_view_config takes — is:`;
  const rule =
    "When the user asks to change the visualization or the analysis itself, call apply_view_config with the FULL " +
    "desired config: start from the current one above, change what they asked, and re-send every key you keep " +
    "(unset keys reset to defaults).";
  const save = canvas.viewId
    ? `If the user asks to save these changes, call update_view with id '${canvas.viewId}' and this config.`
    : "If the user asks to save this analysis, call create_view with a name and this config.";
  return `${intro}\n${JSON.stringify(canvas.config)}\n${rule} ${save}`;
}

// Fold attached text files into a context preamble (their content is not persisted, only their metadata).
function buildAttachmentPreamble(attachments: AgentAttachmentInput[]): string | undefined {
  const blocks: string[] = [];
  for (const a of attachments) {
    if (typeof a.content !== "string" || a.content.length === 0) continue;
    const capped =
      a.content.length > MAX_ATTACHMENT_CHARS
        ? `${a.content.slice(0, MAX_ATTACHMENT_CHARS)}\n… [truncated]`
        : a.content;
    blocks.push(`### Attached file: ${a.name}\n\`\`\`\n${capped}\n\`\`\``);
  }
  if (blocks.length === 0) return undefined;
  return `The user attached the following file(s). Use their content to answer.\n\n${blocks.join("\n\n")}`;
}

// An hour is long enough for a real batch and short enough that silence gets noticed; a day is the ceiling, because
// an agent that parks a conversation past anyone's attention span has effectively dropped it.
const DEFAULT_WAIT_SECONDS = 60 * 60;
const MAX_WAIT_SECONDS = 24 * 60 * 60;

// The kernel's wait REQUEST plus the host's clock = a durable intent. The kernel says what to wait for and never
// reads a clock (that keeps it deterministic under test); the host decides when the wait expires. Every intent gets
// a deadline — an unbounded wait is indistinguishable from a dropped promise.
export function toWakeIntent(
  request: WaitRequest,
  deps: Pick<ChatDeps, "now" | "defaultWaitSeconds" | "maxWaitSeconds">,
): AgentWakeIntent {
  const requested = request.timeoutSeconds ?? deps.defaultWaitSeconds ?? DEFAULT_WAIT_SECONDS;
  const seconds = Math.min(Math.max(Math.round(requested), 1), deps.maxWaitSeconds ?? MAX_WAIT_SECONDS);
  const createdAt = deps.now();
  return {
    kinds: request.kinds,
    filters: request.filters,
    note: request.note,
    deadlineAt: new Date(new Date(createdAt).getTime() + seconds * 1000).toISOString(),
    createdAt,
  };
}

export interface ChatDeps {
  sessions: AgentSessionStore;
  // Analysis-artifact persistence (docs/architecture/analysis-studio.md V2). Present → the agent gets the
  // render_chart/render_table/write_report emission tools; absent → no artifact tools (dev without a store).
  artifacts?: AnalysisArtifactStore;
  // run_analysis sandbox (analysis-studio V5) — present AND isolated → the agent may run model-authored analysis
  // scripts (HITL-gated). Wired only when the operator opts in (AGENT_ALLOW_RUN_ANALYSIS); absent → no tool.
  analysisScriptRuntime?: CodeToolRuntime;
  resolveModel: ModelResolver;
  toolProvider: ToolProvider;
  systemPrompt: string; // base persona — used as-is when no resolveProfile is wired (dev / no DB)
  now: () => string;
  newId: () => string;
  maxTurns?: number;
  // Per-workspace agent customization (Phase 1): resolve the workspace's AgentSpec → system prompt (base +
  // instructions), MCP tool servers, and an optional model override. Absent → the base agent (no customization).
  resolveProfile?: ProfileResolver;
  // Resolve the AgentSpec.model override → the LLM client. Only consulted when a profile names a model.
  resolveModelById?: ModelByIdResolver;
  // Model tiering (needs resolveModelById). smallModelRef → a cheaper model digests compaction summaries (resolved
  // lazily, only when compaction fires). fallbackModelRef → an alternate model the run switches to on sustained
  // upstream failure. subagentModelRef → a cheaper model for spawn_agent sub-agents. Absent → the single main model
  // does everything (the historical behaviour).
  smallModelRef?: string;
  fallbackModelRef?: string;
  subagentModelRef?: string;
  // Per-tool wall-clock deadline (ms) forwarded to the loop; a hung tool can't pin a turn forever. Absent → no deadline.
  toolTimeoutMs?: number;
  // Unattended-run resilience (forwarded to the loop): capacity errors (429/529) are waited out indefinitely
  // instead of exhausting the retry budget. Set by the headless callers (teammate/discussion/report turns) via a
  // deps spread — interactive chat stays fail-fast. See AgentLoopOptions.persistentRetry.
  persistentRetry?: boolean;
  // The workspace's registered (crafted) agents as spawnable sub-agent types (registrySubagentTypes) — merged
  // after the builtins (a name collision keeps the builtin). Absent → builtins only (dev / no registry).
  listSubagentTypes?: (principal: Principal) => Promise<SubagentType[]>;
  // agent.run.* lifecycle facts + the P3 ledger correlation → the control plane (fleet observability,
  // agent-automation A5). Declared HERE, on the deps every turn entry point already carries, because "a turn is
  // a run" is a property of turns, not of the HTTP server: a headless caller that spreads ChatDeps and cannot
  // see this field runs its turn outside the ledger, which is how the wake / report / discussion turns came to
  // leave no evidence at all. The report shape has ONE definition (usage.ts).
  reportRunEvent?: (input: AgentRunEventReport) => Promise<void>;
  // Waiting (LESSON 051): the event kinds THIS host can resume a conversation on. Present → the agent gets the
  // `wait_for` tool and a turn may end parked ("waiting") with a durable wake intent instead of handing unfinished
  // work back to the member. Absent → no tool: a host with no resume path must not let an agent promise a follow-up
  // it will never deliver. Wired by the agent server, which owns both the event fan-out and the deadline sweep.
  waitableEventKinds?: readonly string[];
  // How long a wait may run when the agent names no timeout, and the ceiling for one it does. Ops knobs; absent →
  // 1 hour / 24 hours. A wait always has a deadline — silence must never strand a watcher.
  defaultWaitSeconds?: number;
  maxWaitSeconds?: number;
  // Session running memory: once the bounded replay span exceeds this many characters, the oldest records are
  // folded into the session's digest at the turn boundary (see maintainSessionMemory). Ops/test tuning knob;
  // absent → MEMORY_TRIGGER_CHARS.
  memoryTriggerChars?: number;
  // Turn-end auto memory extraction (AGENT_MEMORY_EXTRACTION, opt-in): a SMALL-model pass at the turn boundary
  // that may save ONE durable workspace memory the inline discipline missed. Requires the small tier
  // (smallModelRef + resolveModelById) — it never runs on the main model, and a turn that already wrote under
  // memory/ skips it (the primary writer did its job). See memory-extraction.ts.
  memoryExtraction?: boolean;
  // Agent-plane observability (the round-2 gap analysis' "measure before optimizing"): the loop's resilience
  // events become Prometheus series — turn outcomes/durations, retry waits, fallback switches, truncations,
  // compactions, tool failures — so "why do turns die" is a measured distribution, not an anecdote. main.ts
  // exposes GET /metrics on the agent server (unauthenticated like the control plane's; firewall the scrape path).
  metrics?: Metrics;
  // Extended-thinking budget (tokens). Set → the loop asks the model to reason before answering (Anthropic `thinking`;
  // reasoning models reason regardless). Reasoning is captured + streamed either way; absent → thinking off.
  thinkingBudgetTokens?: number;
  // The web app's public base URL (WEB_BASE_URL) — lets the agent hand the member REAL links: entity deep links
  // ({web}/{workspace}/scorecards/<id> …) and the desktop-app download page ({web}/{workspace}/download). Absent →
  // the environment block omits the link lines and the agent should not guess URLs.
  webBaseUrl?: string;
  // Direct desktop-app download URL (DESKTOP_DOWNLOAD_URL, e.g. a GitHub Release) — offered alongside the in-app
  // download page when the operator set it.
  desktopDownloadUrl?: string;
  // Report a conversation's metered LLM usage to the control plane (agent cost → the shared meter + enforcement
  // budget, source "agent"). Called best-effort after a turn completes, ONLY when the model was workspace-billed.
  // cacheRead/cacheWrite are the prompt-cache subsets of inputTokens (the transport folds them in) so the meter can
  // price cached tokens at their own rates instead of the full input price.
  // Absent (no CONTROL_PLANE_INTERNAL_TOKEN) → agent-conversation cost isn't metered. docs/architecture/usage-metering.md
  reportUsage?: (usage: {
    workspace: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }) => Promise<void>;
}

export interface ChatResult {
  messages: AgentMessageRecord[]; // the newly produced tail (user echo + assistant/tool turns), seq-ordered
  // The turn's OWN spans, recorded live off the kernel's event stream (turn-spans.ts). This is the record the
  // control plane seals — the transcript projection stays as the fallback for a turn with no run to hang
  // under. It carries what the transcript never could: a model call's latency, the retries and fallbacks and
  // compactions around it, and a subagent as real nested work.
  spans?: TraceSpan[];
  // What the turn spent on the model, summed across the loop's calls. It already goes to the meter (billing);
  // this hands the SAME numbers to the ledger, so the turn's own run detail can state its cost instead of
  // leaving it to the invoice. Absent when the turn consumed nothing (an aborted turn before the first call).
  usage?: AgentTurnUsage;
  // How the kernel loop ENDED. Carried out so a HOST that bound this turn to a task envelope can act on the
  // envelope's own halt ("budget_exhausted") — the loop stops, and someone outside it owes the handoff.
  stopReason?: string;
}

// What a turn that died still knows about itself: the spans it recorded up to the failure (sealed with the
// reason on the root span) and what it had spent by then. `reason` is always present — even a turn that dies
// before the recorder exists (no model configured, an unreachable registry) leaves that much.
export interface FailedTurnEvidence {
  reason: string;
  spans?: TraceSpan[];
  usage?: AgentTurnUsage;
}

// Streaming hooks (SSE): onEvent forwards the loop's live events (text deltas, tool call/result); onRecord fires
// as each message (user, assistant, tool) is persisted, so the caller can push the structured record to the client.
export interface ChatHooks {
  onEvent?: (event: AgentEvent) => void;
  onRecord?: (record: AgentMessageRecord) => void;
  // The record of a turn that CANNOT return one. A turn that throws has usually already worked — model calls,
  // retries, tool calls, the upstream failure itself — and all of it lived only in the return value, so the
  // evidence vanished at exactly the moment a reader needs it (a failed turn left nothing in the ledger while
  // every succeeded one did). This is the failure path's channel to the same seal; the success path keeps
  // returning its evidence in `ChatResult`.
  onFailedTurn?: (evidence: FailedTurnEvidence) => void;
  // Fires as an analysis artifact (chart/table/report) is persisted — the SSE handler pushes it so the web
  // renders the artifact live in the transcript.
  onArtifact?: (record: AnalysisArtifactRecord) => void;
  // The agent drove the analysis canvas (apply_view_config) — the SSE handler streams the stored-form config so
  // the web applies it live. Present → the tool is registered; absent (headless turns) → no canvas tool.
  onViewConfig?: (config: Record<string, string>) => void;
  // The agent shaped the crafting canvas (craft_agent) — the SSE handler streams the patched draft so the web
  // applies it live. Present → the crafting tools are registered; absent (headless turns) → no crafting tools.
  onAgentDraft?: (draft: AgentDraft) => void;
  // Shadow-run the current draft against a simulated event (try_agent_draft) — the SSE handler binds runAgentTry
  // with the caller's own headers. Only meaningful beside onAgentDraft.
  tryAgentDraft?: (draft: AgentDraft, event: AgentTryEvent) => Promise<AgentTryResult>;
  // Human-in-the-loop approval for write (non-read-only) tool calls — the SSE handler supplies one that pauses the
  // loop, asks the web, and resolves allow/deny. Absent (buffered/API callers) → write tools auto-allow as before.
  permit?: PermissionHook;
  // The task envelope this turn runs inside (ownership O5), minus its scope. The caller states the boundary it
  // owns — goal, hard budgets, what exhaustion and scope-exceeding MEAN — and the scope is completed below from
  // the resolved tool registry, because the agent's granted capabilities only exist as names once tools are
  // built. Set by autonomous callers (the activation); deliberately UNSET for interactive chat, where a human
  // is present and refusing a tool they just asked for would be the gate misfiring, not working.
  // …and its SCOPE is optional, not absent: an ordinary activation lets the turn complete it from the
  // resolved toolset, while a role-bound task (a verifier) arrives with the scope that IS its guarantee.
  envelope?: Omit<TaskEnvelope, "scope"> & { scope?: TaskEnvelope["scope"] };
  // WHAT THE RUNTIME OBSERVED THIS TURN READING, per admitted object, with the call's OUTCOME. The kernel has
  // reported this since the resource guard existed and nothing consumed it — which left the verifier's
  // `reviewedResources` with no producer, and therefore no verdict able to claim it had looked INSIDE its
  // evidence. The resource scope proves a task could not read outside the evidence; this is the other half.
  //
  // Reported AFTER the call, so `success` means consumed rather than addressed: a verifier that reached for
  // all three of its refs and got a 404 on each would otherwise report full coverage — an affirmative built
  // on three failures.
  onResourceAccess?: (access: {
    target: { type: string; id: string };
    tool: string;
    outcome: "success" | "error";
  }) => void;
  // Mid-run steering: pull any user messages the web queued (POST /input) since this turn started, so the running loop
  // absorbs them at the next turn boundary instead of the user having to Stop and resend. Absent → strict turn-based.
  drainInput?: () => ChatMessage[];
  // Soft interrupt (Claude Code's ESC): receives the loop's step-interrupt trigger — aborts only the in-flight
  // step (model stream / tool batch); with queued input the turn continues redirected, bare it ends "interrupted".
  // The host parks the trigger (LiveTurnRegistry) so POST /interrupt can fire it. Absent → no soft interrupt.
  onInterruptReady?: (interrupt: () => void) => void;
  // Plan mode: start read-only; the agent must present_plan and have it approved (onPlan) before any write tool runs.
  // The SSE handler supplies onPlan to park for the human; absent onPlan → auto-approve.
  planMode?: boolean;
  // `expectedTools` (LESSON 059 P4): the write tools the plan declared — approval may pre-authorize them.
  onPlan?: (plan: string, expectedTools?: string[]) => boolean | Promise<boolean>;
  // Route send_message to a recipient that is not this run's own background sub-agent (another session/teammate), via
  // the host mailbox (S2 generalization). Absent → send_message only reaches this run's background sub-agents.
  sendMessage?: (
    to: string,
    message: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  // Spawn a persistent teammate (S3) — the host creates its session + execution token and returns its id. Present →
  // the agent gets a spawn_teammate tool (an agent, not just the web, spawns teammates). Absent → no spawn_teammate.
  // `watch` = platform event kinds the teammate should react to proactively (S4).
  spawnTeammate?: (name: string, task: string, watch: string[]) => Promise<{ id: string } | { error: string }>;
  // List the caller's teammates (S3 discovery) → the agent gets a list_teammates tool to coordinate them.
  listTeammates?: () => Promise<{ id: string; name: string; watch?: string[] }[]>;
}

export const DEFAULT_SESSION_TITLE = "New conversation";

// The transcript's record of a turn the member stopped. Claude Code's exact wording, deliberately: it is the
// established marker for this, and the next turn replays it verbatim so the model reads why its answer stops
// mid-thought. Exported so a reader (and a test) can recognise it rather than matching the string by hand.
export const INTERRUPTED_BY_USER = "[Request interrupted by user]";

// Built-in specialized sub-agent types the model can pick via spawn_agent(subagent_type). Instruction-only (their tools
// stay read-only; they inherit the workspace's sub-agent model tier if one is configured). A role prompt is the main
// lever for this control-plane assistant — the tools are the same read surface, but the framing differs.
const BUILTIN_SUBAGENT_TYPES: SubagentType[] = [
  {
    name: "explore",
    description: "a fast, broad read-only survey to locate the relevant runs/scorecards/harnesses across the workspace",
    instructions: "Survey broadly and quickly across the workspace to locate what is relevant to the task",
  },
  {
    name: "analyze",
    description: "a careful, deep analysis of one entity (a scorecard, a judge trace, a harness) and its details",
    instructions:
      "Analyze the specified entity carefully and thoroughly — inspect its details, failures, and edge cases before summarizing",
  },
  // Adversarial verification (Claude Code's built-in verification agent, reinterpreted for the eval domain). The
  // read-only sub-agent toolset is a QUALIFICATION here, not a limitation: a verifier must not mutate what it
  // verifies. Verification avoidance is the documented failure mode the role prompt counters — verdicts must cite
  // actual tool outputs, never narration of what would be checked.
  {
    name: "verify",
    description:
      "an adversarial verification pass over a claim or finished work — it tries to REFUTE, not confirm, and every verdict must cite read-tool evidence",
    instructions:
      "You are a verification specialist: try to BREAK the claim or work you were handed, not to confirm it. " +
      "Your documented failure mode is verification avoidance — narrating what you would check and writing PASS " +
      "without running anything. Actually call the read tools and cite their outputs as evidence for every point. " +
      "The polished first 80% is not the job: hunt the last 20% — edge cases, empty and error states, numbers " +
      "that don't reconcile, claims the underlying records contradict. End with a verdict of CONFIRMED, REFUTED, " +
      "or INSUFFICIENT EVIDENCE, each backed by the specific tool outputs (or naming exactly what evidence is " +
      "missing). Your read-only toolset is a qualification, not a limitation — a verifier must not mutate what " +
      "it verifies. Do the work with your (read-only) tools",
  },
];

export function contentToString(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

// Replay stored records into the OpenAI message shape the loop expects (assistant tool_calls ↔ tool results).
// Stored arguments pass through wellFormedArguments: records persisted before the kernel normalized at creation
// carry raw malformed fragments, and replaying one verbatim makes the provider reject every call — this is the
// read-time guard that heals an already-poisoned conversation on its next turn instead of requiring deletion.
function recordsToHistory(records: AgentMessageRecord[]): ChatMessage[] {
  return records.map((r): ChatMessage => {
    if (r.role === "assistant") {
      if (r.toolCalls && r.toolCalls.length > 0) {
        return {
          role: "assistant",
          // null (not omitted/"") alongside tool_calls — the shape providers accept for a tool-only turn.
          content: r.content.length > 0 ? r.content : null,
          tool_calls: r.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: wellFormedArguments(tc.arguments) },
          })),
        };
      }
      return { role: "assistant", content: r.content };
    }
    if (r.role === "tool") {
      return { role: "tool", tool_call_id: r.toolCallId ?? "", content: r.content };
    }
    return { role: "user", content: r.content };
  });
}

// Session running memory maintenance (Claude Code's session memory reinterpreted): once the bounded replay span
// outgrows the trigger, fold the oldest records — up to a clean USER boundary, keeping the recent tail verbatim —
// into a fresh digest seeded with the PREVIOUS digest (nothing falls off the end; the memory only rolls forward).
// Runs at the turn boundary on the host, decoupled from the loop's own in-run compaction: compaction fits ONE
// run's context, memory bounds what every FUTURE turn replays.
const MEMORY_TRIGGER_CHARS = 100_000; // ~25k tokens of replayed transcript before folding
const MEMORY_KEEP_RECENT = 20; // records kept verbatim after a fold (the conversation's working set)

export async function maintainSessionMemory(opts: {
  sessions: AgentSessionStore;
  workspace: string;
  sessionId: string;
  previousMemory: string | undefined;
  coveredThroughSeq: number | undefined;
  summarize: (span: ChatMessage[]) => Promise<string>;
  now: string;
  triggerChars?: number;
}): Promise<void> {
  const all = await opts.sessions.listMessages(opts.workspace, opts.sessionId);
  const coveredThrough = opts.coveredThroughSeq;
  const tail = coveredThrough === undefined ? all : all.filter((m) => m.seq > coveredThrough);
  const chars = (opts.previousMemory?.length ?? 0) + tail.reduce((n, m) => n + m.content.length, 0);
  if (chars < (opts.triggerChars ?? MEMORY_TRIGGER_CHARS) || tail.length <= MEMORY_KEEP_RECENT) return;
  // Cut at the first USER record at/after the keep boundary so the remaining tail replays balanced (an assistant
  // tool_call and its results never straddle the cut). No safe boundary → skip; next turn tries again.
  let cut = -1;
  for (let i = tail.length - MEMORY_KEEP_RECENT; i < tail.length; i++) {
    if (tail[i]?.role === "user") {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return;
  const oldSpan = tail.slice(0, cut);
  const throughSeq = oldSpan[oldSpan.length - 1]?.seq;
  if (throughSeq === undefined) return;
  const seeded: ChatMessage[] = [
    ...(opts.previousMemory !== undefined && opts.previousMemory.length > 0
      ? [{ role: "user", content: `[Previous conversation memory]\n${opts.previousMemory}` } satisfies ChatMessage]
      : []),
    ...recordsToHistory(oldSpan),
  ];
  const digest = (await opts.summarize(seeded)).trim();
  if (digest.length === 0) return; // the summariser declined — keep replaying in full rather than dropping context
  // The checklist survives the fold: the digest is a plain user message with no tool_calls, so once the last
  // write_todos call folds behind memoryThroughSeq the next turn's history bootstrap would silently reset the
  // todos mid-task. Append the machine-readable carryover (the latest state from the folded span or the previous
  // digest); a later write_todos in the kept tail still wins at replay (backward scan).
  const carriedTodos = extractTodosFromHistory(seeded);
  const withTodos = carriedTodos.length > 0 ? `${digest}\n\n${renderTodoCarryover(carriedTodos)}` : digest;
  await opts.sessions.setSessionMemory(opts.workspace, opts.sessionId, withTodos, throughSeq, opts.now);
}

export function extractToolCalls(message: ChatMessage): AgentToolCall[] | undefined {
  if (message.role !== "assistant") return undefined;
  const tcs = message.tool_calls;
  if (!tcs || tcs.length === 0) return undefined;
  const out: AgentToolCall[] = [];
  for (const tc of tcs) {
    if (tc.type !== "function") continue;
    out.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
  }
  return out.length > 0 ? out : undefined;
}

function deriveTitle(userText: string): string {
  const firstLine = userText.split("\n")[0]?.trim() ?? "";
  const title = firstLine.length > 0 ? firstLine : DEFAULT_SESSION_TITLE;
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

// One chat turn: persist the user message, replay history into the kernel, run the loop with the workspace's
// read-only MCP tools, then persist the produced assistant/tool transcript. Returns the new tail for the caller.
export async function runChat(
  deps: ChatDeps,
  principal: Principal,
  headers: ForwardHeaders,
  sessionId: string,
  userText: string,
  references?: AgentReference[],
  attachments?: AgentAttachmentInput[],
  signal?: AbortSignal,
  hooks?: ChatHooks,
  canvas?: CanvasState,
  agentDraft?: AgentDraftState,
): Promise<ChatResult> {
  const { workspace, subject } = principal;
  // Visibility-aware: the owner's own session OR a workspace-visible one (a comment-thread discussion session any
  // member may continue). Private sessions stay owner-only — the lookup behaves like getSession for them.
  const session = await deps.sessions.getVisibleSession(workspace, subject, sessionId);
  if (!session) throw new NotFoundError("NOT_FOUND", undefined, "Conversation not found.");

  const allMessages = await deps.sessions.listMessages(workspace, sessionId);
  let seq = allMessages.length === 0 ? 0 : Math.max(...allMessages.map((m) => m.seq)) + 1;
  // Bounded replay (session running memory): with a maintained digest, only the records AFTER the covered seq
  // replay verbatim — the digest leads the history as a synthetic user turn (memoryHistory below). Without one,
  // the whole transcript replays (the historical behaviour).
  const covered = session.memoryThroughSeq;
  const existing = covered === undefined ? allMessages : allMessages.filter((m) => m.seq > covered);
  const memoryHistory: ChatMessage[] =
    session.memory !== undefined && session.memory.length > 0
      ? [
          {
            role: "user",
            content: `[Conversation memory — a digest of the earlier part of this conversation. Continue from it; the original messages are not replayed.]\n\n${session.memory}`,
          },
        ]
      : [];

  const userRecord: AgentMessageRecord = {
    id: deps.newId(),
    tenant: workspace,
    sessionId,
    seq: seq++,
    role: "user",
    content: userText,
    ...(references && references.length > 0 ? { references } : {}),
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            name: a.name,
            ...(a.mimeType !== undefined ? { mimeType: a.mimeType } : {}),
            ...(a.size !== undefined ? { size: a.size } : {}),
          })),
        }
      : {}),
    createdAt: deps.now(),
  };
  await deps.sessions.appendMessages([userRecord]);
  hooks?.onRecord?.(userRecord);

  const producedRecords: AgentMessageRecord[] = [];
  const messageToRecord = (message: ChatMessage): AgentMessageRecord | null => {
    if (message.role === "assistant") {
      const toolCalls = extractToolCalls(message);
      // The loop attaches the turn's reasoning as a side-channel (ReasoningCarrier) on the assistant message; persist
      // its display text so the transcript can re-render the thought process (the native thinking blocks aren't stored).
      const reasoning = (message as ReasoningCarrier).reasoning?.text;
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "assistant",
        content: contentToString(message.content),
        ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
        createdAt: deps.now(),
      };
    }
    if (message.role === "tool") {
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "tool",
        content: contentToString(message.content),
        toolCallId: message.tool_call_id,
        createdAt: deps.now(),
      };
    }
    // A user turn reaching the persist path is a mid-run steering message the loop injected via drainInput — persist it
    // so the conversation history keeps it (the initial user message is persisted separately, before the loop).
    if (message.role === "user") {
      return {
        id: deps.newId(),
        tenant: workspace,
        sessionId,
        seq: seq++,
        role: "user",
        content: contentToString(message.content),
        createdAt: deps.now(),
      };
    }
    return null;
  };
  // Persist each assistant/tool turn the moment the loop produces it, so a polling client sees tool activity as it
  // happens (not only after the whole loop settles).
  const persist = async (message: ChatMessage): Promise<void> => {
    const record = messageToRecord(message);
    if (!record) return;
    await deps.sessions.appendMessages([record]);
    producedRecords.push(record);
    hooks?.onRecord?.(record);
  };

  // Resolve the workspace's agent customization (Phase 1): system prompt (base + instructions), MCP tool servers, and
  // an optional model override. A trigger-activated run resolves the CRAFTED agent's config (origin.agentId) — its
  // instructions/tools/model are its identity; everything else keeps the workspace chat default.
  const profile = deps.resolveProfile ? await deps.resolveProfile(principal, session.origin?.agentId) : undefined;
  const systemPrompt = profile?.systemPrompt ?? deps.systemPrompt;

  // The MCP session carries this conversation's identity, so anything the agent publishes through the control
  // plane (workspace files) is attributed to the agent + conversation rather than looking like the member's edit.
  const tools = await deps.toolProvider(
    {
      ...headers,
      conversationId: sessionId,
      ...(session.origin?.agentId !== undefined ? { agentId: session.origin.agentId } : {}),
      // P3 causedBy: the run behind this turn — the CP stamps agent-submitted scorecards/runs with it.
      ...(session.runId !== undefined ? { runId: session.runId } : {}),
    },
    profile?.mcpServers ?? [],
    profile?.skills ?? [],
    profile?.codeTools ?? [],
  );
  // Artifact emission tools (analysis-studio V2) — native, per-turn (they carry this session's identity). The
  // registry is immutable, so extend it with a wrapper when a store is wired.
  const artifactTools = deps.artifacts
    ? buildArtifactTools({
        artifacts: deps.artifacts,
        tenant: workspace,
        sessionId,
        createdBy: principal.subject,
        now: deps.now,
        newId: deps.newId,
        ...(hooks?.onArtifact ? { onArtifact: hooks.onArtifact } : {}),
      })
    : [];
  // Canvas control (analysis-studio V3) — only a live web chat wires onViewConfig, so headless turns never
  // carry a tool that has no canvas to drive.
  const canvasTools = hooks?.onViewConfig ? [buildViewConfigTool(hooks.onViewConfig)] : [];
  // Crafting control (agent-automation B2/B3) — same rule: only a live crafting chat wires onAgentDraft.
  const draftTools = hooks?.onAgentDraft
    ? buildAgentDraftTools({
        initial: agentDraft?.draft ?? {},
        onDraft: hooks.onAgentDraft,
        ...(hooks.tryAgentDraft ? { tryDraft: hooks.tryAgentDraft } : {}),
      })
    : [];
  const analysisScriptTool = deps.analysisScriptRuntime ? buildRunAnalysisTool(deps.analysisScriptRuntime) : undefined;
  const extraTools = [
    ...artifactTools,
    ...canvasTools,
    ...draftTools,
    ...(analysisScriptTool ? [analysisScriptTool] : []),
  ];
  const registry = extraTools.length > 0 ? new ToolRegistry([...tools.registry.list(), ...extraTools]) : tools.registry;
  // Declared out here because the model and its token counters live inside the turn block, while the result
  // this function returns is assembled after it.
  let turnUsage: ChatResult["usage"];
  // How the loop ended, carried out of the try so the caller sees it. A host that bound this turn to a task
  // envelope acts on "budget_exhausted": the kernel halts, and the handoff is owed by whoever set the boundary.
  let turnStopReason: string | undefined;
  // Declared at TURN scope: the recorder is built once the model is resolved (inside the block below) and
  // sealed after the loop returns, so both halves need to see the same binding.
  let spanRecorder: TurnSpanRecorder | undefined;
  try {
    // Fold any @-referenced entity context into the user turn the model sees (the persisted record keeps the
    // clean text + the reference metadata separately).
    const preambles: string[] = [];
    if (canvas) preambles.push(buildCanvasPreamble(canvas));
    if (agentDraft) preambles.push(buildDraftPreamble(agentDraft));
    if (attachments && attachments.length > 0) {
      const attPreamble = buildAttachmentPreamble(attachments);
      if (attPreamble) preambles.push(attPreamble);
    }
    // Workspace auto-memory: the memory/ index rides EVERY turn (one best-effort fs read) — unlike knowledge
    // recall it is not gated on references, because memory is exactly the context a plain question can't anchor.
    if (tools.call) {
      const memory = await workspaceMemoryPreamble(tools.call, Date.now(), memberMemoryDirectoryFor(principal.subject));
      if (memory) preambles.push(memory);
    }
    if (references && references.length > 0 && tools.call) {
      preambles.push(await resolveReferences(tools.call, references));
      // Auto-recall: what the workspace already knows about those anchors rides along (best-effort, one call).
      const recalled = await recallKnowledge(tools.call, references);
      if (recalled) preambles.push(recalled);
    }
    // Stale-file reminders: files this conversation touched that someone ELSE has revised since (zero ledger
    // calls when the conversation never touched a file).
    if (tools.call) {
      const stale = await staleFileReminder(tools.call, existing, sessionId);
      if (stale) preambles.push(stale);
    }
    // The APPROVED PLAN is the conversation's standing goal (LESSON 059 P6): it lives on the session record —
    // surviving the memory fold (whose digest may drop the detail) and a service restart — and every later
    // turn re-reads it here. A plan that only lived in the transcript stopped steering the moment bounded
    // replay dropped it. Capped so a very long plan cannot crowd the turn.
    if (session.plan) {
      preambles.push(
        [
          "<system-reminder>",
          `An approved plan from earlier in this conversation is still standing (approved ${session.plan.approvedAt}):`,
          "",
          session.plan.content.length > 6000
            ? `${session.plan.content.slice(0, 6000)}\n…(truncated)`
            : session.plan.content,
          "",
          "If it is relevant to the current work and not already complete, continue working through it. Ignore it only if the member has since changed direction.",
          "</system-reminder>",
        ].join("\n"),
      );
    }
    const userForModel =
      preambles.length > 0 ? `${preambles.join("\n\n")}\n\n---\n\nUser message:\n${userText}` : userText;
    const history: ChatMessage[] = [
      ...memoryHistory,
      ...recordsToHistory(existing),
      { role: "user", content: userForModel },
    ];
    // Which registered model powers this turn, in priority order: the conversation's own pick (session.model, set in
    // the chat) → the workspace AgentSpec's model (Settings › Agent) → the agent server's default model.
    // (`spanRecorder` is declared at turn scope below the loop's block so the seal can reach it.)
    const modelRef = session.model ?? profile?.model;
    const model =
      modelRef && deps.resolveModelById
        ? await deps.resolveModelById(principal, modelRef)
        : await deps.resolveModel(principal);
    // Append the per-turn environment block (workspace · model · date) now that the model is resolved.
    const systemWithEnv = `${systemPrompt}\n\n${buildEnvironmentSection({
      workspace,
      model: model.model,
      date: deps.now(),
      taskDirectory: `tasks/${sessionId}`, // per-task separation on the workspace filesystem

      ...(deps.webBaseUrl !== undefined ? { webBaseUrl: deps.webBaseUrl } : {}),
      ...(deps.desktopDownloadUrl !== undefined ? { desktopDownloadUrl: deps.desktopDownloadUrl } : {}),
    })}`;

    // Model tiering (both need the by-id resolver). The summariser is LAZY — the cheaper model is only resolved if a
    // compaction actually fires — so a normal turn pays nothing. The fallback is resolved up front (opt-in per
    // workspace) so it's ready the moment the main model starts failing.
    const byId = deps.resolveModelById;
    // Tier precedence: the resolved model's OWN companions first (the workspace's catalog decision — the model
    // spec is where a workspace tunes the agent it powers), then the deployment AGENT_*_MODEL defaults.
    const smallRef = model.companions?.small ?? deps.smallModelRef;
    const fallbackRef = model.companions?.fallback ?? deps.fallbackModelRef;
    const subagentRef = model.companions?.subagent ?? deps.subagentModelRef;
    // A tier that fails to resolve degrades to "no tier", never a dead conversation: a companion ref is ordinary
    // workspace catalog data (a member can delete the model it points at), and a missing fallback/subagent tier
    // only loses an optimization — failing every turn over it would punish the wrong party.
    const resolveTier = async (
      ref: string | undefined,
      tier: string,
    ): Promise<{ transport: LlmTransport; model: string } | undefined> => {
      if (!ref || !byId) return undefined;
      try {
        const resolved = await byId(principal, ref);
        return { transport: resolved.transport, model: resolved.model };
      } catch (err) {
        console.error(
          `[agent] ${tier} model "${ref}" failed to resolve — continuing without it: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    };
    const summarize =
      smallRef && byId
        ? async (span: ChatMessage[]): Promise<string> => {
            const small = await byId(principal, smallRef);
            return buildSummarizer(small.transport, small.model)(span);
          }
        : undefined;
    const fallback = await resolveTier(fallbackRef, "fallback");
    const subagentModel = await resolveTier(subagentRef, "subagent");

    // Spawnable sub-agent types: the builtins + the workspace's crafted agents (name collisions keep the
    // builtin — explore/analyze/verify are the stable vocabulary the base prompt teaches). Best-effort.
    const crafted = deps.listSubagentTypes ? await deps.listSubagentTypes(principal) : [];
    const builtinNames = new Set(BUILTIN_SUBAGENT_TYPES.map((t) => t.name));
    const subagentTypes = [...BUILTIN_SUBAGENT_TYPES, ...crafted.filter((t) => !builtinNames.has(t.name))];

    // Meter the loop's resilience events into Prometheus series (fired before the host hook, so a throwing SSE
    // writer can never skip a count). Cheap no-op without a Metrics instance (dev).
    // The turn's span recorder — live, not reconstructed. Needs a run to belong to; a turn with none (a
    // dry-run/preview path) simply records nothing and falls back to the transcript projection.
    spanRecorder =
      session.runId !== undefined
        ? new TurnSpanRecorder({
            traceId: traceIdForRun(session.runId),
            agentName: session.origin?.agentId ?? "agent",
            conversationId: sessionId,
            model: model.model,
            input: userText,
          })
        : undefined;

    const meter = (e: AgentEvent): void => {
      const m = deps.metrics;
      if (!m) return;
      if (e.type === "retry")
        m.counter("everdict_agent_retry_total", "Model-call retry waits in agent turns", {
          persistent: e.persistent === true ? "true" : "false",
        });
      else if (e.type === "fallback")
        m.counter("everdict_agent_fallback_total", "Agent runs switched to the fallback model");
      else if (e.type === "truncated")
        m.counter("everdict_agent_truncated_total", "Agent turns that hit the output-token cap");
      else if (e.type === "compaction")
        m.counter("everdict_agent_compaction_total", "In-run compaction steps", { mode: e.mode ?? "unknown" });
      else if (e.type === "tool_result")
        m.counter("everdict_agent_tool_result_total", "Agent tool results", { ok: e.isError ? "false" : "true" });
      else if (e.type === "done")
        m.counter("everdict_agent_turn_total", "Agent chat turns by stop reason", { outcome: e.stopReason });
    };
    const turnStartedMs = Date.now();

    // Accumulate this conversation's token usage across turns (the loop reports tokens; the control plane prices them).
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    try {
      const loopResult = await runAgentLoop({
        transport: model.transport,
        model: model.model,
        systemPrompt: systemWithEnv,
        history,
        registry,
        onMessage: persist,
        onUsage: (u) => {
          inputTokens += u.inputTokens;
          outputTokens += u.outputTokens;
          cacheReadTokens += u.cacheReadTokens ?? 0;
          cacheWriteTokens += u.cacheWriteTokens ?? 0;
          // Cache effectiveness as a measured distribution, not just a billing line: how much of each call's
          // prompt footprint was served from / written to the provider's prompt cache vs paid at full price.
          // A cache_read share near zero under load is the "silent invalidator at work" alarm.
          const m = deps.metrics;
          if (m) {
            const read = u.cacheReadTokens ?? 0;
            const write = u.cacheWriteTokens ?? 0;
            const help = "Agent prompt tokens by cache outcome";
            const uncached = Math.max(u.inputTokens - read - write, 0);
            if (uncached > 0) m.counter("everdict_agent_prompt_tokens_total", help, { kind: "uncached" }, uncached);
            if (read > 0) m.counter("everdict_agent_prompt_tokens_total", help, { kind: "cache_read" }, read);
            if (write > 0) m.counter("everdict_agent_prompt_tokens_total", help, { kind: "cache_write" }, write);
          }
        },
        ...(summarize ? { summarize } : {}),
        ...(fallback ? { fallback } : {}),
        ...(subagentModel ? { subagentModel } : {}),
        subagentTypes,
        ...(deps.toolTimeoutMs !== undefined ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
        ...(deps.persistentRetry === true ? { persistentRetry: true } : {}),
        ...(deps.thinkingBudgetTokens !== undefined ? { thinking: { budgetTokens: deps.thinkingBudgetTokens } } : {}),
        onEvent: (e) => {
          meter(e);
          spanRecorder?.observe(e);
          hooks?.onEvent?.(e);
        },
        // O5: the envelope's scope is completed HERE because this is where the agent's granted capabilities
        // finally exist as tool names. Pinning them at task start is the point — a tool that attaches
        // mid-run (a server connected later) is outside the scope this task was authorized under, not
        // silently inside it. The split states what the runtime actually enforces: reads "all" (the
        // executor posture — reads are the agent's senses), writes = the WRITE-capable tools present at
        // start. The kernel adds its own control tools (todo, read_result, plan, wait) on top and those are
        // all read-only, so they ride the reads posture; a future write-capable kernel tool would need
        // listing in `writes` deliberately, and the test says so. Narrowing writes below "everything
        // granted" is a product decision (teammate bounding) deferred with it. The domain guard runs at
        // this compose point — the only place the FULL envelope exists — so an unbudgeted envelope never
        // reaches the kernel.
        ...(hooks?.envelope
          ? {
              envelope: (() => {
                // A DECLARED scope is kept, never "completed" (arch-review 23, verifier wiring). The posture
                // below is the DEFAULT for an activation that arrives without one — it is not an override.
                // A role-bound task (a verifier) has its scope decided before it is spawned, and that scope
                // IS the guarantee: widening it here to `reads: "all"` plus every write tool, and dropping
                // `resources` on the way, would hand the kernel a different envelope than the one the spawn
                // site built and the trust suite certifies. The guards would then enforce, faithfully, a
                // boundary nobody meant.
                const composed = {
                  ...hooks.envelope,
                  scope: hooks.envelope.scope ?? {
                    reads: "all" as const,
                    writes: registry
                      .list()
                      .filter((t) => t.isReadOnly !== true)
                      .map((t) => t.name),
                    forbidden: [],
                  },
                };
                assertTaskEnvelope(composed);
                return composed;
              })(),
            }
          : {}),
        ...(hooks?.onResourceAccess ? { onResourceAccess: hooks.onResourceAccess } : {}),
        ...(hooks?.permit ? { permit: hooks.permit } : {}),
        ...(hooks?.drainInput ? { drainInput: hooks.drainInput } : {}),
        ...(hooks?.onInterruptReady ? { onInterruptReady: hooks.onInterruptReady } : {}),
        ...(hooks?.planMode ? { planMode: hooks.planMode } : {}),
        ...(hooks?.onPlan ? { onPlan: hooks.onPlan } : {}),
        ...(hooks?.sendMessage ? { sendMessage: hooks.sendMessage } : {}),
        ...(hooks?.spawnTeammate ? { spawnTeammate: hooks.spawnTeammate } : {}),
        ...(hooks?.listTeammates ? { listTeammates: hooks.listTeammates } : {}),
        ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
        ...(deps.waitableEventKinds && deps.waitableEventKinds.length > 0
          ? { waitFor: { kinds: deps.waitableEventKinds } }
          : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
        ...(signal ? { signal } : {}),
      });
      // An interruption is a conversation CITIZEN too (Claude Code parity, same rule as the failure record
      // below): a turn the member stopped — whole-turn abort or a bare soft interrupt — says so in the
      // transcript. Without it the history ends on a user turn nobody answered, so the next turn appends a
      // second user message straight after the first and neither the member nor the model can tell what
      // happened. The partial answer itself was already committed by the kernel; this is the line after it.
      // Best-effort: a store write must not turn a clean cancellation into a failure.
      turnStopReason = loopResult.stopReason;
      if (loopResult.stopReason === "aborted" || loopResult.stopReason === "interrupted") {
        try {
          await persist({ role: "assistant", content: INTERRUPTED_BY_USER });
        } catch {}
      }
      // Arm (or disarm) the conversation's wake intent — the durable half of "waiting". The host owns the clock:
      // the kernel says WHAT to wait for, we stamp WHEN it expires. Rearmed every turn, so an agent that waits
      // again after a resume simply replaces its own intent, and a turn that ends normally clears it (the agent
      // stopped watching). Best-effort by design: failing to park must not fail a turn the member already saw.
      const parked = loopResult.waitRequest;
      if (parked || session.wakeIntent) {
        try {
          await deps.sessions.setSessionWakeIntent(
            workspace,
            sessionId,
            parked ? toWakeIntent(parked, deps) : null,
            deps.now(),
          );
        } catch (err) {
          console.error(`[agent] failed to park wake intent (${workspace}/${sessionId}): ${String(err)}`);
        }
      }
    } finally {
      // The ledger's copy of the same numbers (O2): the turn's model spend travels back to the caller, which
      // projects it into the sealed trajectory as an llm_call — so the run detail can state what the turn cost
      // instead of the invoice being the only place it exists. Recorded whatever the billing rule says: an
      // own-pays/personal-key turn still SPENT these tokens, and evidence is not an invoice.
      if (inputTokens + outputTokens > 0) turnUsage = { model: model.model, inputTokens, outputTokens };
      // Meter the conversation's LLM cost against the workspace when it ran on a workspace-billed model — the same
      // rule as the harness (own-pays/personal-key/dev conversations are not metered). In a finally so a FAILED or
      // aborted turn's consumed tokens are still billed. Best-effort: never fail the chat.
      if (model.billed && deps.reportUsage && inputTokens + outputTokens > 0) {
        try {
          await deps.reportUsage({
            workspace,
            model: model.model,
            inputTokens,
            outputTokens,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
          });
        } catch {}
      }
      // Turn wall-clock, success or not — the latency half of the "why do turns die" distribution.
      deps.metrics?.observe(
        "everdict_agent_turn_seconds",
        "Agent chat turn duration",
        {},
        (Date.now() - turnStartedMs) / 1000,
      );
    }

    // Maintain the session's running memory at the turn boundary (successful turns only — a failed turn changed
    // little and rethrew above). Best-effort: a summariser/store failure skips maintenance; next turn retries.
    try {
      await maintainSessionMemory({
        sessions: deps.sessions,
        workspace,
        sessionId,
        previousMemory: session.memory,
        coveredThroughSeq: session.memoryThroughSeq,
        // The same tier rule as in-run compaction: the cheap summariser when configured, else the turn's own model.
        summarize: summarize ?? buildSummarizer(model.transport, model.model),
        now: deps.now(),
        ...(deps.memoryTriggerChars !== undefined ? { triggerChars: deps.memoryTriggerChars } : {}),
      });
    } catch {}

    // Turn-end auto extraction (opt-in; small tier only; the safety net BEHIND the inline writer — a turn that
    // already wrote under memory/ stands down). Best-effort like everything else at this boundary.
    if (deps.memoryExtraction === true && smallRef && byId && tools.call && !turnWroteMemory(producedRecords)) {
      try {
        const small = await byId(principal, smallRef);
        const outcome = await maintainMemoryExtraction({
          call: tools.call,
          extract: buildMemoryExtractor(small.transport, small.model),
          turn: [{ role: "user", content: userText }, ...recordsToHistory(producedRecords)],
          memberDirectory: memberMemoryDirectoryFor(principal.subject),
        });
        deps.metrics?.counter("everdict_agent_memory_extraction_total", "Turn-end auto memory extraction outcomes", {
          outcome,
        });
      } catch {}
    }
  } catch (err) {
    // Failure is a conversation CITIZEN, not just an exception (Claude Code parity): persist why the turn died
    // as an assistant record before rethrowing, so the transcript shows the failure and the conversation stays
    // continuable — the next turn replays a balanced history (normalizeHistory pairs any dangling tool_calls).
    // A user abort is not a failure. Best-effort: a store write must not mask the original error.
    // A thrown turn never reached the loop's done event — count it under its own outcome.
    // This catch wraps the WHOLE turn, not just the loop: a turn that dies BEFORE the first model call (no model
    // configured, an unreachable model registry, a dead tool session) used to leave the member's message sitting
    // there with no answer and no reason — a silent death reads as "the agent ignored me".
    deps.metrics?.counter("everdict_agent_turn_total", "Agent chat turns by stop reason", { outcome: "error" });
    // Seal what the turn DID before it died and hand it to the caller — the loop's own record (a model call's
    // latency, the retries around it, a tool that never returned), ended with the reason it stopped. Without
    // this the recorder was discarded on the throw and the turn left no evidence at all.
    const reason = signal?.aborted === true ? "the turn was stopped" : err instanceof Error ? err.message : String(err);
    const failedSpans = spanRecorder?.seal(turnUsage, reason);
    hooks?.onFailedTurn?.({
      reason,
      ...(failedSpans && failedSpans.length > 0 ? { spans: failedSpans } : {}),
      ...(turnUsage ? { usage: turnUsage } : {}),
    });
    if (signal?.aborted !== true) {
      const detail = err instanceof Error ? err.message : String(err);
      // The operator's copy of the same failure. The transcript record below is the MEMBER's copy; without this
      // line a turn that dies on the provider leaves no trace at all in the service log, so "the model provider
      // call failed" is all anyone — member or operator — ever gets.
      console.error(`[agent] chat turn failed (${workspace}/${sessionId}): ${detail}`);
      try {
        await persist({
          role: "assistant",
          content: `[The turn failed: ${detail}] The conversation is intact — send a message to continue.`,
        });
      } catch {}
    }
    throw err;
  } finally {
    await tools.close();
  }

  const nextTitle = session.title === DEFAULT_SESSION_TITLE ? deriveTitle(userText) : undefined;
  await deps.sessions.touchSession(workspace, sessionId, deps.now(), nextTitle);

  const spans = spanRecorder?.seal(turnUsage);
  return {
    messages: [userRecord, ...producedRecords],
    ...(turnUsage ? { usage: turnUsage } : {}),
    ...(spans && spans.length > 0 ? { spans } : {}),
    ...(turnStopReason !== undefined ? { stopReason: turnStopReason } : {}),
  };
}
