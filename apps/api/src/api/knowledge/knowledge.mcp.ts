import {
  KNOWLEDGE_ENTRY_MAX_REFS,
  KnowledgeEntryKindSchema,
  KnowledgeEntryStatusSchema,
  KnowledgeEntryVisibilitySchema,
  NodeRefSchema,
} from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Workspace knowledge MCP tools — BFF parity with the /knowledge routes: task-context assembly, the knowledge-entry
// library (reified claims) and thread extraction. Each family registers only when its service is composed.
export function registerKnowledgeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  const knowledge = deps.knowledgeService;
  if (knowledge) {
    server.registerTool(
      "get_task_context",
      {
        annotations: { readOnlyHint: true },
        description:
          "Assemble workspace context for a task: the workspace's knowledge entries (claims/decisions/conventions) and skill candidates ABOUT the anchors ({type, key, version?} — the entities the task concerns), returned as {knowledge, skills}. The anchor's version IS the as-of coordinate: pass an old scorecard's harness@2.1.0 and the knowledge base is projected onto that point (unversioned anchors project onto the present). Each item carries its anchor relation — covers (confirmed at this coordinate) | earlier (about an earlier point; validity here unknown, not wrong) | later (from this coordinate's future, e.g. the eventual fix) | general (timeless family claim) — and a coverage state vs the present (current | behind | unverified). Call this BEFORE working on a harness/dataset/scorecard to inherit what the workspace already knows.",
        inputSchema: {
          refs: z.array(NodeRefSchema).min(1).max(KNOWLEDGE_ENTRY_MAX_REFS),
        },
      },
      ({ refs }) =>
        run(principal, "scorecards:read", async () => ok(await knowledge.assembleContext(ws, principal.subject, refs))),
    );
  }

  // --- knowledge entries: reified claims (multi-anchor, evidenced, revisable) ---

  const entries = deps.knowledgeEntryService;
  if (!entries) return;

  server.registerTool(
    "create_knowledge_entry",
    {
      annotations: { readOnlyHint: false },
      description:
        "Contribute a knowledge entry — a durable claim about the workspace's entities: a finding ('harness X is flaky on k8s login cases'), a decision (+ rationale), a convention, or background context. `refs` = the version-pinned entities it concerns; `evidence` = the scorecards/runs/comments backing it; `supersedes` = the entry it revises. Defaults to a private draft — pass visibility:'workspace' to share.",
      inputSchema: {
        kind: KnowledgeEntryKindSchema,
        title: z.string().min(1).max(300).describe("the one-line claim itself"),
        body: z.string().min(1).describe("markdown — details, caveats, rationale"),
        refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        supersedes: z.string().min(1).optional(),
        visibility: KnowledgeEntryVisibilitySchema.optional(),
      },
    },
    ({ kind, title, body, refs, evidence, supersedes, visibility }) =>
      run(principal, "comments:write", async () =>
        ok(
          await entries.create({
            tenant: ws,
            createdBy: principal.subject,
            kind,
            title,
            body,
            ...(refs !== undefined ? { refs } : {}),
            ...(evidence !== undefined ? { evidence } : {}),
            ...(supersedes !== undefined ? { supersedes } : {}),
            ...(visibility !== undefined ? { visibility } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_knowledge_entries",
    {
      annotations: { readOnlyHint: true },
      description:
        "The workspace's knowledge entries the caller can see (shared + own drafts), each with a coverage state vs the entities' present (current | behind | unverified). `behind` means the claim is as-of an earlier point — still true ABOUT that point; whether it extends to the present is what verify records.",
      inputSchema: {},
    },
    () => run(principal, "scorecards:read", async () => ok(await entries.list(ws, principal.subject))),
  );

  server.registerTool(
    "get_knowledge_entry",
    {
      annotations: { readOnlyHint: true },
      description: "One knowledge entry by id (coverage-decorated).",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok(await entries.get(ws, id, principal.subject))),
  );

  server.registerTool(
    "update_knowledge_entry",
    {
      annotations: { readOnlyHint: false },
      description:
        "Edit a knowledge entry — re-pin refs, revise the body, change status (deprecate / mark superseded) or visibility. Manage = creator-or-admin.",
      inputSchema: {
        id: z.string().min(1),
        kind: KnowledgeEntryKindSchema.optional(),
        title: z.string().min(1).max(300).optional(),
        body: z.string().min(1).optional(),
        refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        status: KnowledgeEntryStatusSchema.optional(),
        visibility: KnowledgeEntryVisibilitySchema.optional(),
      },
    },
    ({ id, kind, title, body, refs, evidence, status, visibility }) =>
      run(principal, "comments:write", async () =>
        ok(
          await entries.update(
            ws,
            id,
            {
              ...(kind !== undefined ? { kind } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(body !== undefined ? { body } : {}),
              ...(refs !== undefined ? { refs } : {}),
              ...(evidence !== undefined ? { evidence } : {}),
              ...(status !== undefined ? { status } : {}),
              ...(visibility !== undefined ? { visibility } : {}),
            },
            { subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_knowledge_entry",
    {
      annotations: { readOnlyHint: false },
      description: "Delete a knowledge entry. Manage = creator-or-admin.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () => {
        await entries.remove(ws, id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: true });
      }),
  );

  server.registerTool(
    "verify_knowledge_entry",
    {
      annotations: { readOnlyHint: false },
      description:
        "Attest a knowledge entry still holds — EXTENDS each versioned pin's known-valid interval to the entity's current latest (verifiedVersion) plus the wall-clock verifiedAt, without counting as an edit. Use when a behind-flagged claim checks out at the present; if the claim no longer holds, create a superseding entry pinned at the version where it changed instead. Manage = creator-or-admin.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () =>
        ok(await entries.verify(ws, id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") })),
      ),
  );

  server.registerTool(
    "approve_knowledge_entry",
    {
      annotations: { readOnlyHint: false },
      description:
        "Approve a PROPOSED knowledge entry (an extraction candidate awaiting review): status proposed → active, and authorship transfers to you — you now assert the claim and own its management (the extraction provenance stays for audit). Only proposed entries can be approved (409 otherwise).",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () =>
        ok(await entries.approve(ws, id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") })),
      ),
  );

  server.registerTool(
    "reject_knowledge_entry",
    {
      annotations: { readOnlyHint: false },
      description:
        "Reject a PROPOSED knowledge entry — deletes the candidate. Only proposed entries can be rejected (an active claim is removed via delete_knowledge_entry, creator-or-admin).",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () => {
        await entries.reject(ws, id);
        return ok({ rejected: true });
      }),
  );

  const extraction = deps.knowledgeExtraction;
  if (!extraction) return;

  server.registerTool(
    "extract_knowledge",
    {
      annotations: { readOnlyHint: false },
      description:
        "Mine a discussion thread for durable, evidence-backed conclusions and store them as PROPOSED knowledge entries awaiting review (the accumulation loop's extraction leg). `source.id` may be any comment in the thread; `model` is a registered workspace model (a real billable call). Returns the created proposals plus dedupe stats — re-running on the same thread skips already-proposed claims. Review with list_knowledge_entries (status 'proposed') → approve_knowledge_entry / reject_knowledge_entry.",
      inputSchema: {
        source: z.object({ kind: z.literal("comment"), id: z.string().min(1) }),
        model: z.string().min(1),
      },
    },
    ({ source, model }) =>
      run(principal, "comments:write", async () =>
        ok(await extraction.extract(ws, principal.subject, { source, model })),
      ),
  );
}
