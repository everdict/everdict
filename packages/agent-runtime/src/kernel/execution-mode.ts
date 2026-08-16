// SHADOW IS A PROPERTY OF THE EXECUTION, NOT OF THE PERMISSION HOOK.
//
// A shadow try (agent-automation B3: fire an event at an agent BEFORE enabling it and watch what it would do)
// promises that the run has NO side effects. That promise used to be implemented one layer too high — a host
// hook that answers "deny" to every call the kernel bothers to ask about. The kernel asks only when the tool is
// not read-only or its declared effects require consent, because plain reads are the agent's senses and stay
// ungated on purpose; so the promise held exactly as far as the read-only FLAG was a fact. For an external MCP
// server it is a guess (`apps/agent/src/mcp-tools.ts` keeps a non-write server's `get_`/`list_`/… names and
// bridges every survivor `isReadOnly: true`), and a server exposing `get_or_create_ticket` handed the kernel a
// tool that is declared read-only, is asked nothing, and creates a ticket during a run whose whole point is that
// nothing happens.
//
// So the MODE of the run reaches the call site. "This execution performs no effects" is then enforced where
// effects are performed, rather than inferred from a property the effect's own author supplied.
//
// `executableReads` is an ATTESTATION, not a classification: the host lists the tools it can itself vouch for as
// pure reads of its own first-party surface. A third party's catalog is never in it, however that catalog spells
// its tool names.
export type ExecutionMode = { kind: "live" } | { kind: "shadow"; executableReads: ReadonlySet<string> };

// The stable marker a captured call carries — on the runtime event (`tool_result.outcome`) and, for readers that
// only ever see the transcript, at the head of the result text.
export const SHADOW_DENIED = "shadow_denied";

export const SHADOW_CAPTURE_PREFIX = "Shadow run — this call was captured, not executed.";

export function shadowCaptureMessage(name: string): string {
  return `${SHADOW_CAPTURE_PREFIX} "${name}" did NOT run and nothing changed. Your intent (the tool and its arguments) has been recorded as what you WOULD have done. State the action you intended and continue as if it had conceptually succeeded — do not retry it and do not look for another route to the same effect.`;
}

// The kernel's own refusal texts. They are OURS — one owner, one spelling — so a reader downstream can recognize a
// withheld call without re-inferring it from a sentence the kernel is free to reword. (The projectors in apps/agent
// build an evaluation trace from these; a refusal scored as a successful tool call is the one number the evaluation
// exists to produce.)
export const PERMISSION_DENIED_PREFIX = "Permission denied:";
export const ENVELOPE_REFUSAL_PREFIX = "Envelope refusal (";

export function isKernelRefusal(content: string): boolean {
  return (
    content.startsWith(SHADOW_CAPTURE_PREFIX) ||
    content.startsWith(PERMISSION_DENIED_PREFIX) ||
    content.startsWith(ENVELOPE_REFUSAL_PREFIX)
  );
}

// Whether this mode INVOKES the named tool at all. Live runs invoke everything the gates above let through.
// A shadow run invokes only the host-attested pure reads and the kernel's own cognition tools (todo/plan/result
// paging/wait — they move no state outside the loop); everything else is captured instead: external MCP tools
// however they are classified, code/stdio tools, and every mutation.
export function modeInvokes(
  mode: ExecutionMode,
  tool: { name: string; isReadOnly?: boolean; intrinsic?: boolean },
): boolean {
  if (mode.kind === "live") return true;
  if (tool.intrinsic === true) return true;
  return tool.isReadOnly === true && mode.executableReads.has(tool.name);
}
