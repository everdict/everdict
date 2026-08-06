import { describe, expect, it } from "vitest";
import { type ImageSource, copyImage } from "./copy-image.js";
import { parseImageLocation } from "./image-source.js";
import type { RegistryWriter } from "./layer-append.js";
import type { RegistryAccess } from "./token-issuer.js";

const ACCESS: RegistryAccess[] = [{ type: "repository", name: "ws/world", actions: ["pull", "push"] }];

function fakeSource(manifests: Record<string, { body: unknown; mediaType: string }>, blobs: Record<string, string>) {
  const asked: string[] = [];
  const source: ImageSource = {
    async manifest(reference) {
      asked.push(reference);
      return manifests[reference];
    },
    async blob(digest) {
      const body = blobs[digest];
      return body === undefined ? undefined : Buffer.from(body);
    },
  };
  return { source, asked };
}

function fakeTarget(existing: string[] = []) {
  const held = new Set(existing);
  const order: string[] = [];
  let manifestBody: Buffer | undefined;
  const writer: RegistryWriter = {
    async headBlob(_r, digest) {
      return held.has(digest);
    },
    async getBlob() {
      return undefined;
    },
    async putBlob(_r, digest, body) {
      order.push(`blob:${digest}`);
      held.add(digest);
      expect(body.length).toBeGreaterThan(0);
    },
    async getManifest() {
      return undefined;
    },
    async putManifest(_r, _ref, body) {
      order.push("manifest");
      manifestBody = body;
      return { digest: "sha256:copied" };
    },
  };
  return { writer, order, manifest: () => JSON.parse(String(manifestBody)) };
}

describe("copyImage — bringing a base into the workspace's namespace so a world can be founded", () => {
  const single = {
    "stable-slim": {
      body: {
        schemaVersion: 2,
        config: { mediaType: "c", digest: "sha256:cfg", size: 3 },
        layers: [{ mediaType: "l", digest: "sha256:l1", size: 4 }],
      },
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    },
  };

  it("copies config + layers BEFORE the manifest that names them, and skips what the target already has", async () => {
    const src = fakeSource(single, { "sha256:cfg": "config", "sha256:l1": "layer" });
    const dst = fakeTarget();
    const result = await copyImage(
      src.source,
      dst.writer,
      {
        repository: "ws/world",
        reference: "stable-slim",
        tag: "base-v1",
      },
      ACCESS,
    );
    expect(result).toMatchObject({ digest: "sha256:copied", layers: 1, copiedBlobs: 2 });
    expect(dst.order).toEqual(["blob:sha256:cfg", "blob:sha256:l1", "manifest"]);
    expect(dst.manifest().layers).toEqual([{ mediaType: "l", digest: "sha256:l1", size: 4 }]);

    // A second world founded on the same base re-uploads nothing.
    const again = fakeTarget(["sha256:cfg", "sha256:l1"]);
    const second = await copyImage(
      fakeSource(single, {}).source,
      again.writer,
      {
        repository: "ws/world",
        reference: "stable-slim",
        tag: "base-v1",
      },
      ACCESS,
    );
    expect(second.copiedBlobs).toBe(0);
    expect(again.order).toEqual(["manifest"]);
  });

  it("resolves a multi-platform index to its runnable linux/amd64 child", async () => {
    const src = fakeSource(
      {
        latest: {
          body: {
            schemaVersion: 2,
            manifests: [
              { digest: "sha256:attest", platform: { os: "unknown", architecture: "unknown" } },
              { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
              { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
            ],
          },
          mediaType: "application/vnd.oci.image.index.v1+json",
        },
        "sha256:amd": single["stable-slim"],
      },
      { "sha256:cfg": "config", "sha256:l1": "layer" },
    );
    const dst = fakeTarget();
    await copyImage(src.source, dst.writer, { repository: "ws/world", reference: "latest", tag: "base-v1" }, ACCESS);
    expect(src.asked).toEqual(["latest", "sha256:amd"]); // never the attestation manifest
  });

  it("names the base it could not read rather than failing anonymously", async () => {
    const dst = fakeTarget();
    await expect(
      copyImage(
        fakeSource({}, {}).source,
        dst.writer,
        {
          repository: "ws/world",
          reference: "ghost",
          tag: "base-v1",
        },
        ACCESS,
      ),
    ).rejects.toThrow(/ghost/);
  });
});

describe("parseImageLocation — a reference as its own registry addresses it", () => {
  it("sends a bare name to Docker Hub's library namespace, and a host-qualified one to that host", () => {
    expect(parseImageLocation("debian:stable-slim")).toEqual({
      base: "https://registry-1.docker.io",
      repository: "library/debian",
      reference: "stable-slim",
    });
    expect(parseImageLocation("acme/app")).toMatchObject({ repository: "acme/app", reference: "latest" });
    expect(parseImageLocation("ghcr.io/acme/app:1.2")).toEqual({
      base: "https://ghcr.io",
      repository: "acme/app",
      reference: "1.2",
    });
  });

  it("prefers a digest over the tag beside it, and treats a local registry as plain HTTP", () => {
    expect(parseImageLocation("localhost:5001/ws/world:v3@sha256:abc")).toEqual({
      base: "http://localhost:5001",
      repository: "ws/world",
      reference: "sha256:abc",
    });
  });
});
