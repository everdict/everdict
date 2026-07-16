import type { ModelSpec } from "@everdict/contracts";
import type { Principal } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../ports/model-registry.js";
import { deleteModelVersion, deleteModelVersions } from "./model-service.js";

// Minimal fake — models only the (creator, tombstone) state the delete cores touch; the rest are unused here.
// A live version maps to its creator subject; softDelete removes it (tombstone), so creatorOf then throws NotFound.
class FakeModelRegistry implements ModelRegistry {
  private live = new Map<string, string | undefined>();
  private k(t: string, id: string, v: string): string {
    return `${t} ${id} ${v}`;
  }
  seed(tenant: string, id: string, version: string, creator?: string): void {
    this.live.set(this.k(tenant, id, version), creator);
  }
  liveVersions(tenant: string, id: string): string[] {
    const prefix = `${tenant} ${id} `;
    return [...this.live.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }
  async creatorOf(tenant: string, id: string, version: string): Promise<string | undefined> {
    const key = this.k(tenant, id, version);
    if (!this.live.has(key)) throw notFound(tenant, id, version);
    return this.live.get(key);
  }
  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.liveVersions(tenant, id);
  }
  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    if (!this.live.delete(this.k(tenant, id, version))) throw notFound(tenant, id, version);
  }
  // Unused by the delete cores.
  register(): Promise<void> {
    throw unused();
  }
  has(): Promise<boolean> {
    throw unused();
  }
  get(): Promise<ModelSpec> {
    throw unused();
  }
  versions(): Promise<string[]> {
    throw unused();
  }
  list(): Promise<Array<{ id: string; versions: string[]; owner: string; createdBy?: string }>> {
    throw unused();
  }
}

function notFound(tenant: string, id: string, version: string): Error {
  return Object.assign(new Error(`${id}@${version} not found`), { status: 404, tenant });
}
function unused(): Error {
  return new Error("registry method not used in this test");
}
const principal = (subject: string, roles: string[]): Principal => ({ subject, workspace: "acme", roles, via: "oidc" });

describe("deleteModelVersions (bulk soft delete)", () => {
  it("deletes every own live version when versions is omitted (whole-model delete)", async () => {
    const reg = new FakeModelRegistry();
    reg.seed("acme", "gpt", "1.0.0", "u");
    reg.seed("acme", "gpt", "2.0.0", "u");
    const out = await deleteModelVersions(reg, principal("u", ["member"]), "gpt");
    expect(out).toEqual({ workspace: "acme", id: "gpt", deleted: ["1.0.0", "2.0.0"] });
    expect(reg.liveVersions("acme", "gpt")).toEqual([]);
  });

  it("deletes only the selected versions, leaving the rest live", async () => {
    const reg = new FakeModelRegistry();
    reg.seed("acme", "gpt", "1.0.0", "u");
    reg.seed("acme", "gpt", "2.0.0", "u");
    const out = await deleteModelVersions(reg, principal("u", ["member"]), "gpt", ["1.0.0"]);
    expect(out.deleted).toEqual(["1.0.0"]);
    expect(reg.liveVersions("acme", "gpt")).toEqual(["2.0.0"]);
  });

  it("fail-fast: a non-creator non-admin is forbidden and NOTHING is deleted", async () => {
    const reg = new FakeModelRegistry();
    reg.seed("acme", "gpt", "1.0.0", "author");
    reg.seed("acme", "gpt", "2.0.0", "author");
    // A member who did not register these versions can neither delete-all nor delete-subset.
    await expect(deleteModelVersions(reg, principal("intruder", ["member"]), "gpt")).rejects.toMatchObject({
      status: 403,
    });
    expect(reg.liveVersions("acme", "gpt")).toEqual(["1.0.0", "2.0.0"]); // untouched
  });

  it("an admin can delete versions they did not create", async () => {
    const reg = new FakeModelRegistry();
    reg.seed("acme", "gpt", "1.0.0", "author");
    const out = await deleteModelVersions(reg, principal("boss", ["admin"]), "gpt");
    expect(out.deleted).toEqual(["1.0.0"]);
  });

  it("a version the caller cannot delete aborts the whole batch before any delete", async () => {
    const reg = new FakeModelRegistry();
    reg.seed("acme", "gpt", "1.0.0", "author"); // this member's own
    reg.seed("acme", "gpt", "2.0.0", "someone-else"); // not theirs
    await expect(
      deleteModelVersions(reg, principal("author", ["member"]), "gpt", ["1.0.0", "2.0.0"]),
    ).rejects.toMatchObject({ status: 403 });
    expect(reg.liveVersions("acme", "gpt")).toEqual(["1.0.0", "2.0.0"]); // fail-fast: 1.0.0 not deleted either
  });

  it("an unknown / already-fully-deleted model is NotFound (404)", async () => {
    const reg = new FakeModelRegistry();
    await expect(deleteModelVersions(reg, principal("u", ["admin"]), "ghost")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deleteModelVersion (single) still gates creator-or-admin", async () => {
    const reg = new FakeModelRegistry();
    reg.seed("acme", "gpt", "1.0.0", "author");
    await expect(deleteModelVersion(reg, principal("intruder", ["member"]), "gpt", "1.0.0")).rejects.toMatchObject({
      status: 403,
    });
    const out = await deleteModelVersion(reg, principal("author", ["member"]), "gpt", "1.0.0");
    expect(out).toEqual({ workspace: "acme", id: "gpt", version: "1.0.0", deleted: true });
  });
});
