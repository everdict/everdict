import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// ── DEFAUL-54: A DEPLOYMENT SAYS WHAT IT IS BUILT FROM ───────────────────────────────────────────────
//
// Measured 2026-09-18: four merged, gated, pushed fixes were invisible to a session, and drift was found
// only by a defect REAPPEARING — which reads as "the fix did not work". Two findings were nearly re-opened
// on that basis. This route is the half only the deployment can state.
//
// ⚠️ THE ASSERTION THAT MATTERS IS THE NULL ONE. An image built without the stamp must answer `commit: null`
// — never the image tag (a hand-set string in a gitignored `.env` that names whatever somebody last typed),
// and never a placeholder like "unknown" (which a caller comparing against a sha reads as a mismatch that
// means nothing). "I do not know what I am built from" is a real answer and the only honest one.
//
// Seen RED with the route defaulting to `?? "unknown"`: "expected 'unknown' to be null".

// This slice runs no jobs; the service is here only because buildServer requires one.
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in deployment-identity tests");
  },
};

const ENV = "EVERDICT_BUILD_COMMIT";
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

const read = async (value: string | undefined) => {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  // Built AFTER the env is set: the value is read once at registration, because it cannot change while the
  // process lives and re-reading it per request would invite somebody to think it could.
  const app = buildServer({ service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }) });
  const res = await app.inject({ method: "GET", url: "/deployment" });
  await app.close();
  return { status: res.statusCode, body: res.json() as { commit: string | null; startedAt: string } };
};

describe("GET /deployment", () => {
  it("reports the commit the image was built from", async () => {
    const { status, body } = await read("18af0b4678bde806c41d409dcca5611e312ba23e");
    expect(status).toBe(200);
    expect(body.commit).toBe("18af0b4678bde806c41d409dcca5611e312ba23e");
    expect(Date.parse(body.startedAt)).not.toBeNaN();
  });

  it("answers `null` when the image carries no stamp — not a tag, not a placeholder", async () => {
    expect((await read(undefined)).body.commit).toBeNull();
  });

  // An env var set to the empty string is how a compose `${EVERDICT_BUILD_COMMIT:-}` arrives when nobody
  // passed one — the commonest way this will actually be unstamped, and `""` is not a commit.
  it('treats an empty or blank stamp as no stamp, because `""` is not a commit', async () => {
    expect((await read("")).body.commit).toBeNull();
    expect((await read("   ")).body.commit).toBeNull();
  });

  // Unauthenticated on purpose: a caller that cannot yet tell whether the contract it is about to use is
  // current must not need a credential to find out, and the answer is already public in the repository.
  it("needs no credential — the whole point is to be askable before you trust anything", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "GET", url: "/deployment" }); // no auth headers at all
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});
