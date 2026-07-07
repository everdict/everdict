import { InMemoryCommentStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { CommentService } from "./comment-service.js";

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
      service.create({ tenant: "acme", resourceType: "project", resourceId: "p", author: "u", body: "x" }),
    ).rejects.toThrow(/Unsupported/);
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
