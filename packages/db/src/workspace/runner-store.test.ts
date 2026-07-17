import { describe, expect, it } from "vitest";
import { InMemoryRunnerStore } from "./runner-store.js";

describe("InMemoryRunnerStore", () => {
  it("pair → list(owner; no token) / resolveByToken / remove + owner isolation + workspace roster", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const alice = await s.pair({
      owner: "u-alice",
      workspace: "acme",
      label: "ho-macbook",
      os: "darwin",
      capabilities: ["repo", "browser"],
    });
    await s.pair({ owner: "u-bob", workspace: "globex", label: "bob-box" });

    const aliceMeta = {
      id: alice.meta.id,
      label: "ho-macbook",
      os: "darwin",
      capabilities: ["repo", "browser"],
      pairedAt: "2026-01-01T00:00:00Z",
    };
    // The pairing token is returned once, in plaintext.
    expect(alice.token).toMatch(/^rnr_/);
    // list has only the owner's meta — there's no token field.
    const list = await s.list("u-alice");
    expect(list).toEqual([aliceMeta]);
    expect(JSON.stringify(list)).not.toContain("rnr_");

    // resolveByToken: resolve a runner by token hash (internal only).
    expect(await s.resolveByToken(alice.token)).toEqual({
      owner: "u-alice",
      workspace: "acme",
      runnerId: alice.meta.id,
    });
    expect(await s.resolveByToken("rnr_unknown")).toBeNull();

    // get: owner-scoped single record (for ownership check). null for a different owner (isolation).
    expect(await s.get("u-alice", alice.meta.id)).toMatchObject({ label: "ho-macbook" });
    expect(await s.get("u-bob", alice.meta.id)).toBeNull();

    // owner isolation: alice can't see bob's runner.
    expect(await s.list("u-bob")).toHaveLength(1);

    // Workspace roster: keyed by the paired workspace.
    expect(await s.listByWorkspace("acme")).toEqual([aliceMeta]);
    expect(await s.listByWorkspace("globex")).toHaveLength(1);

    await s.remove("u-alice", alice.meta.id);
    expect(await s.list("u-alice")).toEqual([]);
    expect(await s.resolveByToken(alice.token)).toBeNull(); // the token is invalidated too
    expect(await s.listByWorkspace("acme")).toEqual([]);
  });

  it("personal ownership: if the same owner pairs across multiple workspaces, the personal list has both and each roster has one", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    await s.pair({ owner: "u-alice", workspace: "globex", label: "desktop" });
    expect(await s.list("u-alice")).toHaveLength(2);
    expect(await s.listByWorkspace("acme")).toHaveLength(1);
    expect(await s.listByWorkspace("globex")).toHaveLength(1);
  });

  it("touch refreshes lastSeenAt, and is a no-op for a missing runner", async () => {
    let t = "2026-01-01T00:00:00Z";
    const s = new InMemoryRunnerStore(() => t);
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    expect((await s.list("u-alice"))[0]?.lastSeenAt).toBeUndefined();
    t = "2026-01-02T00:00:00Z";
    await s.touch("u-alice", r.meta.id);
    expect((await s.list("u-alice"))[0]?.lastSeenAt).toBe("2026-01-02T00:00:00Z");
    await s.touch("u-alice", "nope"); // missing runner — doesn't throw
  });

  it("setCapabilities overwrites capabilities, and is a no-op for a missing runner", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop", capabilities: ["repo"] });
    await s.setCapabilities("u-alice", r.meta.id, ["repo", "docker", "browser"]); // runner self-advertise (docker detected)
    expect((await s.get("u-alice", r.meta.id))?.capabilities).toEqual(["repo", "docker", "browser"]);
    await s.setCapabilities("u-alice", "nope", ["docker"]); // missing runner — doesn't throw
  });

  it("setVersion records the runner's self-reported build/protocol version, and is a no-op for a missing runner", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "laptop" });
    expect((await s.get("u-alice", r.meta.id))?.version).toBeUndefined();
    await s.setVersion("u-alice", r.meta.id, "0.2.0", 1);
    const meta = await s.get("u-alice", r.meta.id);
    expect(meta?.version).toBe("0.2.0");
    expect(meta?.protocol).toBe(1);
    await s.setVersion("u-alice", "nope", "9.9.9", 9); // missing runner — doesn't throw
  });

  it("if capabilities/os are unset, empty array + os omitted", async () => {
    const s = new InMemoryRunnerStore(() => "2026-01-01T00:00:00Z");
    const r = await s.pair({ owner: "u-alice", workspace: "acme", label: "minimal" });
    expect(r.meta.capabilities).toEqual([]);
    expect(r.meta.os).toBeUndefined();
  });
});
