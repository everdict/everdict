import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// Personal executions are the member's own (`runAudience`, @everdict/domain): an agent turn is a conversation
// — the session store has always been owner-scoped — and a sandbox session is somebody's shell. These tests pin
// that the RUN ledger and the TRAJECTORY ledger cannot be used as a second door onto the same transcript.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in audience tests");
  },
};

// One authenticator per member — the subject is what the audience rule reads.
const asMember = (subject: string): Authenticator => ({
  async authenticate() {
    return { subject, workspace: "acme", roles: ["admin"], via: "oidc" as const };
  },
});

const bearer = { authorization: "Bearer t" };

async function build(viewer: string) {
  const store = new InMemoryRunStore();
  const trajectoryStore = new InMemoryTrajectoryStore();
  const now = "2026-08-03T00:00:00.000Z";

  // Alice's chat turn + its sealed transcript.
  await store.create(
    Run.newChatTurn({ id: "turn-alice", tenant: "acme", agentId: "default", sessionId: "s1", actor: "alice", now }),
  );
  await trajectoryStore.seal({
    runId: "turn-alice",
    tenant: "acme",
    source: "run",
    owner: "alice",
    events: [{ t: 0, kind: "message", role: "user", text: "my private question" }],
  });
  // Alice's shell session.
  await store.create(
    Run.newSandboxSession({
      id: "shell-alice",
      tenant: "acme",
      harness: { id: "ubuntu", version: "adhoc" },
      image: "ubuntu:24.04",
      ttlSec: 600,
      createdBy: "alice",
      now,
    }),
  );
  // An eval run — the workspace's work, readable by everyone.
  await store.create(
    Run.newQueued({
      id: "eval-1",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      evalCase: { id: "c1", env: { kind: "prompt" }, task: "do it", graders: [], timeoutSec: 60, tags: [] },
      submittedBy: "alice",
      now,
    }),
  );
  await trajectoryStore.seal({
    runId: "eval-1",
    tenant: "acme",
    source: "run",
    events: [{ t: 0, kind: "llm_call", model: "m" }],
  });

  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store, trajectories: trajectoryStore }),
    trajectoryStore,
    requireAuth: true,
    authenticator: asMember(viewer),
  });
  return app;
}

describe("run audience — a member's agent turns and shell sessions are their own", () => {
  it("keeps another member's chat turn and shell session off the runs list, while the workspace's evals stay", async () => {
    const app = await build("bob");
    const ids = (await app.inject({ method: "GET", url: "/runs", headers: bearer }))
      .json()
      .map((r: { id: string }) => r.id);
    expect(ids).toEqual(["eval-1"]);
    await app.close();
  });

  it("shows the owner their own personal executions", async () => {
    const app = await build("alice");
    const ids = (await app.inject({ method: "GET", url: "/runs", headers: bearer }))
      .json()
      .map((r: { id: string }) => r.id);
    expect(ids.sort()).toEqual(["eval-1", "shell-alice", "turn-alice"]);
    await app.close();
  });

  it("answers 404 — not 403 — when another member opens the run, its trajectory, or its logs (no existence leak)", async () => {
    const app = await build("bob");
    for (const url of [
      "/runs/turn-alice",
      "/runs/turn-alice/trajectory",
      "/runs/shell-alice",
      "/runs/shell-alice/logs",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: bearer })).statusCode).toBe(404);
    }
    // The same reader still opens the workspace's eval evidence — the rule narrows nothing else.
    expect((await app.inject({ method: "GET", url: "/runs/eval-1/trajectory", headers: bearer })).statusCode).toBe(200);
    await app.close();
  });

  it("serves the owner their own run and trajectory", async () => {
    const app = await build("alice");
    expect((await app.inject({ method: "GET", url: "/runs/turn-alice", headers: bearer })).statusCode).toBe(200);
    const trajectory = await app.inject({ method: "GET", url: "/runs/turn-alice/trajectory", headers: bearer });
    expect(trajectory.statusCode).toBe(200);
    expect(trajectory.json().events).toHaveLength(1);
    await app.close();
  });

  it("keeps owned evidence out of the trajectory ledger's own browse + detail (the second door)", async () => {
    // The ledger is read by id, not by run — so it has to enforce the rule from the row itself.
    const bob = await build("bob");
    const listed = (await bob.inject({ method: "GET", url: "/trajectories", headers: bearer })).json();
    expect(listed.items.map((m: { runId: string }) => m.runId)).toEqual(["eval-1"]);
    expect((await bob.inject({ method: "GET", url: "/trajectories/turn-alice", headers: bearer })).statusCode).toBe(
      404,
    );
    await bob.close();

    const alice = await build("alice");
    const own = (await alice.inject({ method: "GET", url: "/trajectories", headers: bearer })).json();
    expect(own.items.map((m: { runId: string }) => m.runId).sort()).toEqual(["eval-1", "turn-alice"]);
    expect((await alice.inject({ method: "GET", url: "/trajectories/turn-alice", headers: bearer })).statusCode).toBe(
      200,
    );
    await alice.close();
  });
});
