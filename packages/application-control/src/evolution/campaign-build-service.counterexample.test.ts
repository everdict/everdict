import type { CampaignBuildRecord, CampaignBuildSetRecord } from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CampaignBuildStore } from "../ports/evolution-campaign-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import {
  type BuildSession,
  type CampaignBuildDeps,
  CampaignBuildService,
  ENVIRONMENT_SLOT,
} from "./campaign-build-service.js";

// A minimal build store that makes the SAME conditional decisions the real one does (rule `testing`): the
// settle answers `not_building`/`absent` rather than always succeeding, and it lives in THIS package (db, where
// the real InMemory lives, sits ABOVE application-control — importing it here would be a reverse dependency).
class FakeBuildStore implements CampaignBuildStore {
  readonly byId = new Map<string, CampaignBuildRecord>();
  readonly events: OutboxEvent[] = [];
  async create(record: CampaignBuildRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }
  async get(tenant: string, id: string): Promise<CampaignBuildRecord | undefined> {
    const r = this.byId.get(id);
    return r && r.tenant === tenant ? r : undefined;
  }
  async forCampaign(tenant: string, campaignId: string): Promise<CampaignBuildRecord[]> {
    return [...this.byId.values()].filter((r) => r.tenant === tenant && r.campaignId === campaignId);
  }
  async complete(
    tenant: string,
    id: string,
    result: {
      sha: string;
      image: NonNullable<CampaignBuildRecord["image"]>;
      candidateVersion: string;
      receipt: NonNullable<CampaignBuildRecord["receipt"]>;
      at: string;
    },
    events?: OutboxEvent[],
  ): Promise<"completed" | "not_building" | "absent"> {
    const r = await this.get(tenant, id);
    if (!r) return "absent";
    if (r.state !== "building") return "not_building";
    this.byId.set(id, {
      ...r,
      state: "built",
      source: { ...r.source, sha: result.sha },
      image: result.image,
      candidateVersion: result.candidateVersion,
      receipt: result.receipt,
      updatedAt: result.at,
    });
    if (events) this.events.push(...events);
    return "completed";
  }
  async fail(
    tenant: string,
    id: string,
    failure: { error: string; sha?: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"failed" | "not_building" | "absent"> {
    const r = await this.get(tenant, id);
    if (!r) return "absent";
    if (r.state !== "building") return "not_building";
    this.byId.set(id, {
      ...r,
      state: "failed",
      ...(failure.sha !== undefined ? { source: { ...r.source, sha: failure.sha } } : {}),
      error: failure.error,
      updatedAt: failure.at,
    });
    if (events) this.events.push(...events);
    return "failed";
  }
  outbox(): OutboxEvent[] {
    return [...this.events];
  }
  // ── the build SET (routing spec §4) — the same decisions the in-memory and Pg stores make ──
  readonly sets = new Map<string, CampaignBuildSetRecord>();
  async createSet(record: CampaignBuildSetRecord, events?: OutboxEvent[]): Promise<void> {
    this.sets.set(record.id, record);
    if (events) this.events.push(...events);
  }
  async getSet(tenant: string, id: string): Promise<CampaignBuildSetRecord | undefined> {
    const r = this.sets.get(id);
    return r && r.tenant === tenant ? r : undefined;
  }
  async setsForCampaign(tenant: string, campaignId: string): Promise<CampaignBuildSetRecord[]> {
    return [...this.sets.values()].filter((r) => r.tenant === tenant && r.campaignId === campaignId);
  }
  async claimMint(
    tenant: string,
    setId: string,
    at: string,
  ): Promise<"claimed" | "already_claimed" | "not_building" | "absent"> {
    // No await before the transition: the real statement is one atomic UPDATE, and a twin that yields between
    // its read and its write hands two callers the same claim — which is exactly what the concurrency case found.
    const r = this.sets.get(setId);
    if (!r || r.tenant !== tenant) return "absent";
    if (r.state === "minting") return "already_claimed";
    if (r.state !== "building") return "not_building";
    this.sets.set(setId, { ...r, state: "minting", updatedAt: at });
    return "claimed";
  }
  async settleSet(
    tenant: string,
    setId: string,
    outcome:
      | { state: "minted"; candidateVersion: string; images: Record<string, string>; sha: string; at: string }
      | { state: "failed"; error: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"settled" | "not_settleable" | "absent"> {
    const r = await this.getSet(tenant, setId);
    if (!r) return "absent";
    const allowed =
      outcome.state === "minted" ? r.state === "minting" : r.state === "building" || r.state === "minting";
    if (!allowed) return "not_settleable";
    this.sets.set(
      setId,
      outcome.state === "minted"
        ? {
            ...r,
            state: "minted",
            candidateVersion: outcome.candidateVersion,
            images: outcome.images,
            sha: outcome.sha,
            updatedAt: outcome.at,
          }
        : { ...r, state: "failed", error: outcome.error, updatedAt: outcome.at },
    );
    if (events) this.events.push(...events);
    return "settled";
  }
}

// ── EVERDICT BUILDS THE CANDIDATE, INTO ITS OWN STORE (docs/architecture/code-evolution-loop.md, D2) ──
//
// A build session boots the slot's base image, checks out the commit, runs the template's frozen steps, and
// publishes the result as one layer in the managed store — Everdict builds it, no outside CI. Every fact the
// record carries is Everdict's own: the commit is what the session OBSERVED (`git rev-parse HEAD`), the image
// is what the store returned, the version is what the re-pin minted. These pin that the build reads the recipe
// from the template (not the caller), settles `built`/`failed` (never leaves `building`), and never touches the
// registry once a step failed.

const RECIPE = {
  source: { git: "https://github.com/acme/scaffold.git", repo: "acme/scaffold" },
  build: { steps: ["cp -r /everdict/repo/. .", "make"], workDir: "/everdict/build", capture: ["/everdict/build"] },
};

function fakeSession(
  over: Partial<{
    steps: Record<string, { exitCode: number; stdout?: string; stderr?: string }>;
    head: string;
    publishThrows: boolean;
  }> = {},
): BuildSession & {
  execs: string[];
  published: Array<{ repository: string; tag: string; roots: string[] }>;
  closed: string[];
} {
  const execs: string[] = [];
  const published: Array<{ repository: string; tag: string; roots: string[] }> = [];
  const closed: string[] = [];
  return {
    execs,
    published,
    closed,
    async create(input) {
      execs.push(`create ${input.image} ${input.repo.git}@${input.repo.ref ?? ""}`);
      return { id: "run_1" };
    },
    async exec(_actor, _runId, input) {
      execs.push(input.command);
      if (input.command.includes("rev-parse HEAD"))
        return { stdout: over.head ?? "abc123def456", stderr: "", exitCode: 0 };
      const hit = Object.entries(over.steps ?? {}).find(([k]) => input.command.includes(k));
      if (hit) return { stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "", exitCode: hit[1].exitCode };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async publishBuildLayer(_actor, _runId, input) {
      if (over.publishThrows) throw new Error("registry refused the manifest");
      published.push({ repository: input.repository, tag: input.tag, roots: input.roots });
      return { digest: "sha256:beefface" };
    },
    async close(_actor, runId) {
      closed.push(runId);
      return undefined;
    },
    imageEndpoint: () => ({ endpoint: "reg.local", namespaceFor: (t) => `ws-${t}` }),
  };
}

function service(store: FakeBuildStore, sessions: BuildSession, over: Partial<CampaignBuildDeps> = {}) {
  let minted = 0;
  const deps: CampaignBuildDeps = {
    builds: store,
    campaigns: {
      get: async (_t, id) => ({
        id,
        subjectType: "harness",
        subjectId: "scaffold",
        baselineVersion: "1.0.0",
      }),
    },
    harness: {
      instance: async () =>
        ({ template: { id: "scaffold-t", version: "1.0.0" }, id: "scaffold", version: "1.0.0", pins: {} }) as never,
      template: async () =>
        ({
          kind: "command",
          id: "scaffold-t",
          version: "1.0.0",
          command: "run",
          source: RECIPE.source,
          build: RECIPE.build,
        }) as never,
      resolvedImageOf: async () => "reg/scaffold:1.0.0",
    },
    // The environment lane is a required dependency; this suite drives the HARNESS lane, so both members
    // refuse — a fixture that omitted them would not compile, which is why they are required.
    environment: {
      get: async () => {
        throw new Error("the harness lane never reads an environment");
      },
      mint: async () => {
        throw new Error("the harness lane never mints an environment");
      },
    },
    repin: async ({ pins }) => {
      minted += 1;
      expect(pins.image).toBe("reg.local/ws-acme/scaffold-image:sha-abc123def456@sha256:beefface");
      expect(Object.keys(pins)).toEqual(["image"]);
      return { version: `1.0.${minted}` };
    },
    sessions,
    newId: () => "bld_1",
    now: () => "2026-09-02T00:00:00.000Z",
    ...over,
  };
  return new CampaignBuildService(deps);
}

describe("[D2 COUNTEREXAMPLE] Everdict builds the candidate into its own store, and its account is its own", () => {
  it("boots the base, checks out the commit, runs the recipe's steps, publishes a layer, mints the version", async () => {
    const store = new FakeBuildStore();
    const sessions = fakeSession();
    const svc = service(store, sessions);
    const opened = await svc.start(
      "acme",
      { campaignId: "evc_1", ref: "pr-7", repo: "acme/scaffold", prNumber: 7 },
      "alice",
    );
    expect(opened.state).toBe("building");
    expect(opened.base.image).toBe("reg/scaffold:1.0.0");

    const built = await svc.run("acme", opened.id);
    expect(built.state).toBe("built");
    // The commit is what the SESSION observed, not the caller's `ref`.
    expect(built.source.sha).toBe("abc123def456");
    expect(built.source.ref).toBe("pr-7");
    expect(built.candidateVersion).toBe("1.0.1");
    expect(built.image?.digest).toBe("sha256:beefface");
    expect(built.receipt?.steps).toEqual(RECIPE.build.steps);
    // The layer was captured from the recipe's capture roots, into the harness+slot repository.
    expect(sessions.published).toEqual([
      { repository: "scaffold-image", tag: "sha-abc123def456", roots: ["/everdict/build"] },
    ]);
    expect(sessions.execs.some((c) => c.includes("rev-parse HEAD"))).toBe(true);
    expect(sessions.execs.some((c) => c.includes("make"))).toBe(true);
    expect(sessions.closed).toContain("run_1");
    const fact = store.outbox().find((e) => e.kind === "campaign.candidate_built");
    expect(fact?.payload).toMatchObject({ candidateVersion: "1.0.1", sha: "abc123def456", slot: "image" });
  });

  it("a failed build step settles `failed` with the reason, publishes nothing, and never mints a version", async () => {
    const store = new FakeBuildStore();
    const sessions = fakeSession({ steps: { make: { exitCode: 2, stderr: "make: *** [all] Error 2" } } });
    const svc = service(store, sessions);
    const opened = await svc.start("acme", { campaignId: "evc_1", ref: "pr-7" }, "alice");
    const failed = await svc.run("acme", opened.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/Error 2/);
    expect(sessions.published).toEqual([]);
    expect(sessions.closed).toContain("run_1"); // the session is torn down even on failure
    expect(store.outbox().some((e) => e.kind === "campaign.candidate_build_failed")).toBe(true);
  });

  it("refuses an agent campaign — code is only built for a harness campaign", async () => {
    const store = new FakeBuildStore();
    const svc = service(store, fakeSession(), {
      campaigns: {
        get: async (_t, id) => ({ id, subjectType: "agent", subjectId: "everdict", baselineVersion: "1.0.0" }),
      },
    });
    await expect(svc.start("acme", { campaignId: "evc_1", ref: "x" }, "alice")).rejects.toThrow(
      /only a harness or environment campaign/,
    );
  });

  it("refuses a template with no build recipe — a harness that cannot be built is pinned, not built", async () => {
    const store = new FakeBuildStore();
    const svc = service(store, fakeSession(), {
      harness: {
        instance: async () =>
          ({ template: { id: "t", version: "1.0.0" }, id: "scaffold", version: "1.0.0", pins: {} }) as never,
        template: async () => ({ kind: "command", id: "t", version: "1.0.0", command: "run" }) as never,
        resolvedImageOf: async () => "reg/scaffold:1.0.0",
      },
    });
    await expect(svc.start("acme", { campaignId: "evc_1", ref: "x" }, "alice")).rejects.toThrow(/no buildable slot/);
  });

  it("a publish that fails leaves the build `failed`, not a dangling `building` row", async () => {
    const store = new FakeBuildStore();
    const svc = service(store, fakeSession({ publishThrows: true }));
    const opened = await svc.start("acme", { campaignId: "evc_1", ref: "x" }, "alice");
    const settled = await svc.run("acme", opened.id);
    expect(settled.state).toBe("failed");
    expect(settled.error).toMatch(/registry refused/);
  });
});

// ── A BUILD SET MINTS ONCE, UNDER A CLAIM (docs/architecture/evolution-routing-spec.md §4) ───────────
//
// RED before the set existed: two slots of one pull request needed two builds and a hand-composed pin set, and
// the two intermediate versions each build minted were never run.
describe("[COUNTEREXAMPLE] a build set — several slots, one pull request, one claimed mint", () => {
  const TOPOLOGY = {
    kind: "service",
    id: "shop-t",
    version: "1.0.0",
    services: [
      {
        name: "web",
        slot: "web",
        source: { git: "https://github.com/acme/shop.git", repo: "acme/shop" },
        build: { steps: ["make web"], workDir: "/everdict/build" },
      },
      {
        name: "api",
        slot: "api",
        source: { git: "https://github.com/acme/shop.git", repo: "acme/shop" },
        build: { steps: ["make api"], workDir: "/everdict/build" },
      },
      { name: "db", slot: "db" },
    ],
  };
  function setService(store: FakeBuildStore, sessions: BuildSession, over: Partial<CampaignBuildDeps> = {}) {
    let n = 0;
    const repins: Array<{ pins: Record<string, string>; version?: string }> = [];
    const deps: CampaignBuildDeps = {
      builds: store,
      campaigns: {
        get: async (_t, id) => ({
          id,
          subjectType: "harness",
          subjectId: "shop",
          baselineVersion: "1.0.0",
        }),
      },
      harness: {
        instance: async () =>
          ({ template: { id: "shop-t", version: "1.0.0" }, id: "shop", version: "1.0.0", pins: {} }) as never,
        template: async () => TOPOLOGY as never,
        resolvedImageOf: async (_t, _id, _v, slot) => `reg/${slot}:1.0.0`,
      },
      // The environment lane is a required dependency; this suite drives the HARNESS lane, so both members
      // refuse — a fixture that omitted them would not compile, which is why they are required.
      environment: {
        get: async () => {
          throw new Error("the harness lane never reads an environment");
        },
        mint: async () => {
          throw new Error("the harness lane never mints an environment");
        },
      },
      repin: async ({ pins, version }) => {
        repins.push({ pins, ...(version !== undefined ? { version } : {}) });
        return { version: version ?? `1.0.${repins.length}` };
      },
      sessions,
      newId: () => `set_${++n}`,
      now: () => "2026-09-02T00:00:00.000Z",
      ...over,
    };
    return { svc: new CampaignBuildService(deps), repins };
  }

  it("builds every member without minting, then mints ONE version carrying every slot's pin under the set's name", async () => {
    const store = new FakeBuildStore();
    const { svc, repins } = setService(store, fakeSession());
    const set = await svc.startSet(
      "acme",
      { campaignId: "evc_1", ref: "pr-7", repo: "acme/shop", prNumber: 7, slots: ["web", "api"] },
      "alice",
    );
    expect(set.memberIds).toEqual(["set_1-web", "set_1-api"]);
    expect(set.versionName).toBe("1.0.0-set-set_1");
    const done = await svc.runSet("acme", set.id);
    expect(done.state, done.error).toBe("minted");
    expect(done.candidateVersion).toBe("1.0.0-set-set_1");
    expect(repins).toHaveLength(1);
    expect(repins[0]).toEqual({
      pins: {
        web: "reg.local/ws-acme/shop-web:sha-abc123def456@sha256:beefface",
        api: "reg.local/ws-acme/shop-api:sha-abc123def456@sha256:beefface",
      },
      version: "1.0.0-set-set_1",
    });
    // Members carry no version of their own: the SET minted.
    for (const id of set.memberIds) expect((await store.get("acme", id))?.candidateVersion).toBeUndefined();
    expect(store.outbox().filter((e) => e.kind === "campaign.candidate_built")).toHaveLength(1);
  });

  it("two drivers finishing the same set mint exactly once — the claim is the authority, not the last completion", async () => {
    const store = new FakeBuildStore();
    const { svc, repins } = setService(store, fakeSession());
    const set = await svc.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web", "api"] }, "alice");
    await Promise.all([svc.runSet("acme", set.id), svc.runSet("acme", set.id)]);
    expect(repins, "the mint happened more than once").toHaveLength(1);
    expect((await store.getSet("acme", set.id))?.state).toBe("minted");
  });

  it("a member that fails fails the set with no mint; members observing different commits fail it as 'the pull request moved'", async () => {
    const failing = new FakeBuildStore();
    const { svc: f, repins: fr } = setService(
      failing,
      fakeSession({ steps: { "make api": { exitCode: 2, stderr: "boom" } } }),
    );
    const s1 = await f.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web", "api"] }, "alice");
    const failed = await f.runSet("acme", s1.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/boom/);
    expect(fr).toHaveLength(0);
    // The pull request moves between the two member checkouts.
    const moving = new FakeBuildStore();
    const heads = ["sha-one", "sha-two"];
    const session = fakeSession();
    const original = session.exec.bind(session);
    session.exec = async (actor, runId, input) => {
      if (input.command.includes("rev-parse HEAD"))
        return { stdout: heads.shift() ?? "sha-two", stderr: "", exitCode: 0 };
      return original(actor, runId, input);
    };
    const { svc: m, repins: mr } = setService(moving, session);
    const s2 = await m.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web", "api"] }, "alice");
    const moved = await m.runSet("acme", s2.id);
    expect(moved.state).toBe("failed");
    expect(moved.error).toMatch(/pull request moved/);
    expect(mr).toHaveLength(0);
  });

  it("a registry that already holds the set's version with the same pins is a retry meeting itself: minted, not a second version", async () => {
    const store = new FakeBuildStore();
    const { svc } = setService(store, fakeSession(), {
      // The environment lane is a required dependency; this suite drives the HARNESS lane, so both members
      // refuse — a fixture that omitted them would not compile, which is why they are required.
      environment: {
        get: async () => {
          throw new Error("the harness lane never reads an environment");
        },
        mint: async () => {
          throw new Error("the harness lane never mints an environment");
        },
      },
      repin: async () => {
        throw new ConflictError("CONFLICT", {}, "version exists");
      },
      harness: {
        instance: async (_t, _id, version) =>
          ({
            template: { id: "shop-t", version: "1.0.0" },
            id: "shop",
            version,
            pins: {
              web: "reg.local/ws-acme/shop-web:sha-abc123def456@sha256:beefface",
              api: "reg.local/ws-acme/shop-api:sha-abc123def456@sha256:beefface",
            },
          }) as never,
        template: async () => TOPOLOGY as never,
        resolvedImageOf: async (_t, _id, _v, slot) => `reg/${slot}:1.0.0`,
      },
    });
    const set = await svc.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web", "api"] }, "alice");
    const done = await svc.runSet("acme", set.id);
    expect(done.state, done.error).toBe("minted");
    expect(done.candidateVersion).toBe(set.versionName);
  });

  it("refuses a set of one slot, a repeated slot, and a slot with no recipe — by name, before anything is created", async () => {
    const store = new FakeBuildStore();
    const { svc } = setService(store, fakeSession());
    await expect(
      svc.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web"] }, "alice"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web", "web"] }, "alice"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.startSet("acme", { campaignId: "evc_1", ref: "pr-7", slots: ["web", "db"] }, "alice"),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.sets.size).toBe(0);
  });
});

// ── [COUNTEREXAMPLE] A CAMPAIGN BUILDS THE WORLD (world-and-engagement-model.md, landing order 3) ─────
//
// An environment carries its own image and its own recipe, so evolving the world is a build like any other:
// the same session, the same captured layer, a different subject and a different mint. What this pins is the
// pair that makes it honest — the built image lands on a NEW version of the world (never on the baseline,
// which somebody has already compared against), and an environment with no place to put the output is
// refused before a session is created rather than after one has run.
describe("[COUNTEREXAMPLE] an environment campaign builds the world and mints a new version of it", () => {
  const WORLD = {
    id: "shop",
    version: "1.0.0",
    env: { kind: "repo" as const, source: { path: "/app" } },
    image: "reg/shop:1.0.0",
    source: RECIPE.source,
    build: RECIPE.build,
  };
  function environmentService(store: FakeBuildStore, sessions: BuildSession, world: Record<string, unknown> = WORLD) {
    const mints: Array<{ id: string; version: string; image: string }> = [];
    const svc = service(store, sessions, {
      campaigns: {
        get: async (_t, id) => ({
          id,
          subjectType: "environment",
          subjectId: "shop",
          baselineVersion: "1.0.0",
        }),
      },
      environment: {
        get: async () => world as never,
        mint: async ({ id, version, image }) => {
          mints.push({ id, version, image });
          return { version };
        },
      },
    });
    return { svc, mints };
  }

  it("builds the world's recipe and mints a NEW version carrying the built image", async () => {
    const store = new FakeBuildStore();
    const sessions = fakeSession();
    const { svc, mints } = environmentService(store, sessions);
    const started = await svc.start("acme", { campaignId: "evc_1", ref: "feature" }, "u1");
    expect(started.slot).toBe(ENVIRONMENT_SLOT);
    expect(started.base).toEqual({ version: "1.0.0", image: "reg/shop:1.0.0" });

    const settled = await svc.run("acme", started.id);
    expect(settled.state).toBe("built");
    expect(mints).toEqual([
      {
        id: "shop",
        // Derived from the commit, so a re-driven build of the same source re-mints the same name — and the
        // BASELINE is never overwritten, because a world somebody compared against is not a draft.
        version: "1.0.0-build-abc123def456",
        image: "reg.local/ws-acme/shop-world:sha-abc123def456@sha256:beefface",
      },
    ]);
  });

  it("refuses an environment with no recipe — before a session exists, not after one has run", async () => {
    const store = new FakeBuildStore();
    const sessions = fakeSession();
    const { svc } = environmentService(store, sessions, { id: "shop", version: "1.0.0", env: { kind: "prompt" } });
    await expect(svc.start("acme", { campaignId: "evc_1", ref: "feature" }, "u1")).rejects.toThrow(
      /declares no buildable world/,
    );
    expect(await store.forCampaign("acme", "evc_1")).toHaveLength(0);
  });
});
