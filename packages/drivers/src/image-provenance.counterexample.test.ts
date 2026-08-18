import { NO_IMAGE } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type DockerRead, resolveDockerImageProvenance } from "./docker.js";
import { LocalDriver } from "./local.js";

// ── THE WORLD A CASE RAN IN IS READ BACK, NOT COPIED FROM THE REQUEST ────────────────────────────────
//
// `EvalCase.image` is what the case ASKED for. `repo:latest` names different bytes on Tuesday and
// Thursday, and the execution manifest used to record that request verbatim — so a release gate could
// compare two batches, find every sealed axis identical, and issue a green light over two different
// images. The provisioner is the only party that knows which bytes it launched, so the provisioner
// records them (rule `protocol` L3).
//
// RED as of 760098e6: before this change `ComputeHandle` had no `image` member at all, so the claim is a
// CONTRACT claim and its proof lands with it (verification.md: "Type claim → schedule it"). The runtime
// half is proven by neutralizing the read — with the resolver returning `NO_IMAGE`, all five arms fail:
//   AssertionError: expected { kind: 'none' } to deeply equal { Object (kind, by, ...) }
// which is the defect verbatim: a world that ran an image reporting that it ran none.
//
// The three states are deliberately not two. A lane that provisioned NO image and a lane whose image
// nobody could identify are opposite claims about how much we know, and one optional field answered both
// with the same silence (case-law R55.9).

const reads = (answers: Record<string, string>, log?: string[][]): DockerRead => {
  return async (args) => {
    log?.push(args);
    for (const [needle, out] of Object.entries(answers)) if (args.join(" ").includes(needle)) return out;
    throw new Error(`unexpected docker read: ${args.join(" ")}`);
  };
};

describe("resolveDockerImageProvenance — which bytes the container actually holds", () => {
  it("reports the digest a mutable tag resolved to, not the tag the case asked for", async () => {
    // Given: a container launched from `acme/agent:latest`, whose image carries a registry digest
    const read = reads({
      "inspect c1 --format {{.Image}}": "sha256:localcontentid\n",
      "image inspect": '["acme/agent@sha256:aaaa"]\n',
    });
    // When: the provenance is resolved from the CONTAINER
    const p = await resolveDockerImageProvenance("acme/agent:latest", "c1", read);
    // Then: the bytes are named, and the requested reference survives so a human still reads a version
    expect(p).toEqual({
      kind: "resolved",
      by: "driver",
      images: [{ ref: "acme/agent:latest", digest: "sha256:aaaa" }],
    });
  });

  it("prefers the RepoDigests entry for the repository that was asked for", async () => {
    // A mirrored image is known by several repositories; reporting another one's digest would name the
    // bytes correctly and the provenance wrongly.
    const read = reads({
      "{{.Image}}": "sha256:cid\n",
      "image inspect": '["mirror.internal/agent@sha256:bbbb","acme/agent@sha256:aaaa"]\n',
    });
    const p = await resolveDockerImageProvenance("acme/agent:latest", "c1", read);
    expect(p).toMatchObject({ kind: "resolved", images: [{ digest: "sha256:aaaa" }] });
  });

  it("says a locally built image has NO registry digest — an answer, not a failure", async () => {
    // Given: the read HAPPENED and the image was never pushed anywhere
    const read = reads({ "{{.Image}}": "sha256:cid\n", "image inspect": "[]\n" });
    const p = await resolveDockerImageProvenance("locally-built:dev", "c1", read);
    // Then: `no_registry_digest` — nothing is wrong, there is simply nothing to name to another reader
    expect(p).toMatchObject({ kind: "unresolved", reason: "no_registry_digest" });
  });

  it("says a read that FAILED did not happen — a daemon fault is not a claim about the image", async () => {
    // The `unknown`/`absent` split (rule `protocol` L2): collapsing these would turn a daemon hiccup into
    // "this image has no digest", which is a statement about the image nobody is entitled to make.
    const read: DockerRead = async () => {
      throw new Error("Cannot connect to the Docker daemon");
    };
    const p = await resolveDockerImageProvenance("acme/agent:latest", "c1", read);
    expect(p).toMatchObject({ kind: "unresolved", reason: "inspect_failed" });
    if (p.kind === "unresolved") expect(p.detail).toContain("Cannot connect to the Docker daemon");
  });

  it("asks the daemon NOTHING when the request already pinned a digest", async () => {
    // The fast path AND the user's escape from a lane that cannot report: pin the digest and the world is
    // identified with no cluster read at all.
    const calls: string[][] = [];
    const p = await resolveDockerImageProvenance("acme/agent:1.2@sha256:cccc", "c1", reads({}, calls));
    expect(p).toEqual({
      kind: "resolved",
      by: "ref",
      images: [{ ref: "acme/agent:1.2@sha256:cccc", digest: "sha256:cccc" }],
    });
    expect(calls).toHaveLength(0); // cardinality, not "toBeDefined" — the read must not have happened
  });
});

describe("LocalDriver — a host process comes out of no image", () => {
  it("answers `none` positively rather than staying silent", async () => {
    // Given: the driver for code already inside a sandbox — When provisioned, Then the handle CLAIMS that
    // it ran no image. Two runs that both provisioned nothing ran in the SAME world; two runs whose images
    // nobody could identify did not, and the gate must be able to tell those apart.
    const compute = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });
    try {
      expect(compute.image).toEqual(NO_IMAGE);
    } finally {
      await compute.dispose();
    }
  });
});
