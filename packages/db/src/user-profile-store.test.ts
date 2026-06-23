import { describe, expect, it } from "vitest";
import { InMemoryUserProfileStore } from "./user-profile-store.js";

describe("InMemoryUserProfileStore", () => {
  it("없는 subject 는 undefined", async () => {
    const s = new InMemoryUserProfileStore();
    expect(await s.get("nobody")).toBeUndefined();
  });

  it("upsert 는 제공한 필드만 병합(undefined=유지)", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { name: "Alice", username: "alice", avatarUrl: "https://x/a.png" });
    const after = await s.upsert("u1", { name: "Alice Kim" }); // username/avatar 는 건드리지 않음
    expect(after.name).toBe("Alice Kim");
    expect(after.username).toBe("alice");
    expect(after.avatarUrl).toBe("https://x/a.png");
    expect(after.updatedAt).toBeTypeOf("string");
  });

  it("null 은 해당 필드를 지운다", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { name: "Alice", avatarUrl: "https://x/a.png" });
    const after = await s.upsert("u1", { avatarUrl: null });
    expect(after.name).toBe("Alice");
    expect(after.avatarUrl).toBeUndefined();
    // 지워진 필드는 객체에 키 자체가 없다(깔끔한 모양).
    expect("avatarUrl" in after).toBe(false);
  });

  it("get 은 마지막으로 저장된 프로필을 돌려준다", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { username: "alice" });
    expect((await s.get("u1"))?.username).toBe("alice");
  });

  it("getMany 는 존재하는 프로필만 돌려준다(없는 subject 는 누락, 멤버 목록 보강용)", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { name: "Alice" });
    await s.upsert("u2", { name: "Bob" });
    const got = await s.getMany(["u1", "ghost", "u2"]);
    expect(got.map((p) => p.subject).sort()).toEqual(["u1", "u2"]);
    expect(await s.getMany([])).toEqual([]);
  });
});
