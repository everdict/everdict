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
  it("작성 후 리소스별로 오래된→최신 순으로 조회된다(워크스페이스 스코프)", async () => {
    const { service } = svc();
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "officeqa",
      author: "u-a",
      body: "첫 댓글",
    });
    await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "officeqa",
      author: "u-b",
      body: "둘째",
    });
    // 다른 리소스/테넌트는 섞이지 않는다.
    await service.create({ tenant: "acme", resourceType: "dataset", resourceId: "other", author: "u-a", body: "무관" });
    await service.create({
      tenant: "beta",
      resourceType: "dataset",
      resourceId: "officeqa",
      author: "u-c",
      body: "타테넌트",
    });

    const list = await service.list("acme", "dataset", "officeqa");
    expect(list.map((c) => c.body)).toEqual(["첫 댓글", "둘째"]);
    expect(list.map((c) => c.author)).toEqual(["u-a", "u-b"]);
  });

  it("빈 본문은 400, 공백만도 400", async () => {
    const { service } = svc();
    await expect(
      service.create({ tenant: "acme", resourceType: "dataset", resourceId: "d", author: "u", body: "   " }),
    ).rejects.toThrow(/내용을 입력/);
  });

  it("지원하지 않는 resourceType 은 400", async () => {
    const { service } = svc();
    await expect(
      service.create({ tenant: "acme", resourceType: "project", resourceId: "p", author: "u", body: "x" }),
    ).rejects.toThrow(/지원하지 않는/);
  });

  it("삭제는 작성자 본인만 — 타인은 403, admin 은 가능, 없으면 404", async () => {
    const { service } = svc();
    const c = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u-owner",
      body: "삭제 대상",
    });
    // 타인(비-admin) → 403
    await expect(service.delete({ tenant: "acme", id: c.id, subject: "u-other", isAdmin: false })).rejects.toThrow(
      /본인.*또는 관리자/,
    );
    // admin → 성공
    await service.delete({ tenant: "acme", id: c.id, subject: "u-other", isAdmin: true });
    expect(await service.list("acme", "dataset", "d")).toHaveLength(0);
    // 없는 id → 404
    await expect(service.delete({ tenant: "acme", id: "nope", subject: "u-owner", isAdmin: true })).rejects.toThrow(
      /찾을 수 없/,
    );
  });

  it("멘션이 있으면 작성자를 제외한 수신자들에게 notifyMention 을 호출한다(중복 제거)", async () => {
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
      body: "@bob @carol 확인 부탁",
      mentions: ["u-bob", "u-carol", "u-bob", "u-me"], // 중복 + 작성자 자신
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipients.sort()).toEqual(["u-bob", "u-carol"]); // 자기 자신·중복 제외
  });

  it("멘션이 없으면 notifyMention 을 호출하지 않는다", async () => {
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
    await service.create({ tenant: "acme", resourceType: "dataset", resourceId: "d", author: "u", body: "멘션 없음" });
    expect(called).toBe(0);
  });

  it("대댓글: 최상위 댓글에만 달 수 있고, 대댓글에 다시 답글은 400", async () => {
    const { service } = svc();
    const top = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u1",
      body: "최상위",
    });
    const reply = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u2",
      body: "답글",
      parentId: top.id,
    });
    expect(reply.parentId).toBe(top.id);
    // 대댓글에 다시 답글 → 400(1단계 강제)
    await expect(
      service.create({
        tenant: "acme",
        resourceType: "dataset",
        resourceId: "d",
        author: "u3",
        body: "재답글",
        parentId: reply.id,
      }),
    ).rejects.toThrow(/다시 답글/);
    // 다른 리소스/없는 부모 → 400
    await expect(
      service.create({
        tenant: "acme",
        resourceType: "dataset",
        resourceId: "other",
        author: "u3",
        body: "x",
        parentId: top.id,
      }),
    ).rejects.toThrow(/부모 댓글/);
  });

  it("부모 삭제 시 대댓글도 함께 삭제된다(cascade)", async () => {
    const { service } = svc();
    const top = await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u1",
      body: "부모",
    });
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u2",
      body: "답글1",
      parentId: top.id,
    });
    await service.create({
      tenant: "acme",
      resourceType: "harness",
      resourceId: "h",
      author: "u3",
      body: "답글2",
      parentId: top.id,
    });
    expect(await service.list("acme", "harness", "h")).toHaveLength(3);
    await service.delete({ tenant: "acme", id: top.id, subject: "u1", isAdmin: false });
    expect(await service.list("acme", "harness", "h")).toHaveLength(0); // 부모+대댓글 모두 삭제
  });

  it("확장된 resourceType(harness/scorecard/runtime 등)도 허용된다", async () => {
    const { service } = svc();
    for (const rt of ["harness", "scorecard", "view", "schedule", "run", "runtime"]) {
      const c = await service.create({
        tenant: "acme",
        resourceType: rt,
        resourceId: "x",
        author: "u",
        body: `${rt} 댓글`,
      });
      expect(c.resourceType).toBe(rt);
    }
  });

  it("작성자 본인은 삭제 가능(admin 아니어도)", async () => {
    const { service } = svc();
    const c = await service.create({
      tenant: "acme",
      resourceType: "dataset",
      resourceId: "d",
      author: "u-me",
      body: "내 댓글",
    });
    await service.delete({ tenant: "acme", id: c.id, subject: "u-me", isAdmin: false });
    expect(await service.list("acme", "dataset", "d")).toHaveLength(0);
  });
});
