import { OffloadingTrajectoryStore, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// ── [R120 COUNTEREXAMPLE] THE EVIDENCE A VERDICT USED IS READABLE BY THE PERSON IT IS SOLD TO ───────
//
// An oversized payload is MOVED to object storage: the event keeps a bounded preview plus an `artifact://`
// ref. Internal scoring resolves it (`collectExactTrajectoryEvents`). No transport could:
//
//   · neither `GET /trajectories/:id` nor the MCP `get_trajectory` forwarded `resolve`;
//   · `publicUrlFor` is only ever called for snapshot media (screenshotRef / domRef), so no route
//     dereferences a trajectory payload ref either.
//
// So a member auditing what a judge actually read saw a 32 KB excerpt and a ref string that resolved to
// nothing, for exactly the payloads big enough to matter. Everdict's deliverable is a defensible verdict;
// "show me the evidence" has to be answerable through the API, and retention now DELETES those bytes on a
// schedule, so the window in which they can be read is finite.
//
// Authorization is deliberately unchanged — `runs:read` plus the same `trajectoryReadableBy` check the
// bounded read already passes. Resolving reveals nothing the preview was withholding for authz reasons; it
// withholds for SIZE.
//
// Seen RED before the fix: "the sealed payload is unreachable through the API: expected '<32000 chars>' to
// be '<200029 chars>'" — the route answered the preview no matter what was asked.

const BIG = "x".repeat(200_000);
const DECISIVE = "__THE_ANSWER_IS_IN_THE_TAIL__";
const H = { "x-everdict-tenant": "acme" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in trajectory tests");
  },
};

function artifacts() {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()],
    async put(key: string, data: Uint8Array) {
      objects.set(key, data);
      return `https://example.invalid/${key}`;
    },
    async get(key: string) {
      return objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
    async remove(key: string) {
      objects.delete(key);
    },
  };
}

async function build() {
  const objects = artifacts();
  // The PRODUCTION composition: the offloading decorator over the raw store, handed to the server.
  const trajectoryStore = new OffloadingTrajectoryStore(new InMemoryTrajectoryStore(), objects);
  await trajectoryStore.seal({
    runId: "r1",
    tenant: "acme",
    source: "run",
    events: [{ t: 0, kind: "tool_result", id: "c1", ok: true, output: `${BIG}${DECISIVE}` }],
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    trajectoryStore,
  });
  return { app, objects };
}

describe("[R120 COUNTEREXAMPLE] GET /trajectories/:id?resolve=true answers the sealed payload", () => {
  it("returns the whole moved payload, not the excerpt", async () => {
    const { app, objects } = await build();
    // The premise: something really was offloaded. Otherwise both reads agree and this proves nothing.
    expect(objects.keys(), "nothing was offloaded, so there is no preview to be fooled by").toHaveLength(1);

    const bounded = await app.inject({ method: "GET", url: "/trajectories/r1", headers: H });
    expect(bounded.statusCode).toBe(200);
    const preview = bounded.json().events[0].output as string;
    expect(preview.includes(DECISIVE), "the default read was not bounded — the offload did nothing").toBe(false);
    expect(bounded.json().events[0].outputRef, "no ref was sealed beside the preview").toEqual(expect.any(String));

    const resolved = await app.inject({ method: "GET", url: "/trajectories/r1?resolve=true", headers: H });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().events[0].output, "the sealed payload is unreachable through the API").toBe(
      `${BIG}${DECISIVE}`,
    );
  });

  it("still refuses another workspace's trajectory — resolving is not a way around the read check", async () => {
    const { app } = await build();
    const foreign = await app.inject({
      method: "GET",
      url: "/trajectories/r1?resolve=true",
      headers: { "x-everdict-tenant": "rival" },
    });
    expect(foreign.statusCode, "resolve widened who may read a trajectory").toBe(404);
  });
});
