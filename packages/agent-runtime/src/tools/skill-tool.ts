import type { NodeRef, SkillFile } from "@everdict/contracts";
import type { ToolDefinition, ToolResult } from "./definition.js";

// The freshness state the control plane computes for a skill (the knowledge-layer staleness contract — see
// docs/architecture/knowledge-graph.md §Skills join the graph). Carried through so the agent uses an old procedure
// KNOWING it is old: `superseded_refs` = a version the skill documents has moved on; `unverified` = nobody has
// confirmed the procedure recently.
export interface SkillFreshness {
  state: "fresh" | "superseded_refs" | "unverified";
  staleRefs?: { ref: NodeRef; latest: string }[];
}

// A workspace skill made available to the agent: a name + a discovery line (description) + the full procedure (body)
// + optional supporting files. Claude-Code-style progressive disclosure, three tiers: the name + description are cheap
// and always visible (listed in the use_skill tool description, within a character budget), the body is loaded on
// demand via use_skill, and each supporting file is loaded individually via read_skill_file — so a large skill costs
// its discovery line until the moment it is actually needed, and its reference material costs nothing until read.
export interface SkillEntry {
  name: string;
  description: string;
  instructions: string;
  files?: SkillFile[]; // supporting reference files (absent/empty = a body-only skill)
  freshness?: SkillFreshness; // control-plane-computed staleness (absent = no signal, treated as fresh)
}

export const USE_SKILL_TOOL_NAME = "use_skill";
export const READ_SKILL_FILE_TOOL_NAME = "read_skill_file";

// Listing budget (Claude Code parity): every skill always appears — only descriptions shrink. Per-entry descriptions
// are hard-capped, the whole listing fits a fixed character budget, and when an even split would leave descriptions
// useless (< the minimum) the listing degrades to names-only.
const MAX_LISTING_DESCRIPTION_CHARS = 250;
const LISTING_CHAR_BUDGET = 8_000;
const MIN_LISTING_DESCRIPTION_CHARS = 20;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

// The listing badge for a non-fresh skill — short enough to survive the budget, loud enough to steer selection.
function freshnessBadge(skill: SkillEntry): string {
  switch (skill.freshness?.state) {
    case "superseded_refs":
      return " [stale: refs superseded]";
    case "unverified":
      return " [unverified]";
    default:
      return "";
  }
}

// Render the availability listing within the budget: full → evenly-shrunk descriptions → names-only. A stale/
// unverified skill keeps its badge in every degradation tier — the freshness signal is part of the name.
export function renderSkillListing(skills: SkillEntry[]): string {
  const entries = skills.map((s) => ({
    name: `${s.name}${freshnessBadge(s)}`,
    description: truncate(s.description.replace(/\s+/g, " ").trim(), MAX_LISTING_DESCRIPTION_CHARS),
  }));
  const full = entries.map((e) => `- ${e.name}: ${e.description}`).join("\n");
  if (full.length <= LISTING_CHAR_BUDGET) return full;
  const nameOverhead = entries.reduce((sum, e) => sum + e.name.length + 4, 0) + (entries.length - 1);
  const perDescription = Math.floor((LISTING_CHAR_BUDGET - nameOverhead) / entries.length);
  if (perDescription < MIN_LISTING_DESCRIPTION_CHARS) return entries.map((e) => `- ${e.name}`).join("\n");
  return entries.map((e) => `- ${e.name}: ${truncate(e.description, perDescription)}`).join("\n");
}

// The staleness banner a non-fresh skill's body opens with — the agent follows an old procedure KNOWING it is old,
// and is nudged to propose a revision when procedure and reality have drifted.
function renderFreshnessBanner(skill: SkillEntry): string | undefined {
  const freshness = skill.freshness;
  if (freshness === undefined || freshness.state === "fresh") return undefined;
  if (freshness.state === "superseded_refs") {
    const lines = (freshness.staleRefs ?? []).map(
      (s) =>
        `> - ${s.ref.type} ${s.ref.key}${s.ref.version !== undefined ? `@${s.ref.version}` : ""} → latest ${s.latest}`,
    );
    return [
      "> ⚠ STALE SKILL: it documents entity versions that have been superseded:",
      ...lines,
      "> Verify each step against the newer versions before trusting it; if the procedure has drifted, propose an",
      "> update to this skill after the task.",
    ].join("\n");
  }
  return [
    "> ⚠ UNVERIFIED SKILL: nobody has recently confirmed this procedure still matches reality.",
    "> Double-check critical steps as you follow it; verify or update the skill afterwards.",
  ].join("\n");
}

// The body payload returned by use_skill: the SKILL.md body plus an index of the skill's supporting files (paths +
// sizes only — the contents stay out of context until read_skill_file pulls one).
function renderSkillBody(skill: SkillEntry): string {
  const files = skill.files ?? [];
  const banner = renderFreshnessBanner(skill);
  const head = [`# Skill: ${skill.name}`, ...(banner !== undefined ? ["", banner] : []), "", skill.instructions].join(
    "\n",
  );
  if (files.length === 0) return head;
  const index = files.map((f) => `- ${f.path} (${f.content.length.toLocaleString("en-US")} chars)`).join("\n");
  return [
    head,
    "",
    "## Skill files",
    `Supporting files bundled with this skill. Load one ON DEMAND with ${READ_SKILL_FILE_TOOL_NAME}(skill, path) at the`,
    "step that needs it — do not guess their contents, and do not load files the procedure does not call for:",
    index,
  ].join("\n");
}

function stringField(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

// Build the skill toolset from the workspace's skills: `use_skill` (always) + `read_skill_file` (only when at least
// one skill bundles files — a file-less library pays zero extra tool surface). Both read-only: a skill is guidance,
// not an action (actions come from MCP tools). Returns [] when the workspace has no skills.
export function buildSkillTools(skills: SkillEntry[]): ToolDefinition[] {
  if (skills.length === 0) return [];
  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name);

  const notFound = (name: string | undefined): ToolResult => ({
    content: `No such skill${name !== undefined ? ` "${name}"` : ""}. Available: ${names.join(", ")}.`,
    isError: true,
  });

  const useSkill: ToolDefinition = {
    name: USE_SKILL_TOOL_NAME,
    description: [
      "Load a workspace SKILL — a saved, workspace-authored procedure to follow for a recurring task. Call this with",
      "a skill's name to get its full step-by-step instructions, then follow them. When a skill below matches the",
      "task, load it BEFORE responding about the task; never mention a skill without loading it. If a skill is",
      "already loaded in this conversation, follow it directly instead of loading it again.",
      "",
      "Available skills:",
      renderSkillListing(skills),
    ].join("\n"),
    parametersJsonSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          enum: names,
          description: "The name of the skill to load (one of the available skills).",
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true, // a native tool — always present in tools[], never deferred behind ToolSearch
    call: async (input) => {
      const name = stringField(input, "skill");
      const skill = name !== undefined ? byName.get(name) : undefined;
      if (skill === undefined) return notFound(name);
      return { content: renderSkillBody(skill), isError: false };
    },
  };

  const anyFiles = skills.some((s) => (s.files ?? []).length > 0);
  if (!anyFiles) return [useSkill];

  const readSkillFile: ToolDefinition = {
    name: READ_SKILL_FILE_TOOL_NAME,
    description: [
      "Load ONE supporting file of a workspace skill (use_skill lists each skill's files under '## Skill files').",
      "Call this at the procedure step that needs the file's content — reference material stays out of context",
      "until it is actually read.",
    ].join(" "),
    parametersJsonSchema: {
      type: "object",
      properties: {
        skill: { type: "string", enum: names, description: "The skill the file belongs to." },
        path: { type: "string", description: "The file's path exactly as listed by use_skill." },
      },
      required: ["skill", "path"],
      additionalProperties: false,
    },
    isReadOnly: true,
    alwaysLoad: true,
    call: async (input) => {
      const name = stringField(input, "skill");
      const path = stringField(input, "path");
      const skill = name !== undefined ? byName.get(name) : undefined;
      if (skill === undefined) return notFound(name);
      const files = skill.files ?? [];
      const file = path !== undefined ? files.find((f) => f.path === path) : undefined;
      if (file === undefined) {
        const listing = files.length === 0 ? "none" : files.map((f) => f.path).join(", ");
        return {
          content: `No such file${path !== undefined ? ` "${path}"` : ""} in skill "${skill.name}". Available: ${listing}.`,
          isError: true,
        };
      }
      return { content: `# Skill file: ${skill.name}/${file.path}\n\n${file.content}`, isError: false };
    },
  };

  return [useSkill, readSkillFile];
}
