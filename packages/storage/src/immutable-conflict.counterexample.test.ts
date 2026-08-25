import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3ArtifactStore } from "./s3.js";

// ── A TAKEN KEY IS NOT THE SAME BYTES (arch-review 67 P1-provenance) ───────────────────────────────
//
// The conditional create (`If-None-Match: *`) was added so an immutable artifact could not be overwritten,
// and its 412 was read as idempotent success outright: "this key is occupied" was accepted as "the same
// object is already there". For an address that encodes its own content that is nearly true; for the
// VERIFIER VERDICT's it is not, and it cannot be — a recovery has no digest to address the verdict by, so
// the key is attempt-scoped and two different verdicts under one attempt share it.
//
// The consequence is the one a restart cannot see: the normal path holds V2 in memory, the object store
// holds V1, every coordinate check passes (same attempt, same plan, same workspace, same agent), and the two
// disagree only on the scores — which is the whole verdict.
//
// So the conflict is VERIFIED. Same bytes is convergence; different bytes is a conflict this adapter refuses
// to pick a winner for; and bytes it could not read back are `unknown`, never convergence (L2).
//
// Seen RED with 412 treated as success, observed:
//   a different document at an immutable key was accepted as convergence: expected [Function] to throw

const OPTS = {
  endpoint: "http://minio:9000",
  bucket: "everdict-artifacts",
  accessKeyId: "everdict",
  secretAccessKey: "secret",
};
const KEY = "verifier-verdict/acme/evd-run-r1/sha256:half/evd-run-r1#g2.json";

const conflict = () => Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } });

// A client whose PUT always conflicts and whose GET returns `existing`.
function clientHolding(existing: Uint8Array | undefined) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) throw conflict();
    if (command instanceof GetObjectCommand) {
      if (existing === undefined) throw new Error("NoSuchKey");
      return { Body: { transformToByteArray: async () => existing } } as never;
    }
    return {} as never;
  });
}

describe("[R67 COUNTEREXAMPLE] an immutable key's conflict is verified, not assumed", () => {
  afterEach(() => vi.restoreAllMocks());

  it("REFUSES when the key already holds different bytes", async () => {
    const incoming = new TextEncoder().encode(JSON.stringify({ scores: [{ metric: "tests_pass", value: 1 }] }));
    const already = new TextEncoder().encode(JSON.stringify({ scores: [{ metric: "tests_pass", value: 0 }] }));
    clientHolding(already);

    await expect(
      new S3ArtifactStore(OPTS).put(KEY, incoming, "application/json", { immutable: true }),
      // Same attempt, same plan, same workspace — and the opposite verdict.
    ).rejects.toThrow(/already holds different bytes/);
  });

  it("CONVERGES when the key holds exactly the same bytes", async () => {
    // The control: an at-least-once write repeating itself is the ordinary case, and this must stay silent.
    const bytes = new TextEncoder().encode(JSON.stringify({ scores: [{ metric: "tests_pass", value: 1 }] }));
    clientHolding(bytes);

    await expect(
      new S3ArtifactStore(OPTS).put(KEY, bytes, "application/json", { immutable: true }),
    ).resolves.toBeTypeOf("string");
  });

  it("REFUSES when the occupied key cannot be read back", async () => {
    // "We could not find out" is not convergence. Claiming it here would let an unreadable object stand in
    // for a verdict nobody has seen.
    //
    // The message is the READ's own — `get` remaps a store fault to an `AppError` before this code sees it,
    // so the refusal arrives as that rather than as the sentence below it. What this pins is that the write
    // does not succeed; which layer phrases the failure is not the invariant.
    const bytes = new TextEncoder().encode(JSON.stringify({ scores: [] }));
    clientHolding(undefined);

    await expect(
      new S3ArtifactStore(OPTS).put(KEY, bytes, "application/json", { immutable: true }),
      "an unreadable object at an occupied key was accepted as convergence",
    ).rejects.toThrow();
  });

  it("does not condition a MUTABLE write at all", async () => {
    // Run media is legitimately re-uploaded (a refreshed snapshot ref, a re-rendered analysis artifact), so
    // the conditional create is opt-in and its absence must not start refusing those.
    const sent: unknown[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      sent.push(command);
      return {} as never;
    });

    await new S3ArtifactStore(OPTS).put(KEY, new Uint8Array([1]), "application/json");
    const put = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand | undefined;
    expect(put?.input.IfNoneMatch, "an ordinary write was made conditional").toBe(undefined);
  });
});
