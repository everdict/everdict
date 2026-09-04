import { COMMENT_AGENT_AUTHOR, CommentService, type DiscussionTurnRunner } from "@everdict/application-control";
import { InMemoryCommentStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

function svc() {
  const store = new InMemoryCommentStore();
  let n = 0;
  const service = new CommentService({ store, newId: () => `c${++n}`, now: () => `2026-07-04T00:00:0${n}.000Z` });
  return { service, store };
}

describe("CommentService", () => {
  it("after posting, comments are read per resource oldest→newest (workspace-scoped)", async () => {
    const { service } = svc();
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "officeqa",
      author: "u-a",
      body: "first comment",
    });
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "officeqa",
      author: "u-b",
      body: "second",
    });
    // other resources/tenants are not mixed in.
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "other",
      author: "u-a",
      body: "unrelated",
    });
    await service.create({
      tenant: "beta",
      resourceType: "dataset",
      resourceId: "officeqa",
      author: "u-c",
      body: "other-tenant",
    });

    const list = await service.list("acme", "dataset", "officeqa");
    expect(list.map((c) => c.body)).toEqual(["first comment", "second"]);
    expect(list.map((c) => c.author)).toEqual(["u-a", "u-b"]);
  });

  it("empty body → 400, whitespace-only → 400", async () => {
    const { service } = svc();
    await expect(
      service.create({ tenant: "acme", resourceType: "dataset", resourceId: "d", author: "u", body: "   " }),
    ).rejects.toThrow(/content is required/);
  });

  it("an unsupported resourceType → 400", async () => {
    const { service } = svc();
    await expect(
      service.create({ tenant: "acme", resourceType: "workflow", resourceId: "p", author: "u", body: "x" }),
    ).rejects.toThrow(/Unsupported/);
  });

  it("the eval tracker's three kinds are commentable — an issue is where a team argues about the evaluation", async () => {
    const { service } = svc();
    for (const resourceType of ["issue", "project", "initiative"]) {
      const comment = await service.create({ tenant: "acme", resourceType, resourceId: "x", author: "u", body: "b" });
      expect(comment.resourceType).toBe(resourceType);
    }
  });

  it("only the author can delete — others 403, admin allowed, missing 404", async () => {
    const { service } = svc();
    const c = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u-owner",
      body: "to delete",
    });
    // another user (non-admin) → 403
    await expect(service.delete({ tenant: "acme", id: c.id, subject: "u-other", isAdmin: false })).rejects.toThrow(
      /author or an admin/,
    );
    // admin → success
    await service.delete({ tenant: "acme", id: c.id, subject: "u-other", isAdmin: true });
    expect(await service.list("acme", "dataset", "d")).toHaveLength(0);
    // missing id → 404
    await expect(service.delete({ tenant: "acme", id: "nope", subject: "u-owner", isAdmin: true })).rejects.toThrow(
      /not found/,
    );
  });

  it("with mentions, calls notifyMention for recipients excluding the author (deduped)", async () => {
    const store = new InMemoryCommentStore();
    const calls: Array<{ recipients: string[] }> = [];
    const service = new CommentService({
      store,
      newId: () => "cm",
      now: () => "2026-07-04T00:00:00.000Z",
      notifyMention: async ({ recipients }) => {
        calls.push({ recipients });
      },
    });
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u-me",
      body: "@bob @carol please review",
      mentions: ["u-bob", "u-carol", "u-bob", "u-me"], // duplicate + the author themselves
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipients.sort()).toEqual(["u-bob", "u-carol"]); // excludes self · duplicates
  });

  it("with no mentions, does not call notifyMention", async () => {
    const store = new InMemoryCommentStore();
    let called = 0;
    const service = new CommentService({
      store,
      newId: () => "cm",
      now: () => "2026-07-04T00:00:00.000Z",
      notifyMention: async () => {
        called++;
      },
    });
    await service.create({ tenant: "acme", resourceType: "dataset", resourceId: "d", author: "u", body: "no mention" });
    expect(called).toBe(0);
  });

  it("reply: only allowed on a top-level comment; replying to a reply is 400", async () => {
    const { service } = svc();
    const top = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u1",
      body: "top-level",
    });
    const reply = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u2",
      body: "reply",
      parentId: top.id,
    });
    expect(reply.parentId).toBe(top.id);
    // reply to a reply → 400 (single level enforced)
    await expect(
      service.create({
        tenant: "acme",
        resourceType: "dataset",
        resourceId: "d",
        author: "u3",
        body: "re-reply",
        parentId: reply.id,
      }),
    ).rejects.toThrow(/reply to a reply/);
    // different resource / missing parent → 400
    await expect(
      service.create({
        tenant: "acme",
        resourceType: "dataset",
        resourceId: "other",
        author: "u3",
        body: "x",
        parentId: top.id,
      }),
    ).rejects.toThrow(/Parent comment/);
  });

  it("deleting a parent also deletes its replies (cascade)", async () => {
    const { service } = svc();
    const top = await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u1",
      body: "parent",
    });
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u2",
      body: "reply 1",
      parentId: top.id,
    });
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u3",
      body: "reply 2",
      parentId: top.id,
    });
    expect(await service.list("acme", "harness", "h")).toHaveLength(3);
    await service.delete({ tenant: "acme", id: top.id, subject: "u1", isAdmin: false });
    expect(await service.list("acme", "harness", "h")).toHaveLength(0); // both parent and replies deleted
  });

  it("extended resourceTypes (harness/scorecard/runtime, etc.) are allowed too", async () => {
    const { service } = svc();
    for (const rt of ["harness", "scorecard", "view", "schedule", "run", "runtime"]) {
      const c = await service.create({
        tenant: "acme",
        resourceType: rt,
        resourceId: "x",
        author: "u",
        body: `${rt} comment`,
      });
      expect(c.resourceType).toBe(rt);
    }
  });

  it("the author can delete (even if not admin)", async () => {
    const { service } = svc();
    const c = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u-me",
      body: "my comment",
    });
    await service.delete({ tenant: "acme", id: c.id, subject: "u-me", isAdmin: false });
    expect(await service.list("acme", "dataset", "d")).toHaveLength(0);
  });
});

// An agent reaches the control plane with the MEMBER'S credential, so without the declaration its comments were
// signed by whoever happened to be running it.
describe("CommentService agent authorship", () => {
  it("a comment posted by a declared agent is Everdict's, not the member's whose credential carried it", async () => {
    // Given a member's credential (the agent is a token courier)
    const { service } = svc();
    // When an agent posts through it, declaring the conversation it came out of
    const comment = await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-operator",
      body: "The regression traces to judge-v3.",
      agent: { conversationId: "conv-9" },
    });
    // Then the thread credits Everdict, and links back to the conversation that produced the answer
    expect(comment.author).toBe(COMMENT_AGENT_AUTHOR);
    expect(comment.authorKind).toBe("agent");
    expect(comment.agentSessionId).toBe("conv-9");
    // and it renders its body immediately — there is no turn to wait for
    expect(comment.agentStatus).toBe("complete");
    expect(comment.body).toBe("The regression traces to judge-v3.");
  });

  it("without a declared agent the member is still the author (the ordinary path is untouched)", async () => {
    const { service } = svc();
    const comment = await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-operator",
      body: "my own note",
    });
    expect(comment.author).toBe("u-operator");
    expect(comment.authorKind).toBeUndefined();
    expect(comment.agentStatus).toBeUndefined();
  });

  it("an agent's comment emits no comment.created fact — a watching agent must never wake on its own answer", async () => {
    const store = new InMemoryCommentStore();
    const kinds: string[] = [];
    const service = new CommentService({
      store,
      events: { emit: async ({ kind }) => kinds.push(kind) },
      newId: () => "c1",
      now: () => "2026-07-04T00:00:00.000Z",
    });
    await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-operator",
      body: "agent answer",
      agent: { conversationId: "conv-9" },
    });
    expect(kinds).toEqual([]);
    // the same member's OWN comment still records the fact
    await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-operator",
      body: "my own note",
    });
    expect(kinds).toEqual(["comment.created"]);
  });

  it("an agent may @-mention the member it acted for — they did not write the comment, so they get the ping", async () => {
    const store = new InMemoryCommentStore();
    const calls: string[][] = [];
    const service = new CommentService({
      store,
      notifyMention: async ({ recipients }) => {
        calls.push(recipients);
      },
      newId: () => "c1",
      now: () => "2026-07-04T00:00:00.000Z",
    });
    await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-operator",
      body: "@operator this one is yours",
      mentions: ["u-operator"],
      agent: { conversationId: "conv-9" },
    });
    expect(calls).toEqual([["u-operator"]]);
  });

  it("an agent cannot hand a thread to the discussion agent → 400 (it would answer its own comment)", async () => {
    const store = new InMemoryCommentStore();
    let fired = 0;
    const service = new CommentService({
      store,
      discussionRunner: {
        run: async () => {
          fired++;
        },
      },
      newId: () => "c1",
      now: () => "2026-07-04T00:00:00.000Z",
    });
    await expect(
      service.create({
        tenant: "acme",
        resourceType: "issue",
        resourceId: "ENG-12",
        author: "u-operator",
        body: "@everdict take a look",
        askAgent: true,
        agent: { conversationId: "conv-9" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fired).toBe(0);
    expect(await service.list("acme", "issue", "ENG-12")).toHaveLength(0); // nothing persisted
  });
});

// @everdict in the thread — the discussion-agent bridge (placeholder comment + detached turn trigger).
describe("CommentService discussion agent (askAgent)", () => {
  type RunnerInput = Parameters<DiscussionTurnRunner["run"]>[0];
  type AnswerPing = { recipient: string; commentId: string; preview: string; ok: boolean };
  function agentSvc(opts: { failRunner?: boolean } = {}) {
    const store = new InMemoryCommentStore();
    const calls: RunnerInput[] = [];
    const pings: AnswerPing[] = [];
    const parkPings: { recipient: string; commentId: string; tool?: string }[] = [];
    const parkClears: string[] = [];
    const runner: DiscussionTurnRunner = {
      run: async (input) => {
        calls.push(input);
        if (opts.failRunner) throw new Error("agent unreachable");
      },
    };
    let n = 0;
    let clock = 0; // now() is advanced explicitly to verify the sweep's staleness judgement
    const service = new CommentService({
      store,
      discussionRunner: runner,
      memberNames: async () => ({ "u-a": "Alice", "u-b": "Bob" }),
      notifyAgentAnswer: async ({ recipient, commentId, preview, ok }) => {
        pings.push({ recipient, commentId, preview, ok });
      },
      notifyApprovalRequested: async ({ recipient, commentId, tool }) => {
        parkPings.push({ recipient, commentId, ...(tool !== undefined ? { tool } : {}) });
      },
      clearApprovalRequest: async ({ commentId }) => {
        parkClears.push(commentId);
      },
      newId: () => `c${++n}`,
      now: () => new Date(Date.parse("2026-07-04T00:00:00.000Z") + clock).toISOString(),
    });
    return {
      service,
      store,
      calls,
      pings,
      parkPings,
      parkClears,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("askAgent posts the member comment, creates a running agent placeholder in the same thread, and fires the runner with the thread snapshot", async () => {
    const { service, calls } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "context note",
    });
    const trigger = await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-b",
      body: "@everdict summarize this harness",
      askAgent: true,
    });

    const list = await service.list("acme", "harness", "h");
    const placeholder = list.find((c) => c.authorKind === "agent");
    expect(placeholder).toBeDefined();
    expect(placeholder?.author).toBe(COMMENT_AGENT_AUTHOR);
    expect(placeholder?.agentStatus).toBe("running");
    expect(placeholder?.parentId).toBe(trigger.id); // nested under the asking comment
    expect(placeholder?.agentSessionId).toBeTruthy();

    expect(calls).toHaveLength(1);
    const input = calls[0];
    expect(input?.askedBy).toBe("u-b");
    expect(input?.commentId).toBe(placeholder?.id);
    expect(input?.anchorId).toBe(trigger.id); // the thread to answer IN — the agent's only comment id
    expect(input?.sessionId).toBe(placeholder?.agentSessionId);
    // snapshot: both member comments, display names resolved, oldest→newest
    expect(input?.thread.map((t) => [t.authorName, t.body])).toEqual([
      ["Alice", "context note"],
      ["Bob", "@everdict summarize this harness"],
    ]);
  });

  it("asking from INSIDE a thread anchors both the placeholder and the turn on that thread's top-level comment", async () => {
    // Given a top-level comment…
    const { service, calls } = agentSvc();
    const top = await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-a",
      body: "the judge looks flaky",
    });
    // …When the ask is a REPLY to it (a reply can never be a parent — single-level threads)…
    const reply = await service.create({
      tenant: "acme",
      resourceType: "issue",
      resourceId: "ENG-12",
      author: "u-b",
      body: "@everdict is it the judge or the harness?",
      parentId: top.id,
      askAgent: true,
    });
    // …Then the answer hangs under the SAME anchor as the ask, and the turn is told that anchor.
    const placeholder = (await service.list("acme", "issue", "ENG-12")).find((c) => c.authorKind === "agent");
    expect(placeholder?.parentId).toBe(top.id);
    expect(reply.parentId).toBe(top.id);
    expect(calls[0]?.anchorId).toBe(top.id);
  });

  it("a later ask in the same thread REUSES the previous agent session id", async () => {
    const { service, store, calls } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "@everdict q1",
      askAgent: true,
    });
    const first = calls[0];
    // finish the first answer so the busy-guard clears; the completed answer joins the next snapshot
    const firstPlaceholder = (await service.list("acme", "harness", "h")).find((c) => c.authorKind === "agent");
    if (!firstPlaceholder) throw new Error("placeholder missing");
    await service.applyProgress("acme", firstPlaceholder.id, { status: "complete", body: "answer one" });
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-b",
      body: "@everdict q2",
      askAgent: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sessionId).toBe(first?.sessionId);
    expect(calls[1]?.thread.some((t) => t.authorName === "Everdict" && t.body === "answer one")).toBe(true);
    void store;
  });

  it("askAgent while a previous ask is still running → 409, nothing persisted", async () => {
    const { service } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "@everdict q1",
      askAgent: true,
    });
    await expect(
      service.create({
        tenant: "acme",
        resourceType: "harness",
        resourceId: "h",
        author: "u-b",
        body: "@everdict q2",
        askAgent: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // the rejected member comment was NOT persisted
    const list = await service.list("acme", "harness", "h");
    expect(list.filter((c) => c.authorKind !== "agent")).toHaveLength(1);
  });

  it("a runner failure marks the placeholder failed (the member comment survives)", async () => {
    const { service } = agentSvc({ failRunner: true });
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "@everdict q",
      askAgent: true,
    });
    const list = await service.list("acme", "harness", "h");
    expect(list.find((c) => c.authorKind === "agent")?.agentStatus).toBe("failed");
    expect(list.find((c) => c.authorKind !== "agent")?.body).toBe("@everdict q");
  });

  it("applyProgress patches activity, then the terminal patch sets the final body and clears the activity line", async () => {
    const { service } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "@everdict q",
      askAgent: true,
    });
    const placeholder = (await service.list("acme", "harness", "h")).find((c) => c.authorKind === "agent");
    if (!placeholder) throw new Error("placeholder missing");
    await service.applyProgress("acme", placeholder.id, { activity: "tool:get_harness_instance" });
    let c = (await service.list("acme", "harness", "h")).find((x) => x.id === placeholder.id);
    expect(c?.agentActivity).toBe("tool:get_harness_instance");
    await service.applyProgress("acme", placeholder.id, { status: "complete", body: "**done**" });
    c = (await service.list("acme", "harness", "h")).find((x) => x.id === placeholder.id);
    expect(c?.agentStatus).toBe("complete");
    expect(c?.body).toBe("**done**");
    expect(c?.agentActivity).toBeUndefined();
  });

  it("applyProgress on a member comment or unknown id → 404", async () => {
    const { service } = agentSvc();
    const member = await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "note",
    });
    await expect(service.applyProgress("acme", member.id, { status: "complete" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.applyProgress("acme", "nope", { status: "complete" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("the placeholder remembers the asker and reaching complete pings exactly them (once — a re-report does not re-ping)", async () => {
    const { service, pings } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-b",
      body: "@everdict q",
      askAgent: true,
    });
    const placeholder = (await service.list("acme", "harness", "h")).find((c) => c.authorKind === "agent");
    if (!placeholder) throw new Error("placeholder missing");
    expect(placeholder.agentAskedBy).toBe("u-b");
    await service.applyProgress("acme", placeholder.id, { status: "complete", body: "**answer**" });
    expect(pings).toEqual([{ recipient: "u-b", commentId: placeholder.id, preview: "**answer**", ok: true }]);
    // the agent re-reports the same terminal state (retry) — no duplicate ping
    await service.applyProgress("acme", placeholder.id, { status: "complete", body: "**answer**" });
    expect(pings).toHaveLength(1);
  });

  it("entering the approval park pings the asker once — parked ticks don't re-ping, a second park does (N8)", async () => {
    const { service, store, parkPings, parkClears } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-b",
      body: "@everdict tag it",
      askAgent: true,
    });
    const placeholder = (await store.list("acme", "harness", "h")).find((c) => c.authorKind === "agent");
    if (!placeholder) throw new Error("no agent placeholder");

    // The turn parks on a write tool — exactly one ping, naming the parked tool.
    await service.applyProgress("acme", placeholder.id, { status: "awaiting_approval", activity: "tool:add_tag" });
    expect(parkPings).toEqual([{ recipient: "u-b", commentId: placeholder.id, tool: "add_tag" }]);

    // Re-reports while STILL parked never re-ping (the decision hasn't been made, not a new ask).
    await service.applyProgress("acme", placeholder.id, { status: "awaiting_approval", activity: "tool:add_tag" });
    expect(parkPings).toHaveLength(1);

    // Approved → running: leaving the park DELETES the ask's bell row (a decided ask must not linger)…
    await service.applyProgress("acme", placeholder.id, { status: "running", activity: "writing" });
    expect(parkClears).toEqual([placeholder.id]);
    // …and a SECOND park is a new decision: it pings again.
    await service.applyProgress("acme", placeholder.id, { status: "awaiting_approval", activity: "tool:retry_run" });
    expect(parkPings).toHaveLength(2);
    expect(parkPings[1]).toEqual({ recipient: "u-b", commentId: placeholder.id, tool: "retry_run" });
    // A terminal settle out of the park clears too (the sweep path).
    await service.applyProgress("acme", placeholder.id, { status: "failed" });
    expect(parkClears).toEqual([placeholder.id, placeholder.id]);
  });

  it("a failed answer pings the asker with ok:false and no preview", async () => {
    const { service, pings } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "@everdict q",
      askAgent: true,
    });
    const placeholder = (await service.list("acme", "harness", "h")).find((c) => c.authorKind === "agent");
    if (!placeholder) throw new Error("placeholder missing");
    await service.applyProgress("acme", placeholder.id, { status: "failed" });
    expect(pings).toEqual([{ recipient: "u-a", commentId: placeholder.id, preview: "", ok: false }]);
  });

  it("sweepStuckAgentAnswers fails only answers stale beyond the window, pinging their askers", async () => {
    const { service, pings, advance } = agentSvc();
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u-a",
      body: "@everdict q1",
      askAgent: true,
    });
    // 20 min pass — the first turn's callbacks are dead. A fresh ask on another resource starts now.
    advance(20 * 60_000);
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u-b",
      body: "@everdict q2",
      askAgent: true,
    });
    const swept = await service.sweepStuckAgentAnswers(15 * 60_000);
    expect(swept).toBe(1);
    const stale = (await service.list("acme", "harness", "h")).find((c) => c.authorKind === "agent");
    const fresh = (await service.list("acme", "dataset", "d")).find((c) => c.authorKind === "agent");
    expect(stale?.agentStatus).toBe("failed");
    expect(fresh?.agentStatus).toBe("running"); // untouched — still within the window
    expect(pings).toEqual([{ recipient: "u-a", commentId: stale?.id, preview: "", ok: false }]);
  });
});
