import { RunService } from "@everdict/application-control";
import type { Authenticator } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../server.js";

// POST /runs/:id/cancel — the transport over RunService.cancel. The protocol itself is pinned in
// core/run/run-cancel.test.ts; these pin the surface: the gate, and which failure becomes which status.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in cancel route tests");
  },
};

const bearer = { authorization: "Bearer t" };
const now = "2026-08-16T00:00:00.000Z";

const asMember = (subject: string, roles: string[] = ["admin"]): Authenticator => ({
  async authenticate() {
    return { subject, workspace: "acme", roles, via: "oidc" as const };
  },
});

async function build(opts: { viewer?: string; roles?: string[] } = {}) {
  const store = new InMemoryRunStore();
  const seed = (id: string, status: "queued" | "running" | "succeeded") => ({
    ...Run.newQueued({
      id,
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      evalCase: { id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      runtime: "nomad-1",
      submittedBy: "alice",
      now,
    }),
    status,
  });
  await store.create(seed("live-1", "running"));
  await store.create(seed("done-1", "succeeded"));
  const killCase = vi.fn(async () => ({ status: "stopped" as const }));
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store, killCase, now: () => now }),
    requireAuth: true,
    authenticator: asMember(opts.viewer ?? "alice", opts.roles),
  });
  return { app, killCase };
}

describe("POST /runs/:id/cancel", () => {
  it("stops a running run: 200 with the cancelled record, and the compute is freed", async () => {
    const { app, killCase } = await build();
    const res = await app.inject({ method: "POST", url: "/runs/live-1/cancel", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "live-1", status: "failed", error: { code: "CANCELLED" } });
    expect(killCase).toHaveBeenCalledWith("acme", "nomad-1", "c1");
    await app.close();
  });

  it("409 on a run that already finished, 404 on a missing one", async () => {
    const { app } = await build();
    expect((await app.inject({ method: "POST", url: "/runs/done-1/cancel", headers: bearer })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/runs/nope/cancel", headers: bearer })).statusCode).toBe(404);
    await app.close();
  });

  it("403 without runs:submit — stopping work is a mutation, gated exactly like starting it", async () => {
    const { app } = await build({ roles: ["viewer"] });
    expect((await app.inject({ method: "POST", url: "/runs/live-1/cancel", headers: bearer })).statusCode).toBe(403);
    await app.close();
  });
});
