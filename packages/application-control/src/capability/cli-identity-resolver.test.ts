import type { CapabilityRecord, CliIdentitySpec } from "@everdict/contracts";
import { canConsumeCapability } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { CapabilityStore } from "../ports/capability-store.js";
import { cliIdentityResolver } from "./cli-identity-resolver.js";

// A credential is the one thing where "close enough" is a breach, so the double answers the way the real
// store does: `listVisible` applies the SAME consume gate (`canConsumeCapability`) the Pg store mirrors in
// SQL. A fake that returned everything would make the owner filter untestable while looking tested.
function store(records: CapabilityRecord[]): CapabilityStore {
  const visible = (tenant: string, subject: string) =>
    records.filter((r) => canConsumeCapability(r, { tenant, subject }));
  return {
    async register() {},
    async get(tenant, id, ref) {
      return records.find(
        (r) => r.tenant === tenant && r.id === id && (ref === undefined || ref === "latest" || r.version === ref),
      );
    },
    async getVersion(owner, id, version) {
      return records.find((r) => r.tenant === owner && r.id === id && r.version === version);
    },
    async versions(tenant, id) {
      return records.filter((r) => r.tenant === tenant && r.id === id).map((r) => r.version);
    },
    async listVisible(tenant, subject) {
      return visible(tenant, subject);
    },
    async listPublic() {
      return records.filter((r) => r.visibility === "public");
    },
    // The rest of the port. Present because the double implements the INTERFACE rather than being cast to it:
    // a cast would let the port grow a method this lane depends on while every test here kept passing.
    async setVisibility() {},
    async setVersionTags() {},
    async versionTags() {
      return {};
    },
    async softDelete() {},
    async creatorOfVersion(tenant, id, version) {
      return records.find((r) => r.tenant === tenant && r.id === id && r.version === version)?.createdBy;
    },
  };
}

const identity = (over: {
  id: string;
  createdBy: string;
  visibility?: CapabilityRecord["visibility"];
  spec?: Partial<CliIdentitySpec>;
}): CapabilityRecord => {
  const record: CapabilityRecord = {
    id: over.id,
    tenant: "acme",
    version: "1.0.0",
    name: over.id,
    description: "",
    tags: [],
    visibility: over.visibility ?? "private",
    sharedWith: [],
    createdBy: over.createdBy,
    createdAt: "2026-09-17T00:00:00.000Z",
    spec: {
      type: "cli-identity",
      cli: "claude-code",
      env: { CLAUDE_CODE_OAUTH_TOKEN: { secretRef: "TOKEN", scope: "user" } },
      home: [],
      ...over.spec,
    },
  };
  return record;
};

const secretsFor =
  (user: Record<string, string> = { TOKEN: "sk-alice" }) =>
  async () => ({
    workspace: {},
    user,
  });

describe("cli identity resolver — my account is mine", () => {
  // The access half is the store's, but nothing proved this lane USES it. An owner filter nobody drives is a
  // comment, and the thing it guards is a colleague's subscription credential.
  it("does not resolve another member's private identity implicitly", async () => {
    const resolve = cliIdentityResolver({
      capabilities: store([identity({ id: "alices", createdBy: "alice" })]),
      scopedSecretsFor: secretsFor(),
    });

    expect(await resolve("acme", "bob", { cli: "claude-code" })).toEqual({ kind: "none" });
  });

  // And naming it must not confirm it exists — otherwise a refusal tells bob that alice registered a
  // credential, and under what name.
  it("answers a named identity it may not consume exactly like one that is not there", async () => {
    const resolve = cliIdentityResolver({
      capabilities: store([identity({ id: "alices", createdBy: "alice" })]),
      scopedSecretsFor: secretsFor(),
    });

    await expect(resolve("acme", "bob", { cli: "claude-code", ref: { id: "alices" } })).rejects.toThrow(
      /No CLI identity 'alices' this workspace can use/,
    );
    await expect(resolve("acme", "bob", { cli: "claude-code", ref: { id: "never-existed" } })).rejects.toThrow(
      /No CLI identity 'never-existed' this workspace can use/,
    );
  });

  // The precedence this whole record replaces: `workspace ?? user` made a team secret outrank every member's
  // own login. A workspace-visible identity is READABLE by bob — and still must not be picked for him.
  it("never picks a workspace-visible identity implicitly, only a named one", async () => {
    const records = [identity({ id: "team-ci", createdBy: "alice", visibility: "workspace" })];
    const resolve = cliIdentityResolver({ capabilities: store(records), scopedSecretsFor: secretsFor() });

    expect(await resolve("acme", "bob", { cli: "claude-code" })).toEqual({ kind: "none" });

    const named = await resolve("acme", "bob", { cli: "claude-code", ref: { id: "team-ci" } });
    expect(named.kind).toBe("explicit");
  });

  it("uses mine, and reads its credential out of MY secret tier", async () => {
    const resolve = cliIdentityResolver({
      capabilities: store([identity({ id: "mine", createdBy: "alice" })]),
      scopedSecretsFor: secretsFor({ TOKEN: "sk-alice" }),
    });

    const chosen = await resolve("acme", "alice", { cli: "claude-code" });
    expect(chosen.kind).toBe("mine");
    expect(chosen.kind !== "none" && chosen.identity.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-alice");
  });

  // Codex's credential IS a file, so a secret-backed home entry has to resolve the same way env does.
  it("resolves a secret-backed file's contents, without the value ever being in the spec", async () => {
    const record = identity({
      id: "my-codex",
      createdBy: "alice",
      spec: { cli: "codex", env: {}, home: [{ path: ".codex/auth.json", secretRef: "CODEX", scope: "user" }] },
    });
    const resolve = cliIdentityResolver({
      capabilities: store([record]),
      scopedSecretsFor: secretsFor({ CODEX: '{"token":"sk-codex"}' }),
    });

    const chosen = await resolve("acme", "alice", { cli: "codex" });
    expect(chosen.kind !== "none" && chosen.identity.home).toEqual([
      { path: ".codex/auth.json", content: '{"token":"sk-codex"}' },
    ]);
    expect(JSON.stringify(record.spec)).not.toContain("sk-codex");
  });

  // A CLI handed an EMPTY credential file does not fail — it runs as nobody and the session reports success.
  it("refuses a missing secret by name at resolve time, rather than writing an empty credential", async () => {
    const resolve = cliIdentityResolver({
      capabilities: store([identity({ id: "mine", createdBy: "alice" })]),
      scopedSecretsFor: secretsFor({}),
    });

    await expect(resolve("acme", "alice", { cli: "claude-code" })).rejects.toThrow(/needs secret\(s\).*TOKEN/);
  });

  // The CLI is part of the match: an identity for codex must not answer for claude-code.
  it("matches on the CLI, so an identity for another one is not mine for this one", async () => {
    const resolve = cliIdentityResolver({
      capabilities: store([identity({ id: "my-codex", createdBy: "alice", spec: { cli: "codex" } })]),
      scopedSecretsFor: secretsFor(),
    });

    expect(await resolve("acme", "alice", { cli: "claude-code" })).toEqual({ kind: "none" });
  });

  it("refuses two of mine for one CLI instead of choosing", async () => {
    const resolve = cliIdentityResolver({
      capabilities: store([
        identity({ id: "personal", createdBy: "alice" }),
        identity({ id: "work", createdBy: "alice" }),
      ]),
      scopedSecretsFor: secretsFor(),
    });

    await expect(resolve("acme", "alice", { cli: "claude-code" })).rejects.toThrow(/personal, work/);
  });
});
