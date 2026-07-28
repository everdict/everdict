import type { PermissionHook } from "@everdict/agent-runtime";
import { AGENT_REFERENCE_TYPES, type AgentReference, type AgentReferenceType } from "@everdict/contracts";
import { issueAgentToken } from "@everdict/db";
import { runChat } from "./chat.js";
import type { PermissionRegistry } from "./permission-registry.js";
import type { AgentServerDeps } from "./server.js";

// Headless discussion turn (@everdict in a resource's comment thread). The control plane's comment slice fires the
// internal trigger; the route acks 202 and runs THIS detached: one agent turn over the thread snapshot inside the
// thread's shared, workspace-visible session, acting AS the asker (minted agt_ token, revoked after). Progress —
// activity token / HITL park / final markdown answer — is reported back onto the placeholder comment via the
// control plane's /internal/comment-activity bridge (apps/api stays the only comment mutator). Modeled on
// report-turn.ts; deviates in being detached (a HITL approval can park the turn for minutes).

export interface DiscussionTurnInput {
  workspace: string;
  askedBy: string; // the asking member — the turn acts as this subject
  resourceType: string;
  resourceId: string;
  commentId: string; // the placeholder agent comment to drive
  sessionId: string; // the thread's shared session (created on first ask, reused after)
  thread: { author: string; authorName: string; body: string; at: string }[];
}

// Discussion turns are semi-attended — cap them under an interactive chat so a wandering model can't burn the
// tenant's budget on one thread question.
const DISCUSSION_MAX_TURNS = 32;
// A parked write-tool approval waits longer than an interactive chat's (nobody may be watching yet — the thread
// shows 승인 대기 and a member opens the panel to answer). Deny on expiry (the registry's safe default).
const DISCUSSION_APPROVAL_TIMEOUT_MS = 600_000;

export function buildDiscussionPrompt(input: DiscussionTurnInput): string {
  const lines = [
    `You are answering inside a shared discussion thread on the ${input.resourceType} "${input.resourceId}".`,
    "Multiple workspace members are discussing; the newest comment mentions you (@everdict).",
    "",
    "Discussion so far (oldest first — this snapshot supersedes any earlier one in this conversation):",
    ...input.thread.map((c) => `[${c.at}] ${c.authorName}: ${c.body}`),
    "",
    "Respond to the newest @everdict request, using the discussion and the referenced entity as context.",
    "Your reply is posted into the thread as a comment: write a self-contained markdown answer and keep it",
    "concise — this is a discussion, not a report. Prefer reasonable assumptions over asking questions back.",
  ];
  return lines.join("\n");
}

export async function runDiscussionTurn(
  deps: AgentServerDeps,
  permissions: PermissionRegistry,
  input: DiscussionTurnInput,
): Promise<void> {
  if (!deps.keyStore) throw new Error("Discussion turns need a key store (agt_ execution tokens) — set DATABASE_URL.");
  const reportActivity = deps.commentActivity;
  if (!reportActivity)
    throw new Error("Discussion turns need the comment-activity bridge (control-plane URL + token).");
  // Progress ticks are best-effort (a lost activity line never breaks the turn); the terminal patch is not.
  const tick = (patch: { status?: "running" | "awaiting_approval"; activity?: string }): void => {
    void reportActivity({ workspace: input.workspace, commentId: input.commentId, ...patch }).catch(() => undefined);
  };

  // The thread's shared session — workspace-visible so ANY member can open the transcript and continue chatting.
  const now = deps.now();
  const existing = await deps.sessions.getVisibleSession(input.workspace, input.askedBy, input.sessionId);
  if (!existing) {
    await deps.sessions.createSession({
      id: input.sessionId,
      tenant: input.workspace,
      owner: input.askedBy, // the first asker owns it (rename/delete); visibility opens read/continue to the workspace
      title: `Discussion: ${input.resourceType} ${input.resourceId}`.slice(0, 60),
      visibility: "workspace",
      createdAt: now,
      updatedAt: now,
    });
  }

  // Action-capable turn (HITL-gated writes) — "read" + the default "write" scope; governance/credential actions
  // stay outside the write scope, and every call is still RBAC-bounded as the asker.
  const { token, id: keyId } = await issueAgentToken(
    deps.keyStore,
    input.workspace,
    input.askedBy,
    ["read", "write"],
    `discussion:${input.commentId}`,
  );
  try {
    const principal = await deps.authenticate({ authorization: `Bearer ${token}` });
    // The resource itself rides the existing @-reference channel (resolved via its get_* read tool). "schedule"
    // is not a reference type — those threads run on thread context alone.
    const refType = (AGENT_REFERENCE_TYPES as readonly string[]).includes(input.resourceType)
      ? (input.resourceType as AgentReferenceType)
      : undefined;
    const references: AgentReference[] | undefined = refType
      ? [{ type: refType, id: input.resourceId, label: input.resourceId }]
      : undefined;
    // A write-tool ask parks in the shared registry: the comment flips to 승인 대기 and a panel opened on the
    // session discovers the ask via GET /pending, answering through the normal POST /permission route.
    let lastActivity = "thinking";
    const permit: PermissionHook = async (request) => {
      tick({ status: "awaiting_approval", activity: `tool:${request.name}` });
      const decision = await permissions.wait(
        deps.newId(),
        input.sessionId,
        undefined,
        request,
        DISCUSSION_APPROVAL_TIMEOUT_MS,
      );
      tick({ status: "running", activity: lastActivity });
      return decision;
    };
    const result = await runChat(
      { ...deps, maxTurns: DISCUSSION_MAX_TURNS },
      principal,
      { authorization: `Bearer ${token}` },
      input.sessionId,
      buildDiscussionPrompt(input),
      references,
      undefined,
      undefined,
      {
        permit,
        // Milestones → the comment's live "doing now" token (throttled to changes; the web localizes it).
        onEvent: (e) => {
          const activity =
            e.type === "reasoning_delta"
              ? "thinking"
              : e.type === "text_delta"
                ? "writing"
                : e.type === "tool_call"
                  ? `tool:${e.name}`
                  : undefined;
          if (activity === undefined || activity === lastActivity) return;
          lastActivity = activity;
          tick({ status: "running", activity });
        },
      },
    );
    const final = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content.trim().length > 0);
    if (!final) throw new Error("The discussion turn produced no answer.");
    // Terminal patch — NOT best-effort: an answer that can't land on the comment is a failed turn.
    await reportActivity({
      workspace: input.workspace,
      commentId: input.commentId,
      status: "complete",
      body: final.content,
    });
  } catch (err) {
    await reportActivity({ workspace: input.workspace, commentId: input.commentId, status: "failed" }).catch(
      () => undefined,
    );
    throw err; // the detached caller logs it
  } finally {
    await deps.keyStore.revoke(input.workspace, keyId, input.askedBy).catch(() => {}); // one-shot credential
  }
}
