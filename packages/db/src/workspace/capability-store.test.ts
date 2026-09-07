import { type CapabilityRecord, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";

import { InMemoryCapabilityStore, PgCapabilityStore } from "./capability-store.js";

const cap = (over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
  id: "triage",
  tenant: "acme",
  version: "1.0.0",
  name: "triage",
  description: "when to triage",
  spec: { type: "skill", instructions: "do the thing", files: [] },
  visibility: "workspace",
  sharedWith: [],
  tags: [],
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("InMemoryCapabilityStore", () => {
  it("registers immutable versions and resolves latest / exact", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0" }));
    await store.register(cap({ version: "1.1.0", description: "v2" }));
    expect((await store.get("acme", "triage"))?.version).toBe("1.1.0"); // latest
    expect((await store.get("acme", "triage", "1.0.0"))?.description).toBe("when to triage");
    expect(await store.versions("acme", "triage")).toEqual(["1.0.0", "1.1.0"]);
  });

  it("rejects re-registering a version with different content but is idempotent for identical content", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0" }));
    await store.register(cap({ version: "1.0.0" })); // identical → no-op
    await expect(store.register(cap({ version: "1.0.0", description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("does not treat a reach (visibility) change as a content conflict", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0", visibility: "private" }));
    // same content, different visibility metadata → idempotent, not a conflict
    await expect(store.register(cap({ version: "1.0.0", visibility: "public" }))).resolves.toBeUndefined();
  });

  it("soft-deletes a version (hidden from reads) and revives it on identical re-register", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0" }));
    await store.register(cap({ version: "1.1.0" }));
    await store.softDelete("acme", "triage", "1.1.0");
    expect((await store.get("acme", "triage"))?.version).toBe("1.0.0"); // falls back to the live version
    expect(await store.versions("acme", "triage")).toEqual(["1.0.0"]);
    await store.register(cap({ version: "1.1.0" })); // identical content revives the tombstone
    expect(await store.versions("acme", "triage")).toEqual(["1.0.0", "1.1.0"]);
  });

  it("listVisible returns own-visible + subset-shared-to-me, excludes others' workspace/private/public", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "mine-priv", tenant: "acme", createdBy: "alice", visibility: "private" }));
    await store.register(cap({ id: "bob-priv", tenant: "acme", createdBy: "bob", visibility: "private" }));
    await store.register(cap({ id: "ws", tenant: "acme", visibility: "workspace" }));
    await store.register(cap({ id: "shared-in", tenant: "beta", visibility: "subset", sharedWith: ["acme"] }));
    await store.register(cap({ id: "other-ws", tenant: "beta", visibility: "workspace" }));
    await store.register(cap({ id: "other-pub", tenant: "beta", visibility: "public" })); // public from others → listPublic, not here
    const ids = (await store.listVisible("acme", "alice")).map((r) => r.id).sort();
    expect(ids).toEqual(["mine-priv", "shared-in", "ws"]);
  });

  it("listVisible resolves the latest live version per capability", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "x", version: "1.0.0", visibility: "workspace" }));
    await store.register(cap({ id: "x", version: "2.0.0", visibility: "workspace", description: "newer" }));
    const rows = await store.listVisible("acme", "alice");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe("2.0.0");
  });

  it("listPublic returns only public capabilities across tenants (latest per id)", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "p", tenant: "beta", visibility: "public", version: "1.0.0" }));
    await store.register(cap({ id: "p", tenant: "beta", visibility: "public", version: "1.2.0", description: "n" }));
    await store.register(cap({ id: "ws", tenant: "beta", visibility: "workspace" }));
    const pub = await store.listPublic();
    expect(pub.map((r) => `${r.tenant}/${r.id}@${r.version}`)).toEqual(["beta/p@1.2.0"]);
  });

  it("setVisibility promotes reach across every live version, making a subset visible to its targets", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "s", version: "1.0.0", visibility: "private", createdBy: "alice" }));
    await store.register(cap({ id: "s", version: "1.1.0", visibility: "private", createdBy: "alice" }));
    await store.setVisibility("acme", "s", { visibility: "subset", sharedWith: ["beta"] });
    expect((await store.getVersion("acme", "s", "1.0.0"))?.visibility).toBe("subset");
    expect((await store.getVersion("acme", "s", "1.1.0"))?.sharedWith).toEqual(["beta"]);
    expect((await store.listVisible("beta", "carol")).map((r) => r.id)).toEqual(["s"]);
  });

  it("setVersionTags replaces a single version's tags; versionTags returns the map of tagged live versions only", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "t", version: "1.0.0" }));
    await store.register(cap({ id: "t", version: "1.1.0" }));
    await store.setVersionTags("acme", "t", "1.0.0", ["baseline", "stable"]);
    await store.setVersionTags("acme", "t", "1.1.0", ["candidate"]);
    expect((await store.getVersion("acme", "t", "1.0.0"))?.tags).toEqual(["baseline", "stable"]);
    expect(await store.versionTags("acme", "t")).toEqual({ "1.0.0": ["baseline", "stable"], "1.1.0": ["candidate"] });
    // clearing a version drops it from the map
    await store.setVersionTags("acme", "t", "1.0.0", []);
    expect(await store.versionTags("acme", "t")).toEqual({ "1.1.0": ["candidate"] });
  });

  it("setVersionTags is a no-op on a tombstoned or missing version", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "t", version: "1.0.0" }));
    await store.softDelete("acme", "t", "1.0.0");
    await store.setVersionTags("acme", "t", "1.0.0", ["x"]); // tombstoned → no revive, no throw
    await store.setVersionTags("acme", "t", "9.9.9", ["y"]); // missing → no throw
    expect(await store.versionTags("acme", "t")).toEqual({});
  });

  it("creatorOfVersion returns the registering subject for a live version, undefined once tombstoned", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0", createdBy: "alice" }));
    expect(await store.creatorOfVersion("acme", "triage", "1.0.0")).toBe("alice");
    await store.softDelete("acme", "triage", "1.0.0");
    expect(await store.creatorOfVersion("acme", "triage", "1.0.0")).toBeUndefined();
  });

  it("round-trips the environment kind — an image asset with its preset dowry survives the store intact", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(
      cap({
        id: "officeqa-env",
        name: "officeqa-env",
        spec: {
          type: "environment",
          image: "ghcr.io/acme/officeqa-env@sha256:ab12",
          contents: { benchmark: "officeqa", packages: ["libreoffice"] },
          preset: {
            service: { port: 8000, env: { LOG_LEVEL: "info" } },
            dependencies: [{ store: "redis", role: "bus", purpose: "plumbing", isolateBy: "key-prefix" }],
          },
          instructions: "Entry point serves on :8000.",
        },
      }),
    );
    const read = await store.get("acme", "officeqa-env");
    expect(read?.spec.type).toBe("environment");
    if (read?.spec.type !== "environment") throw new Error("expected environment");
    expect(read.spec.image).toBe("ghcr.io/acme/officeqa-env@sha256:ab12");
    expect(read.spec.preset?.dependencies[0]?.store).toBe("redis");
  });
});

// ── THE INSERT IS THE ARBITER, AND THIS IS THE SHAPE HALF ────────────────────────────────────────
//
// `PgCapabilityStore.register` read the row, decided "absent", and inserted — and `(tenant, id, version)` is
// the primary key, so two concurrent registrations of one new version both inserted and the loser met a
// unique violation that escaped as a raw driver error. What actually happens under that race is decided by
// an engine, so the certification is TRUST-195 against a live Postgres.
//
// This is the shape, and it is here because that suite is env-gated: without it `pnpm test` and the commit
// gate's fix proof say nothing at all about this store, which is the state the defect lived in.
describe("PgCapabilityStore register", () => {
  const ROW = (instructions: string) => ({
    tenant: "acme",
    id: "triage",
    version: "1.0.0",
    name: "triage",
    description: "when to triage",
    spec: { type: "skill", instructions, files: [] },
    visibility: "private",
    shared_with: [],
    tags: [],
    created_by: "alice",
    created_at: "2026-01-01T00:00:00.000Z",
  });

  // ⚠️ THE FAKE MODELS THE RACE, WHICH IS WHAT MAKES THESE COUNTEREXAMPLES RATHER THAN CONFIRMATIONS. A lost
  // race is one fact: NOTHING is there when you look, and the key is TAKEN by the time you insert. So a SELECT
  // before any insert answers empty and a SELECT after one answers the winner's row — a rule about the world,
  // not a queue keyed to one implementation's read order, which is the difference that matters: the pre-fix
  // store reads first and the repaired one reads only after losing, and a positional queue would feed them
  // different worlds and prove nothing.
  //
  // Under it the pre-fix store takes its pre-read, sees nothing, inserts, and returns silently — where in
  // production the driver's unique violation escapes raw.
  const racingClient = (opts: { insert: unknown[]; taken: unknown }) => {
    const statements: string[] = [];
    let inserted = false;
    return {
      statements,
      client: {
        query: async <R>(text: string) => {
          statements.push(text.replace(/\s+/g, " ").trim());
          if (text.includes("INSERT INTO everdict_capabilities")) {
            inserted = true;
            return { rows: opts.insert as R[] };
          }
          if (text.trimStart().startsWith("SELECT")) return { rows: (inserted ? [opts.taken] : []) as R[] };
          return { rows: [] as R[] };
        },
      },
    };
  };

  it("lets the key decide, rather than a read above the insert", async () => {
    const { client, statements } = racingClient({ insert: [{ ok: 1 }], taken: ROW("do the thing") });
    await new PgCapabilityStore(client).register(cap());

    const insert = statements.find((t) => t.includes("INSERT INTO everdict_capabilities"));
    expect(insert, "no insert was issued at all").toBeDefined();
    // The conflict target is the primary key, and the answer comes back — without `RETURNING` there is no way
    // to learn the row was already there other than by catching the driver's error.
    expect(insert).toContain("ON CONFLICT (tenant, id, version) DO NOTHING");
    expect(insert).toContain("RETURNING 1");
  });

  it("refuses the loser of a race whose content differs, in this store's own error", async () => {
    // Nothing there when we looked; the key taken by the time we inserted; different content behind it.
    // Pre-fix there is no losing arm at all — the store inserts and returns, and in production the driver's
    // unique violation escapes raw.
    const { client } = racingClient({ insert: [], taken: ROW("something else") });

    await expect(new PgCapabilityStore(client).register(cap())).rejects.toBeInstanceOf(ConflictError);
  });

  it("revives the tombstone when the loser's content is identical", async () => {
    // The admitted class, and the reason the losing arm re-reads rather than simply refusing: re-registering
    // identical content is how a soft-deleted capability comes back.
    const { client, statements } = racingClient({ insert: [], taken: ROW("do the thing") });

    await new PgCapabilityStore(client).register(cap());
    expect(statements.some((t) => t.startsWith("UPDATE everdict_capabilities SET deleted_at=NULL"))).toBe(true);
  });
});
