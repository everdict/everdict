import type { ChatMessage, McpInvoke } from "@everdict/agent-runtime";
import type { AgentMessageRecord } from "@everdict/contracts";
import type { LlmTransport } from "@everdict/llm";

// The agents' cross-conversation memory area on the workspace filesystem. Owned here (not chat.ts) so the
// extraction below and the recall preamble share one definition without an import cycle.
export const MEMORY_DIRECTORY = "memory";
export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MEMORY_INDEX_PATH = `${MEMORY_DIRECTORY}/${MEMORY_INDEX_FILE}`;

// Turn-end auto extraction (Claude Code's extractMemories reinterpreted): after a successful turn, a SMALL-model
// pass decides whether the turn produced ONE durable workspace memory the inline discipline missed, and the HOST
// performs the write — the extractor model returns a structured decision only and never holds tools (the same
// containment Claude Code gets from its memory-dir-only canUseTool). Deliberately opt-in (AGENT_MEMORY_EXTRACTION)
// and small-tier-only: an extra model call per qualifying turn is a cost profile an operator chooses, never a
// silent default. The main agent remains the PRIMARY memory writer (the system prompt's Memory section); this is
// the safety net behind it, so a turn that already wrote under memory/ skips extraction entirely.

const EXTRACTION_SYSTEM_PROMPT = [
  "You review one finished agent-conversation turn and decide whether it produced ONE durable workspace memory —",
  "context future conversations will need that is NOT derivable from the workspace's own state.",
  "Save only: a member fact (role, expertise, preferences), feedback on how to work (a correction OR an approach",
  "the member confirmed, with why), ongoing project context recorded nowhere else, or a pointer to an external",
  "resource. Do NOT save: anything the workspace already records (scorecards, runs, specs, knowledge entries,",
  "skills, files), transient task state, restatements of the member's request, secrets or credentials (NEVER),",
  "or anything the memory index shown to you already covers. When unsure, do not save. At most ONE memory —",
  "the single most durable fact of the turn.",
  "Reply with STRICT JSON only — no prose, no code fences. Either:",
  '{"save": false}',
  "or:",
  '{"save": true, "slug": "<kebab-case-file-slug>", "type": "member|feedback|project|reference",',
  ' "title": "<short title>", "description": "<one line — future turns judge relevance by it>",',
  ' "hook": "<one-line index hook>", "body": "<the fact; for feedback/project follow it with a Why: line and a How to apply: line>"}',
].join("\n");

const MAX_TURN_TRANSCRIPT_CHARS = 12_000;
const MIN_TURN_CHARS = 400; // a trivial turn is never worth a model call
const MAX_BODY_CHARS = 4_000;
const MAX_LINE_CHARS = 300;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const MEMORY_TYPES = new Set(["member", "feedback", "project", "reference"]);

// One extraction decision, bound to the small tier's transport — a single non-tool completion, like the summariser.
export function buildMemoryExtractor(
  transport: LlmTransport,
  model: string,
): (indexContent: string, turnTranscript: string) => Promise<string> {
  return async (indexContent, turnTranscript) => {
    const result = await transport.stream({
      model,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Current memory index (already-saved memories):\n${indexContent.length > 0 ? indexContent : "(no memories yet)"}\n\n---\n\nThe finished turn:\n${turnTranscript}\n\nDecide per the instructions. Strict JSON only.`,
        },
      ],
      tools: [],
    });
    return result.content ?? "";
  };
}

// Did this turn already write under memory/? Then the primary writer did its job and the safety net stands down —
// the same mutual exclusion Claude Code's hasMemoryWritesSince cursor provides.
export function turnWroteMemory(records: AgentMessageRecord[]): boolean {
  for (const r of records) {
    if (r.role !== "assistant" || !r.toolCalls) continue;
    for (const tc of r.toolCalls) {
      if (tc.name !== "write_file" && tc.name !== "move_file" && tc.name !== "delete_file") continue;
      try {
        const args = JSON.parse(tc.arguments) as { path?: unknown; to?: unknown };
        const paths = [args.path, args.to].filter((p): p is string => typeof p === "string");
        if (paths.some((p) => p.replace(/^\/+/, "").startsWith(`${MEMORY_DIRECTORY}/`))) return true;
      } catch {
        // unparsable arguments — not a memory write
      }
    }
  }
  return false;
}

function renderTurn(turn: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of turn) {
    const text = typeof m.content === "string" ? m.content : "";
    if (text.length > 0) lines.push(`${m.role}: ${text}`);
  }
  const rendered = lines.join("\n");
  return rendered.length > MAX_TURN_TRANSCRIPT_CHARS ? rendered.slice(-MAX_TURN_TRANSCRIPT_CHARS) : rendered;
}

interface SaveDecision {
  slug: string;
  type: string;
  title: string;
  description: string;
  hook: string;
  body: string;
}

// Parse + validate the extractor's decision. undefined = don't save (a malformed reply is treated as "no", never
// as an error worth failing a turn over — the extractor is a safety net, not a critical path).
function parseDecision(raw: string): SaveDecision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const d = parsed as Record<string, unknown>;
  if (d.save !== true) return undefined;
  const { slug, type, title, description, hook, body } = d;
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return undefined;
  if (typeof type !== "string" || !MEMORY_TYPES.has(type)) return undefined;
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_LINE_CHARS) return undefined;
  if (typeof description !== "string" || description.length === 0 || description.length > MAX_LINE_CHARS)
    return undefined;
  if (typeof hook !== "string" || hook.length === 0 || hook.length > MAX_LINE_CHARS) return undefined;
  if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY_CHARS) return undefined;
  return { slug, type, title, description, hook, body };
}

export type MemoryExtractionOutcome = "saved" | "skipped" | "failed";

// Run the turn-end extraction: read the index, ask the small model, and — only on a valid save decision — publish
// the topic file (expect-create: an existing slug is a skip, never an overwrite) and append the index line under
// the optimistic lock. Every failure degrades to an outcome, never a throw: memory must never fail a turn.
export async function maintainMemoryExtraction(opts: {
  call: McpInvoke;
  extract: (indexContent: string, turnTranscript: string) => Promise<string>;
  turn: ChatMessage[];
  // The acting member's own memory area. A `member` memory — who they are, how they like to work — lands there
  // instead of the shared area, because publishing one person's preferences to the whole workspace is a
  // different act from recording what the workspace learned. Absent (an unattributed job) = shared only.
  memberDirectory?: string;
}): Promise<MemoryExtractionOutcome> {
  try {
    const transcript = renderTurn(opts.turn);
    if (transcript.length < MIN_TURN_CHARS) return "skipped";

    // The index rides into the prompt so "already covered" is decidable; absent index = empty workspace memory.
    let indexContent = "";
    let indexRevision: number | undefined;
    const indexRead = await opts.call("get_file", { path: MEMORY_INDEX_PATH });
    if (!indexRead.isError) {
      const file = JSON.parse(indexRead.content) as { content?: unknown; entry?: { revision?: unknown } };
      if (typeof file.content === "string") indexContent = file.content;
      if (typeof file.entry?.revision === "number") indexRevision = file.entry.revision;
    }

    const decision = parseDecision(await opts.extract(indexContent, transcript));
    if (!decision) return "skipped";

    // WHERE it lands. A `member` memory is about the person in this conversation, so it goes to their own area
    // when they have one; everything else is what the workspace learned and stays shared. The scope decides the
    // whole path pair — body and index line must never end up in different areas.
    const personal = decision.type === "member" && opts.memberDirectory !== undefined;
    const directory = personal && opts.memberDirectory !== undefined ? opts.memberDirectory : MEMORY_DIRECTORY;
    const indexPath = `${directory}/${MEMORY_INDEX_FILE}`;
    let scopeIndex = indexContent;
    let scopeIndexRevision = indexRevision;
    if (personal) {
      // The member's index is a different file with its own revision — re-read it rather than writing the shared
      // index's revision number onto it (which would either fail the lock or clobber whatever is there).
      scopeIndex = "";
      scopeIndexRevision = undefined;
      const mine = await opts.call("get_file", { path: indexPath });
      if (!mine.isError) {
        const file = JSON.parse(mine.content) as { content?: unknown; entry?: { revision?: unknown } };
        if (typeof file.content === "string") scopeIndex = file.content;
        if (typeof file.entry?.revision === "number") scopeIndexRevision = file.entry.revision;
      }
    }

    // Publish the topic file first (base_revision 0 = "I expect to create this"): a slug that already exists is
    // someone else's memory — skip rather than overwrite, and leave the index alone.
    const bodyFile = `---\nname: ${decision.slug}\ndescription: ${decision.description}\ntype: ${decision.type}\n---\n\n${decision.body}\n`;
    const wrote = await opts.call("write_file", {
      path: `${directory}/${decision.slug}.md`,
      content: bodyFile,
      base_revision: 0,
      message: "auto-extracted at turn end",
    });
    if (wrote.isError) return "skipped"; // exists already, or the secret guard refused — either way not ours to force

    const line = `- [${decision.title}](${decision.slug}.md) — ${decision.hook}`;
    const nextIndex =
      scopeIndex.trim().length > 0
        ? `${scopeIndex.replace(/\n+$/, "")}\n${line}\n`
        : `# ${personal ? "My Memory" : "Workspace Memory"}\n\n${line}\n`;
    const indexed = await opts.call("write_file", {
      path: indexPath,
      content: nextIndex,
      ...(scopeIndexRevision !== undefined ? { base_revision: scopeIndexRevision } : { base_revision: 0 }),
      message: "auto-extracted at turn end",
    });
    // A lost index race leaves the body published but unlisted — the consolidation pass reconciles exactly that
    // (files missing from the index are step-1 defects), so we don't retry here.
    return indexed.isError ? "skipped" : "saved";
  } catch {
    return "failed";
  }
}
