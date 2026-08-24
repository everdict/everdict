import type { RegistryAuth } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { dockerAuthConfigJson, pickRegistryAuth, registryAuthsForImages } from "./image-ref.js";

// ── TWO CONSUMERS OF ONE LIST, RESOLVING IT IN OPPOSITE DIRECTIONS (arch-review 64 P1-high) ──────────
//
// A managed registry can serve both of a pod's images from different repositories:
//
//     managed.example/acme/task           the case image
//     managed.example/platform/job-runner the runner/init image
//
// Two mint calls produced two REPOSITORY-SCOPED credentials for one HOST, and both were appended to a single
// `RegistryAuth[]`. Then:
//
//     dockerAuthConfigJson   auths[entry.host] = …   → the LAST entry for a host won
//     pickRegistryAuth       auths.find(…)           → the FIRST entry for a host won
//
// A docker config holds exactly one credential per host, so whichever image the surviving token did not cover
// pulled anonymously and 401'd — in a way that reads as a registry problem rather than as ours. Reverse the
// append order and the failure swaps images.
//
// `registryAuthsForImages`' own comment claimed "Deduplicated by host: one entry per registry" and its body
// was a plain filter, which is the comment-is-a-claim law in miniature.
//
// Deduplication makes the two consumers AGREE; it does not make a repository-scoped token cover a repository
// it was not minted for. Only the producer can do that, by minting once over every image the pod pulls — see
// `RuntimeDispatcher`. What this file pins is that the disagreement can no longer be silent.
//
// Seen RED before the fix, observed:
//   the rendered docker config resolved a different credential than every other consumer: expected
//   'task-token' to be 'runner-token'

const TASK: RegistryAuth = { host: "managed.example", username: "everdict", password: "task-token" };
const RUNNER: RegistryAuth = { host: "managed.example", username: "everdict", password: "runner-token" };
const BYO: RegistryAuth = { host: "ghcr.io", username: "everdict", password: "byo-token" };

const IMAGES = ["managed.example/acme/task:1", "managed.example/platform/job-runner:2", "ghcr.io/acme/svc:3"];

const credentialFor = (json: string, host: string): string | undefined => {
  const auths = (JSON.parse(json) as { auths: Record<string, { auth: string }> }).auths;
  const entry = auths[host];
  return entry === undefined ? undefined : Buffer.from(entry.auth, "base64").toString().split(":")[1];
};

describe("[R64 COUNTEREXAMPLE] one host resolves to one credential, the same one everywhere", () => {
  it("renders the SAME credential the rest of the system picks", async () => {
    const list = [TASK, RUNNER, BYO];
    const rendered = credentialFor(dockerAuthConfigJson(list), "managed.example");
    const picked = pickRegistryAuth(list, "managed.example/acme/task:1")?.password;

    expect(picked, "nothing picked a credential, so this file measured nothing").toBeDefined();
    expect(rendered, "the rendered docker config resolved a different credential than every other consumer").toBe(
      picked,
    );
  });

  it("keeps ONE entry per host, whatever the producer handed it", async () => {
    const covering = registryAuthsForImages([TASK, RUNNER, BYO], IMAGES);
    expect(covering.map((a) => a.host).sort()).toEqual(["ghcr.io", "managed.example"]);
    // …and it is the first, which is the rule `pickRegistryAuth` has always had.
    expect(covering.find((a) => a.host === "managed.example")?.password).toBe("task-token");
  });

  it("still carries every DISTINCT host — deduplication is not a filter", async () => {
    // The control. Collapsing to one entry per host must not collapse to one entry: a pod pulling from a
    // managed registry and a BYO one needs both credentials, and losing either is the failure this fixes in
    // the other direction.
    const rendered = JSON.parse(dockerAuthConfigJson(registryAuthsForImages([TASK, RUNNER, BYO], IMAGES))) as {
      auths: Record<string, unknown>;
    };
    expect(Object.keys(rendered.auths).sort()).toEqual(["ghcr.io", "managed.example"]);
  });

  it("covers an image no credential matches by leaving it alone", async () => {
    // Public base images are the ordinary case, and the placement stance is warn-only: a missing credential
    // is not a dispatch error.
    expect(pickRegistryAuth([TASK], "docker.io/library/alpine:3")).toBeUndefined();
    expect(registryAuthsForImages([TASK], ["docker.io/library/alpine:3"])).toEqual([]);
  });
});
