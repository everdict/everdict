import type { CampaignBuildRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CampaignBuildStore } from "../ports/evolution-campaign-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { type BuildSession, type CampaignBuildDeps, CampaignBuildService } from "./campaign-build-service.js";

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
        teamId: "team-a",
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
    repin: async ({ slot, imageRef }) => {
      minted += 1;
      // The re-pin is the door — assert it got the built ref pinned into the slot.
      expect(imageRef).toBe("reg.local/ws-acme/scaffold-image:sha-abc123def456@sha256:beefface");
      expect(slot).toBe("image");
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
      /only a harness campaign/,
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
