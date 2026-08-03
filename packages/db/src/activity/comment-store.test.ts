import type { CommentRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCommentStore } from "./comment-store.js";

const rec = (id: string, over: Partial<CommentRecord> = {}): CommentRecord => ({
  id,
  tenant: "acme",
  resourceType: "harness",
  resourceId: "h-1",
  author: "alice",
  body: "hello",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("InMemoryCommentStore", () => {
  it("update patches an agent comment's lifecycle fields and bumps updatedAt", async () => {
    const store = new InMemoryCommentStore();
    await store.add(
      rec("c1", {
        authorKind: "agent",
        agentStatus: "running",
        agentActivity: "thinking",
        body: "",
        author: "everdict:agent",
      }),
    );
    await store.update("acme", "c1", { agentActivity: "tool:get_harness_instance" }, "2026-07-01T00:01:00.000Z");
    let c = await store.get("acme", "c1");
    expect(c?.agentActivity).toBe("tool:get_harness_instance");
    expect(c?.updatedAt).toBe("2026-07-01T00:01:00.000Z");
    // terminal patch: final body + complete, null clears the "doing now" line
    await store.update(
      "acme",
      "c1",
      { body: "**Answer**", agentStatus: "complete", agentActivity: null },
      "2026-07-01T00:02:00.000Z",
    );
    c = await store.get("acme", "c1");
    expect(c?.body).toBe("**Answer**");
    expect(c?.agentStatus).toBe("complete");
    expect(c?.agentActivity).toBeUndefined();
  });

  it("update does not touch another workspace's comment", async () => {
    const store = new InMemoryCommentStore();
    await store.add(rec("c1", { agentStatus: "running", authorKind: "agent" }));
    await store.update("beta", "c1", { agentStatus: "failed" }, "2026-07-01T00:01:00.000Z");
    expect((await store.get("acme", "c1"))?.agentStatus).toBe("running");
  });

  it("an absent patch key keeps the stored value", async () => {
    const store = new InMemoryCommentStore();
    await store.add(rec("c1", { authorKind: "agent", agentStatus: "running", agentSessionId: "s-1" }));
    await store.update("acme", "c1", { agentStatus: "awaiting_approval" }, "2026-07-01T00:01:00.000Z");
    const c = await store.get("acme", "c1");
    expect(c?.agentStatus).toBe("awaiting_approval");
    expect(c?.agentSessionId).toBe("s-1"); // untouched
    expect(c?.body).toBe("hello"); // untouched
  });

  // What a list row's thread badge reads. Replies count too — the badge answers "how much conversation is on
  // this", not "how many top-level posts" — and the answer is scoped to one workspace and one resource kind.
  it("counts comments per resource for a whole page, replies included and other resources excluded", async () => {
    const store = new InMemoryCommentStore();
    await store.add(rec("c1", { resourceType: "issue", resourceId: "iss-1" }));
    await store.add(rec("c2", { resourceType: "issue", resourceId: "iss-1", parentId: "c1" })); // a reply
    await store.add(rec("c3", { resourceType: "issue", resourceId: "iss-2" }));
    await store.add(rec("c4", { resourceType: "harness", resourceId: "iss-1" })); // same id, other kind
    await store.add(rec("c5", { resourceType: "issue", resourceId: "iss-1", tenant: "globex" })); // other workspace

    const counts = await store.countByResource("acme", "issue", ["iss-1", "iss-2", "iss-3"]);
    const byId = new Map(counts.map((row) => [row.resourceId, row.count]));
    expect(byId.get("iss-1")).toBe(2);
    expect(byId.get("iss-2")).toBe(1);
    expect(byId.has("iss-3")).toBe(false); // an issue with no comments has no entry — the caller reads it as 0
  });
});
