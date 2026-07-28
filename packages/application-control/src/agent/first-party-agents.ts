import { type AgentSpec, AgentSpecSchema } from "@everdict/contracts";
import { SHARED_TENANT } from "@everdict/domain";
import type { AgentRegistry } from "../ports/agent-registry.js";

// First-party agent TEMPLATES (docs/architecture/agent-automation.md B4) — the two flagship automation agents,
// seeded into the _shared tenant so every workspace's agent list surfaces them. Deliberately disabled and
// creator-less: a _shared entry can never activate (activation acts AS a creator); a workspace ADOPTS one by
// saving a copy under its own tenant (PUT /agents/:id), which stamps a creator and makes `enabled` meaningful.
export const FIRST_PARTY_AGENT_TEMPLATES: AgentSpec[] = [
  AgentSpecSchema.parse({
    id: "scorecard-sentinel",
    version: "1.0.0",
    description:
      "Watches every scorecard batch from submission through completion and reacts to trouble along the way.",
    task: [
      "You are the workspace's scorecard sentinel. React to the platform event that woke you:",
      "- scorecard.submitted: read the batch (get_scorecard) and verify the lane is healthy (get_queue; the",
      "  chosen runtime via list_runtimes/inspect_runtime). If dispatch looks stuck or the queue is backed up,",
      "  say so in a comment on the scorecard.",
      "- scorecard.case.completed with a FAIL verdict: drill into that case (get_scorecard_analysis, the case's",
      "  run logs) and note the likely cause — infra (OOM/timeout/dispatch) vs the harness's own behavior.",
      "- scorecard.completed / scorecard.failed: post ONE concise summary comment on the scorecard",
      '  (create_comment, resourceType "scorecard"): pass rate, notable failures with your one-line causes,',
      "  and any infra anomalies you saw. If the batch failed for a clearly TRANSIENT infra reason, retry it",
      "  once (retry_scorecard) and say you did — never retry the same batch twice.",
      "Be brief and factual; read before you conclude.",
    ].join("\n"),
    triggers: [
      {
        kinds: ["scorecard.submitted", "scorecard.case.completed", "scorecard.completed", "scorecard.failed"],
        filters: [],
      },
    ],
    permissionMode: "auto",
    enabled: false,
    tags: ["first-party", "template"],
  }),
  AgentSpecSchema.parse({
    id: "failure-fix-pr",
    version: "1.0.0",
    description:
      "When a batch finishes with failing cases, root-causes them with full harness + dataset context and contributes a fix PR.",
    task: [
      "You are the failure-fix agent. A scorecard finished with failing cases (passRate < 1). Do a real root",
      "cause, then contribute:",
      "1. Context: get_scorecard_analysis for the batch; for each failed case read its trace/logs, the dataset",
      "   case definition (get_dataset) and the harness spec (get_harness_instance).",
      "2. Root-cause each failure: harness bug vs dataset/case problem vs judge misconfiguration vs infra.",
      "3. If a CODE fix in the linked repository is warranted, prepare the minimal change and open a pull",
      "   request (open_github_pr) — the PR body carries your per-case analysis and how the fix addresses it.",
      "4. Comment on the scorecard (create_comment) with the root cause summary and the PR link — or, when no",
      "   code fix is possible, with the analysis and what you recommend instead.",
      "Never touch cases that passed; keep changes minimal and reviewable.",
    ].join("\n"),
    triggers: [{ kinds: ["scorecard.completed"], filters: [{ field: "passRate", op: "lt", value: 1 }] }],
    permissionMode: "default",
    enabled: false,
    tags: ["first-party", "template"],
  }),
];

// Idempotent boot seed: register each template version into _shared unless it is already there. Failures are
// surfaced to the caller (boot logs) but must not block the control plane from starting.
export async function seedFirstPartyAgents(registry: AgentRegistry): Promise<void> {
  for (const template of FIRST_PARTY_AGENT_TEMPLATES) {
    try {
      if (await registry.has(SHARED_TENANT, template.id, template.version)) continue;
      await registry.register(SHARED_TENANT, template);
    } catch (err) {
      console.error(
        `▶ first-party agent seed failed for ${template.id}@${template.version}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
