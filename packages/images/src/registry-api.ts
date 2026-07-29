import type { ImageManifestInfo } from "@everdict/application-control";
import { NotFoundError, UpstreamError } from "@everdict/contracts";
import type { RegistryAccess } from "./token-issuer.js";

// The registry operations the MANAGED store performs as the owner of the namespace: browse the catalog, read
// tags/manifests, delete. Distinct from the `RegistryReader` port, which is the BYO path — there we are a guest
// negotiating a challenge with someone else's credentials, here we mint the exact scoped token and send it as a
// bearer directly (no challenge round-trip, and no dependency on our own token endpoint being reachable).
export interface ManagedRegistryApi {
  // Repository paths in the registry, restricted to a namespace prefix. Distribution's `_catalog` is global, so
  // the prefix filter is ours — never return a path outside the caller's namespace.
  catalog(prefix: string, access: RegistryAccess[]): Promise<string[]>;
  tags(repository: string, access: RegistryAccess[]): Promise<string[]>;
  manifest(repository: string, reference: string, access: RegistryAccess[]): Promise<ImageManifestInfo>;
  // Delete by digest (distribution deletes manifests by digest only). Returns false when it was already gone,
  // so a caller can report "nothing removed" instead of failing a cleanup that had nothing to do.
  deleteManifest(repository: string, digest: string, access: RegistryAccess[]): Promise<boolean>;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface ManifestBody {
  manifests?: Array<{ platform?: { os?: string; architecture?: string } }>;
  layers?: unknown[];
}

// HTTP client over the managed registry. `tokenFor` mints the bearer for exactly the access of the call being
// made — one token per request, scoped to that repository, so a leaked request header is worth one operation.
export function fetchManagedRegistryApi(
  endpoint: string,
  tokenFor: (access: RegistryAccess[]) => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): ManagedRegistryApi {
  const base = endpoint.startsWith("http") ? endpoint.replace(/\/$/, "") : `https://${endpoint}`;

  const call = async (path: string, access: RegistryAccess[], init?: RequestInit): Promise<Response> => {
    const token = await tokenFor(access);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/v2/${path}`, {
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
    return res;
  };

  const readJson = async (res: Response, what: string): Promise<unknown> => {
    if (res.status === 404) throw new NotFoundError("NOT_FOUND", { status: 404 }, `${what} is not in the registry`);
    if (!res.ok)
      throw new UpstreamError("UPSTREAM_ERROR", { status: res.status }, `the image registry rejected ${what}`);
    return res.json();
  };

  return {
    async catalog(prefix, access) {
      const res = await call("_catalog?n=1000", access);
      const body = (await readJson(res, "the repository catalog")) as { repositories?: string[] };
      return (body.repositories ?? []).filter((r) => r === prefix || r.startsWith(`${prefix}/`));
    },

    async tags(repository, access) {
      const res = await call(`${repository}/tags/list`, access);
      // A repository that exists with no tags answers 404 in some registries — an empty tag list is the honest
      // answer for the caller (the repository is there, nothing is tagged), not a missing-repository error.
      if (res.status === 404) return [];
      const body = (await readJson(res, `tags of ${repository}`)) as { tags?: string[] | null };
      return body.tags ?? [];
    },

    async manifest(repository, reference, access) {
      const res = await call(`${repository}/manifests/${reference}`, access, {
        headers: { accept: MANIFEST_ACCEPT },
      });
      const body = (await readJson(res, `${repository}:${reference}`)) as ManifestBody;
      const digest = res.headers.get("docker-content-digest") ?? undefined;
      const mediaType = res.headers.get("content-type") ?? undefined;
      const platforms = body.manifests
        ?.map((m) => (m.platform?.os && m.platform.architecture ? `${m.platform.os}/${m.platform.architecture}` : ""))
        .filter((p) => p.length > 0);
      return {
        reference,
        ...(digest ? { digest } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(platforms && platforms.length > 0 ? { platforms } : {}),
        ...(body.layers ? { layerCount: body.layers.length } : {}),
      };
    },

    async deleteManifest(repository, digest, access) {
      const res = await call(`${repository}/manifests/${digest}`, access, { method: "DELETE" });
      if (res.status === 404) return false;
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { status: res.status },
          `the image registry refused to delete ${repository}@${digest}${
            res.status === 405 ? " — the registry has deletion disabled (REGISTRY_STORAGE_DELETE_ENABLED)" : ""
          }`,
        );
      return true;
    },
  };
}
