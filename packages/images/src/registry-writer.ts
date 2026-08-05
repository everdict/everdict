import { NotFoundError, UpstreamError } from "@everdict/contracts";
import type { RegistryWriter } from "./layer-append.js";
import type { RegistryAccess } from "./token-issuer.js";

// The write half of the Docker Registry v2 API — blob existence/upload and manifest read/write, which is
// everything `appendLayer` needs to publish "base image + one more layer" without a daemon or a builder.
//
// Separate from `fetchManagedRegistryApi` on purpose. That client is the read surface every browse screen
// uses; this one can PUBLISH, and a caller holding only the reader must not be able to reach it by accident.
// Both mint a token per call scoped to exactly that operation, so a leaked request header is worth one act.
export function fetchRegistryWriter(
  endpoint: string,
  tokenFor: (access: RegistryAccess[]) => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): RegistryWriter {
  const base = endpoint.startsWith("http") ? endpoint.replace(/\/$/, "") : `https://${endpoint}`;

  const call = async (path: string, access: RegistryAccess[], init?: RequestInit): Promise<Response> => {
    const token = await tokenFor(access);
    try {
      return await fetchImpl(path.startsWith("http") ? path : `${base}/v2/${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
      });
    } catch (e) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { endpoint },
        `the image registry is unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  return {
    async headBlob(repository, digest, access) {
      const res = await call(`${repository}/blobs/${digest}`, access, { method: "HEAD" });
      if (res.status === 404) return false;
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status, digest },
          `the image registry rejected a blob check for ${repository}`,
        );
      return true;
    },

    async getBlob(repository, digest, access) {
      const res = await call(`${repository}/blobs/${digest}`, access);
      if (res.status === 404) return undefined;
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status, digest },
          `the image registry refused the blob ${digest} of ${repository}`,
        );
      return Buffer.from(await res.arrayBuffer());
    },

    // Two-step monolithic upload (the v2 spec's simplest form): POST opens a session and answers with the
    // location to write to, PUT?digest= writes the bytes and commits them. The location may be absolute or
    // path-relative, and it carries query parameters the registry needs back — so it is used verbatim rather
    // than reassembled, and the digest is appended with the right separator.
    async putBlob(repository, digest, body, access) {
      const started = await call(`${repository}/blobs/uploads/`, access, { method: "POST" });
      if (started.status !== 202)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: started.status, repository },
          `the image registry refused to start a blob upload for ${repository}`,
        );
      const location = started.headers.get("location");
      if (!location)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { repository },
          "the image registry accepted an upload but returned no location to write to",
        );
      const url = location.startsWith("http") ? location : `${base}${location.startsWith("/") ? "" : "/"}${location}`;
      const put = await call(`${url}${url.includes("?") ? "&" : "?"}digest=${encodeURIComponent(digest)}`, access, {
        method: "PUT",
        body: new Uint8Array(body),
        headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
      });
      if (put.status !== 201)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: put.status, digest, repository },
          `the image registry refused the blob ${digest} for ${repository}`,
        );
    },

    async getManifest(repository, reference, access) {
      const res = await call(`${repository}/manifests/${reference}`, access, {
        headers: {
          accept: [
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
          ].join(", "),
        },
      });
      if (res.status === 404) return undefined;
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status, repository, reference },
          `the image registry refused the manifest of ${repository}:${reference}`,
        );
      const mediaType = res.headers.get("content-type") ?? "application/vnd.oci.image.manifest.v1+json";
      return { body: await res.json(), mediaType };
    },

    async putManifest(repository, reference, body, mediaType, access) {
      const res = await call(`${repository}/manifests/${reference}`, access, {
        method: "PUT",
        body: new Uint8Array(body),
        headers: { "content-type": mediaType },
      });
      if (res.status === 404)
        throw new NotFoundError("NOT_FOUND", { repository }, `the registry has no repository ${repository}`);
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status, repository, reference },
          `the image registry refused the manifest for ${repository}:${reference}`,
        );
      // The registry's own digest is authoritative — it is what a pull by digest will resolve.
      const digest = res.headers.get("docker-content-digest");
      if (!digest)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { repository, reference },
          "the image registry accepted the manifest but returned no content digest",
        );
      return { digest };
    },
  };
}
