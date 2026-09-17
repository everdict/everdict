import type { DelegationBrief } from "@everdict/contracts";

// The delegation brief, rendered as the markdown the delegate actually reads. ONE renderer, because the brief
// reaches its reader through three doors — the file seeded into the sandbox, the marker sealed on the session's
// trajectory, and (later) whatever surface shows a delegation — and a handoff that reads differently depending
// on where you look at it is not a handoff anyone can audit.
//
// Sections are omitted when empty (the same hide-empty discipline the detail views use): a brief with no
// constraints must not tell the delegate there is a constraints section it should be looking for.
export function renderDelegationBrief(brief: DelegationBrief): string {
  const lines: string[] = ["# Delegation brief", "", "## Goal", brief.goal.trim()];
  if (brief.context !== undefined && brief.context.trim() !== "") {
    lines.push("", "## Context", brief.context.trim());
  }
  if (brief.references.length > 0) {
    lines.push("", "## References");
    for (const ref of brief.references) {
      const version = ref.version !== undefined ? `@${ref.version}` : "";
      const note = ref.note !== undefined && ref.note.trim() !== "" ? ` — ${ref.note.trim()}` : "";
      lines.push(`- ${ref.type} \`${ref.id}${version}\`${note}`);
    }
  }
  if (brief.constraints.length > 0) {
    lines.push("", "## Constraints");
    for (const c of brief.constraints) lines.push(`- ${c}`);
  }
  if (brief.doneWhen.length > 0) {
    // ⚠️ THE ID IS RENDERED, and it is not decoration. This is the only place the delegate learns what to call
    // each check, and its report answers them BY ID — a finish line the delegate can read but not name is one
    // it can only answer in prose, which is the state this whole handoff exists to leave behind.
    lines.push("", "## Done when");
    lines.push("", "Answer each of these by its id when you report back.", "");
    for (const d of brief.doneWhen) lines.push(`- \`${d.id}\` — ${d.statement}`);
  }
  return `${lines.join("\n")}\n`;
}
