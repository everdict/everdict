import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type RegistryWriter, appendLayer, sha256Of } from "./layer-append.js";
import type { RegistryAccess } from "./token-issuer.js";

const ACCESS: RegistryAccess[] = [{ type: "repository", name: "ws/world", actions: ["pull", "push"] }];

// A registry that remembers what was written — enough to assert the ORDER and the digests, which is where
// an image that "pushes fine and then fails to unpack" is actually born.
function fakeRegistry(
  base: { config: object; layers: Array<{ digest: string; size: number }>; mediaType?: string } = {
    config: { rootfs: { type: "layers", diff_ids: ["sha256:aaa"] }, history: [{ created_by: "FROM debian" }] },
    layers: [{ digest: "sha256:base-layer", size: 10 }],
  },
) {
  const blobs = new Map<string, Buffer>();
  const configDigest = "sha256:base-config";
  blobs.set(configDigest, Buffer.from(JSON.stringify(base.config)));
  const order: string[] = [];
  let putManifestBody: Buffer | undefined;
  const writer: RegistryWriter = {
    async headBlob(_repo, digest) {
      order.push(`head:${digest}`);
      return blobs.has(digest);
    },
    async getBlob(_repo, digest) {
      return blobs.get(digest);
    },
    async putBlob(_repo, digest, body) {
      order.push(`putBlob:${digest}`);
      blobs.set(digest, body);
    },
    async getManifest() {
      order.push("getManifest");
      return {
        body: {
          schemaVersion: 2,
          config: { mediaType: "x", digest: configDigest, size: 1 },
          layers: base.layers.map((l) => ({ mediaType: "l", ...l })),
        },
        mediaType: base.mediaType ?? "application/vnd.oci.image.manifest.v1+json",
      };
    },
    async putManifest(_repo, _ref, body) {
      order.push("putManifest");
      putManifestBody = body;
      return { digest: "sha256:published" };
    },
  };
  return { writer, blobs, order, manifest: () => JSON.parse(String(putManifestBody)) };
}

describe("appendLayer — publishing base+1 layer with nothing but the registry API", () => {
  const payload = gzipSync(Buffer.from("the session's filesystem"));

  it("references the COMPRESSED digest in the manifest and the UNCOMPRESSED one in the config", async () => {
    const reg = fakeRegistry();
    const result = await appendLayer(
      reg.writer,
      { repository: "ws/world", baseReference: "v1", tag: "v2", layerGzip: payload, created: "2026-08-06T00:00:00Z" },
      ACCESS,
    );

    const manifest = reg.manifest();
    const layer = manifest.layers.at(-1);
    expect(layer.digest).toBe(sha256Of(payload)); // manifest: the blob as stored
    expect(result.layerDigest).toBe(layer.digest);

    const config = JSON.parse(String(reg.blobs.get(manifest.config.digest)));
    // config rootfs: the UNCOMPRESSED digest. Conflating the two publishes an image that pulls and then
    // fails to unpack — the reason both are computed here rather than passed in.
    expect(config.rootfs.diff_ids).toEqual(["sha256:aaa", sha256Of(Buffer.from("the session's filesystem"))]);
    expect(config.rootfs.diff_ids.at(-1)).not.toBe(layer.digest);
    expect(config.history.at(-1)).toMatchObject({ created_by: "everdict snapshot" });
    expect(manifest.layers[0]).toMatchObject({ digest: "sha256:base-layer" }); // the base's layers are kept, in order
    expect(result.digest).toBe("sha256:published"); // the REGISTRY's digest is what a spec pins
  });

  it("uploads the layer BEFORE the manifest that references it, and skips a blob the registry already has", async () => {
    const reg = fakeRegistry();
    await appendLayer(
      reg.writer,
      { repository: "ws/world", baseReference: "v1", tag: "v2", layerGzip: payload },
      ACCESS,
    );
    const layerPut = reg.order.indexOf(`putBlob:${sha256Of(payload)}`);
    expect(layerPut).toBeGreaterThan(-1);
    expect(layerPut).toBeLessThan(reg.order.indexOf("putManifest")); // a manifest naming a missing blob is refused

    // Re-snapshotting an unchanged tree produces the identical layer — it is not re-uploaded.
    const again = fakeRegistry();
    again.blobs.set(sha256Of(payload), payload);
    await appendLayer(
      again.writer,
      { repository: "ws/world", baseReference: "v1", tag: "v3", layerGzip: payload },
      ACCESS,
    );
    expect(again.order).not.toContain(`putBlob:${sha256Of(payload)}`);
  });

  it("keeps the base's manifest FLAVOUR (docker v2 vs OCI) so the published image speaks one dialect", async () => {
    const reg = fakeRegistry({
      config: { rootfs: { type: "layers", diff_ids: [] } },
      layers: [],
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    await appendLayer(
      reg.writer,
      { repository: "ws/world", baseReference: "v1", tag: "v2", layerGzip: payload },
      ACCESS,
    );
    const manifest = reg.manifest();
    expect(manifest.mediaType).toBe("application/vnd.docker.distribution.manifest.v2+json");
    expect(manifest.layers[0].mediaType).toBe("application/vnd.docker.image.rootfs.diff.tar.gzip");
    expect(manifest.config.mediaType).toBe("application/vnd.docker.container.image.v1+json");
  });

  it("refuses a multi-platform base rather than silently snapshotting one of its architectures", async () => {
    const reg = fakeRegistry();
    const indexWriter: RegistryWriter = {
      ...reg.writer,
      async getManifest() {
        return { body: { schemaVersion: 2, manifests: [{ digest: "sha256:child" }] }, mediaType: "index" };
      },
    };
    await expect(
      appendLayer(indexWriter, { repository: "ws/world", baseReference: "v1", tag: "v2", layerGzip: payload }, ACCESS),
    ).rejects.toThrow(/multi-platform|index/i);
  });

  it("says which base it could not read, and refuses a capture that is not a gzip stream", async () => {
    const missing: RegistryWriter = {
      ...fakeRegistry().writer,
      async getManifest() {
        return undefined;
      },
    };
    await expect(
      appendLayer(missing, { repository: "ws/world", baseReference: "v9", tag: "v2", layerGzip: payload }, ACCESS),
    ).rejects.toThrow(/ws\/world:v9/);

    const reg = fakeRegistry();
    await expect(
      appendLayer(
        reg.writer,
        { repository: "ws/world", baseReference: "v1", tag: "v2", layerGzip: Buffer.from("not gzip") },
        ACCESS,
      ),
    ).rejects.toThrow(/gzip/i);
  });
});
