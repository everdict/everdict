import type { NodeRef, SkillFile } from "@everdict/contracts";
import type { ToolDefinition, ToolResult } from "./definition.js";

// The subject-time coverage the control plane computes for a skill (see docs/architecture/knowledge-graph.md §The
// time axis). Time is a coordinate, not decay: `behind` = the skill's knowledge is AS-OF earlier entity versions —
// still true about those versions; its validity at the present is UNKNOWN (not wrong). `unverified` = nobody
// confirmed the procedure recently on the wall clock. Carried through so the agent follows an as-of procedure
// knowing its coordinates.
export interface SkillCoverage {
  state: "current" | "behind" | "unverified";
  // Each gap names the pin whose known-valid interval [version, verifiedVersion] ends before the entity's present.
  gaps?: { ref: NodeRef & { verifiedVersion?: string }; latest: string }[];
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
  coverage?: SkillCoverage; // control-plane-computed subject-time coverage (absent = no signal, treated as current)
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

// The listing badge for a non-current skill — short enough to survive the budget, precise enough not to lie:
// `behind` is an as-of marker (the skill describes earlier versions), never a "broken" flag.
function coverageBadge(skill: SkillEntry): string {
  switch (skill.coverage?.state) {
    case "behind":
      return " [as-of older versions]";
    case "unverified":
      return " [unverified]";
    default:
      return "";
  }
}

// Render the availability listing within the budget: full → evenly-shrunk descriptions → names-only. A behind/
// unverified skill keeps its badge in every degradation tier — the coverage signal is part of the name.
export function renderSkillListing(skills: SkillEntry[]): string {
  const entries = skills.map((s) => ({
    name: `${s.name}${coverageBadge(s)}`,
    description: truncate(s.description.replace(/\s+/g, " ").trim(), MAX_LISTING_DESCRIPTION_CHARS),
  }));
  const full = entries.map((e) => `- ${e.name}: ${e.description}`).join("\n");
  if (full.length <= LISTING_CHAR_BUDGET) return full;
  const nameOverhead = entries.reduce((sum, e) => sum + e.name.length + 4, 0) + (entries.length - 1);
  const perDescription = Math.floor((LISTING_CHAR_BUDGET - nameOverhead) / entries.length);
  if (perDescription < MIN_LISTING_DESCRIPTION_CHARS) return entries.map((e) => `- ${e.name}`).join("\n");
  return entries.map((e) => `- ${e.name}: ${truncate(e.description, perDescription)}`).join("\n");
}

// The coverage banner a non-current skill's body opens with — as-of coordinates, not a distrust warning: the
// procedure stays true ABOUT the versions it documents; its validity at the present is unknown until confirmed.
// The agent is steered to the three legitimate responses (extend / close / leave as history), never just "refresh".
function renderCoverageBanner(skill: SkillEntry): string | undefined {
  const coverage = skill.coverage;
  if (coverage === undefined || coverage.state === "current") return undefined;
  if (coverage.state === "behind") {
    const lines = (coverage.gaps ?? []).map((g) => {
      const asOf = g.ref.version !== undefined ? `documented @${g.ref.version}` : "documented (unpinned)";
      const through = g.ref.verifiedVersion !== undefined ? `, verified through ${g.ref.verifiedVersion}` : "";
      return `> - ${g.ref.type} ${g.ref.key}: ${asOf}${through} · current ${g.latest}`;
    });
    return [
      "> ◔ AS-OF COVERAGE: this skill's knowledge is pinned to earlier versions of what it documents:",
      ...lines,
      "> It is not wrong — it describes those versions. At the current versions its validity is UNKNOWN: check the",
      "> flagged steps as you go. If they still hold, verify the skill (extends its coverage to the present); if",
      "> behavior changed, propose an update re-pinned at the version where it changed.",
    ].join("\n");
  }
  return [
    "> ◔ UNVERIFIED: nobody has recently confirmed this procedure still matches reality.",
    "> Double-check critical steps as you follow it; verify the skill if it holds, or propose the revision if not.",
  ].join("\n");
}

// The body payload returned by use_skill: the SKILL.md body plus an index of the skill's supporting files (paths +
// sizes only — the contents stay out of context until read_skill_file pulls one).
function renderSkillBody(skill: SkillEntry): string {
  const files = skill.files ?? [];
  const banner = renderCoverageBanner(skill);
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
