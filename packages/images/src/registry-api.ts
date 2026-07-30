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
  // `manifest` plus the OCI config blob: build history, runtime config, size, created/os/arch. Separate from
  // `manifest` because the enrichment costs up to two more registry round-trips per call — digest resolution
  // paths (delete, pinning) stay on the cheap summary. Enrichment is best-effort: a config blob that cannot be
  // read degrades to the summary rather than failing an inspect whose manifest answered fine.
  inspect(repository: string, reference: string, access: RegistryAccess[]): Promise<ImageManifestInfo>;
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
  manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }>;
  layers?: Array<{ size?: number }>;
  config?: { digest?: string };
}

// The OCI image config blob — the part of the image that says how it was BUILT (history) and how it RUNS
// (config). Field names are the spec's own (Env/Cmd/Entrypoint…), mapped to our contract shape below.
interface ImageConfigBlob {
  created?: string;
  os?: string;
  architecture?: string;
  history?: Array<{ created?: string; created_by?: string; empty_layer?: boolean; comment?: string }>;
  config?: {
    Env?: string[];
    Cmd?: string[];
    Entrypoint?: string[];
    WorkingDir?: string;
    User?: string;
    ExposedPorts?: Record<string, unknown>;
    Labels?: Record<string, string>;
  };
}

// An index's runnable child to resolve the config through — linux/amd64 when present (the fleet's default),
// otherwise the first entry with a REAL platform. Buildx attestation manifests advertise "unknown/unknown" and
// carry no image config, so they are never picked and never listed as platforms.
function pickRunnable(manifests: NonNullable<ManifestBody["manifests"]>): { digest?: string } | undefined {
  const runnable = manifests.filter(
    (m) => m.platform?.os && m.platform.os !== "unknown" && m.platform.architecture !== "unknown",
  );
  return runnable.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64") ?? runnable[0];
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

  const readManifest = async (
    repository: string,
    reference: string,
    access: RegistryAccess[],
  ): Promise<{ info: ImageManifestInfo; body: ManifestBody }> => {
    const res = await call(`${repository}/manifests/${reference}`, access, {
      headers: { accept: MANIFEST_ACCEPT },
    });
    const body = (await readJson(res, `${repository}:${reference}`)) as ManifestBody;
    const digest = res.headers.get("docker-content-digest") ?? undefined;
    const mediaType = res.headers.get("content-type") ?? undefined;
    // Buildx attestation entries advertise "unknown/unknown" — not a platform anyone can run, so not listed.
    const platforms = body.manifests
      ?.map((m) => (m.platform?.os && m.platform.architecture ? `${m.platform.os}/${m.platform.architecture}` : ""))
      .filter((p) => p.length > 0 && p !== "unknown/unknown");
    const info: ImageManifestInfo = {
      reference,
      ...(digest ? { digest } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(platforms && platforms.length > 0 ? { platforms } : {}),
      ...(body.layers ? { layerCount: body.layers.length } : {}),
    };
    return { info, body };
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
      const { info } = await readManifest(repository, reference, access);
      return info;
    },

    async inspect(repository, reference, access) {
      const { info, body } = await readManifest(repository, reference, access);
      // An index carries no layers/config itself — resolve through its runnable child. The reported digest
      // stays the INDEX's (that is what a spec pins); only layers/config come from the child. Every enrichment
      // step is best-effort: the manifest answered, so a child or blob the registry will not hand over degrades
      // the detail rather than failing the inspect.
      let image = body;
      if (body.manifests) {
        const child = pickRunnable(body.manifests);
        if (!child?.digest) return info;
        try {
          image = (await readManifest(repository, child.digest, access)).body;
        } catch {
          return info;
        }
      }
      const layerSizes = (image.layers ?? []).map((l) => l.size).filter((s): s is number => typeof s === "number");
      const sized = {
        ...info,
        ...(image.layers ? { layerCount: image.layers.length } : {}),
        ...(layerSizes.length > 0 ? { sizeBytes: layerSizes.reduce((sum, s) => sum + s, 0) } : {}),
      };
      if (!image.config?.digest) return sized;
      try {
        const blobRes = await call(`${repository}/blobs/${image.config.digest}`, access);
        const blob = (await readJson(blobRes, `the config of ${repository}:${reference}`)) as ImageConfigBlob;
        const history = (blob.history ?? []).flatMap((h) =>
          typeof h.created_by === "string" && h.created_by.length > 0
            ? [
                {
                  createdBy: h.created_by,
                  ...(h.created ? { created: h.created } : {}),
                  ...(h.empty_layer ? { emptyLayer: true } : {}),
                  ...(h.comment ? { comment: h.comment } : {}),
                },
              ]
            : [],
        );
        const c = blob.config;
        const config = {
          ...(c?.Entrypoint?.length ? { entrypoint: c.Entrypoint } : {}),
          ...(c?.Cmd?.length ? { cmd: c.Cmd } : {}),
          ...(c?.Env?.length ? { env: c.Env } : {}),
          ...(c?.WorkingDir ? { workingDir: c.WorkingDir } : {}),
          ...(c?.User ? { user: c.User } : {}),
          ...(c?.ExposedPorts && Object.keys(c.ExposedPorts).length > 0
            ? { exposedPorts: Object.keys(c.ExposedPorts) }
            : {}),
          ...(c?.Labels && Object.keys(c.Labels).length > 0 ? { labels: c.Labels } : {}),
        };
        return {
          ...sized,
          ...(blob.created ? { created: blob.created } : {}),
          ...(blob.os ? { os: blob.os } : {}),
          ...(blob.architecture ? { architecture: blob.architecture } : {}),
          ...(history.length > 0 ? { history } : {}),
          ...(Object.keys(config).length > 0 ? { config } : {}),
        };
      } catch {
        return sized;
      }
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
