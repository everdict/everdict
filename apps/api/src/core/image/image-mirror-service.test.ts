import { describe, expect, it } from "vitest";
import { ImageMirrorService } from "./image-mirror-service.js";

// The registry side is exercised by @everdict/images (copyImage/appendLayer); these tests pin what the SERVICE
// decides — which namespace the bytes land in, what the repository and tag are called, and which credential a
// source is allowed to see.
function svc(over: Partial<ConstructorParameters<typeof ImageMirrorService>[0]> = {}) {
  const puts: Array<{ repository: string; digest: string }> = [];
  const manifests: Array<{ repository: string; reference: string }> = [];
  const writer = {
    async headBlob() {
      return false;
    },
    async getBlob() {
      return undefined;
    },
    async putBlob(repository: string, digest: string) {
      puts.push({ repository, digest });
    },
    async getManifest() {
      return undefined;
    },
    async putManifest(repository: string, reference: string) {
      manifests.push({ repository, reference });
      return { digest: "sha256:mirrored" };
    },
  };
  const service = new ImageMirrorService({
    endpoint: "reg.local:5000",
    namespaceFor: (tenant) => `${tenant}-ns`,
    writer,
    ...over,
  });
  return { service, puts, manifests };
}

// A source that answers a single-platform manifest, recording the auth it was handed.
function stubSource(seen: Array<{ image: string; auth: unknown }>) {
  return (image: string, auth?: unknown) => {
    seen.push({ image, auth });
    return {
      async manifest() {
        return {
          body: {
            schemaVersion: 2,
            config: { mediaType: "c", digest: "sha256:cfg", size: 1 },
            layers: [{ mediaType: "l", digest: "sha256:l1", size: 2 }],
          },
          mediaType: "application/vnd.oci.image.manifest.v1+json",
        };
      },
      async blob() {
        return Buffer.from("bytes");
      },
    };
  };
}

describe("ImageMirrorService — bringing an image into the registry everdict manages", () => {
  it("lands a workspace mirror in THAT workspace's namespace, named and tagged after the source", async () => {
    const seen: Array<{ image: string; auth: unknown }> = [];
    const { service, manifests } = svc({ sourceFor: stubSource(seen) });
    const result = await service.mirrorForWorkspace("acme", { image: "ghcr.io/acme/app:1.2" });
    expect(result.repository).toBe("acme-ns/app"); // the source's last segment, inside the tenant's namespace
    expect(result.tag).toBe("1.2");
    // Digest-pinned: a mirror exists to stop depending on a moving reference.
    expect(result.image).toBe("reg.local:5000/acme-ns/app:1.2@sha256:mirrored");
    expect(manifests).toEqual([{ repository: "acme-ns/app", reference: "1.2" }]);
  });

  it("lands a PLATFORM mirror in the platform namespace — never a tenant's", async () => {
    const { service } = svc({ sourceFor: stubSource([]) });
    const result = await service.mirrorForPlatform({ image: "ghcr.io/everdict/everdict-job-runner:2.0.0" });
    expect(result.repository).toBe("everdict-platform/everdict-job-runner");
    expect(result.image.startsWith("reg.local:5000/everdict-platform/")).toBe(true);
  });

  it("offers a credential ONLY to the source's own host — a mirror is not a way to leak one", async () => {
    const seen: Array<{ image: string; auth: unknown }> = [];
    const { service } = svc({
      sourceFor: stubSource(seen),
      pullAuthsFor: async () => [
        { host: "other.example", password: "not-yours" },
        { host: "ghcr.io", username: "u", password: "right-one" },
      ],
    });
    await service.mirrorForWorkspace("acme", { image: "ghcr.io/acme/app:1.2" });
    // The service picks by host; the assertion that matters is that a non-matching credential is never chosen.
    expect(seen.every((s) => (s.auth as { password?: string } | undefined)?.password !== "not-yours")).toBe(true);
  });

  it("refuses a repository name or tag the registry cannot hold, naming what to pass instead", async () => {
    const { service } = svc({ sourceFor: stubSource([]) });
    await expect(service.mirrorForWorkspace("acme", { image: "ghcr.io/acme/App:1" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.mirrorForWorkspace("acme", { image: "ghcr.io/acme/app:1", tag: "no spaces" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
