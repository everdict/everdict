import { describe, expect, it } from "vitest";
import { InMemoryUserProfileStore } from "./user-profile-store.js";

describe("InMemoryUserProfileStore", () => {
  it("a nonexistent subject is undefined", async () => {
    const s = new InMemoryUserProfileStore();
    expect(await s.get("nobody")).toBeUndefined();
  });

  it("upsert merges only the provided fields (undefined=keep)", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { name: "Alice", username: "alice", avatarUrl: "https://x/a.png" });
    const after = await s.upsert("u1", { name: "Alice Kim" }); // doesn't touch username/avatar
    expect(after.name).toBe("Alice Kim");
    expect(after.username).toBe("alice");
    expect(after.avatarUrl).toBe("https://x/a.png");
    expect(after.updatedAt).toBeTypeOf("string");
  });

  it("null clears that field", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { name: "Alice", avatarUrl: "https://x/a.png" });
    const after = await s.upsert("u1", { avatarUrl: null });
    expect(after.name).toBe("Alice");
    expect(after.avatarUrl).toBeUndefined();
    // A cleared field has no key at all on the object (clean shape).
    expect("avatarUrl" in after).toBe(false);
  });

  it("get returns the last-saved profile", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { username: "alice" });
    expect((await s.get("u1"))?.username).toBe("alice");
  });

  it("getMany returns only existing profiles (nonexistent subjects omitted, for enriching a member list)", async () => {
    const s = new InMemoryUserProfileStore();
    await s.upsert("u1", { name: "Alice" });
    await s.upsert("u2", { name: "Bob" });
    const got = await s.getMany(["u1", "ghost", "u2"]);
    expect(got.map((p) => p.subject).sort()).toEqual(["u1", "u2"]);
    expect(await s.getMany([])).toEqual([]);
  });
});
