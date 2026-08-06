import { readFileSync } from "node:fs";
import type { ImageRegistryService, WorkspaceImages } from "@everdict/application-control";
import type { RegistryAuth as SourceAuth } from "@everdict/contracts";
import type { RegistryAuth } from "@everdict/contracts";
import {
  ImageTokenService,
  InMemoryImageStore,
  ManagedImageStore,
  type RegistryAccess,
  RegistryTokenIssuer,
  appendLayer,
  copyImage,
  fetchManagedRegistryApi,
  fetchRegistryWriter,
  grantAsRegistryAuth,
  remoteImageSource,
  sourceReferenceOf,
} from "@everdict/images";
import { ImageMirrorService } from "../core/image/image-mirror-service.js";

// Managed image store wiring. Entirely optional: with no endpoint or signing key configured the deployment is
// "BYO registries only" and both the store and the token endpoint stay undefined, so nothing pretends a registry
// exists. Design: docs/architecture/managed-image-store.md
export interface ManagedImages {
  images?: WorkspaceImages;
  imageTokenService?: ImageTokenService;
  // Copy an image the deployment does not own INTO the managed registry — a workspace's namespace (a base or
  // harness image it no longer wants to depend on a public registry for) or the platform's (everdict's own
  // images, so a deployment needs no reach to GHCR).
  imageMirror?: ImageMirrorService;
  // Publish "base image + one captured layer" through the registry API alone (agent worlds W4). Present
  // wherever the managed store is: it is the snapshot path for a session the control plane cannot reach a
  // daemon for — which is every placement except this host.
  publishLayerSnapshot?: (input: {
    tenant: string;
    world: string;
    tag: string;
    baseReference: string;
    baseImage: string;
    layerGzip: Buffer;
    createdBy: string;
  }) => Promise<{ digest: string }>;
}

// A PEM read from disk rather than an env value: a private key in the process environment leaks into every child
// process, `docker inspect`, and most crash reporters. The compose stack mounts the pair as files.
function readPem(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `EVERDICT_IMAGE_STORE_${what}_FILE points at an unreadable file (${path}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// M6 — the cross-tenant reach predicate the store consults for a ref outside the caller's namespace. Passed in
// rather than built here because the answer comes from the capability layer (adoption), which in turn needs this
// store's coordinates to classify an image: a real cycle between the two, resolved in the composition root by
// binding this late (see main.ts) instead of pretending one of them can be constructed first.
export interface ManagedImagesOptions {
  // The workspace's registered pull credentials, for mirroring from a PRIVATE source it already told us about.
  pullAuthsFor?: (tenant: string) => Promise<SourceAuth[]>;
  crossTenantPull?: (tenant: string, ref: string) => Promise<boolean>;
}

export function buildManagedImages(
  env: NodeJS.ProcessEnv = process.env,
  opts: ManagedImagesOptions = {},
): ManagedImages {
  // The address IMAGE REFS carry — every execution node must reach it (a self-hosted runner on someone's laptop
  // included), so it is an operator-set public host, never a container-network name.
  const endpoint = env.EVERDICT_IMAGE_STORE_ENDPOINT;
  const keyFile = env.EVERDICT_IMAGE_STORE_KEY_FILE;
  const certFile = env.EVERDICT_IMAGE_STORE_CERT_FILE;
  if (!endpoint || !keyFile || !certFile) return {};

  // Grants outlive the queue: a dispatched job's credentials are minted BEFORE it is scheduled, so the lifetime
  // has to cover queue wait + pull, not just the exchange. An hour is the compromise — long enough that a batch
  // behind a busy scheduler still pulls, short enough that revoked reach stops working the same session. A job
  // queued past it fails at pull with the registry's own error, which is visible, not silent.
  const grantTtlSeconds = Number(env.EVERDICT_IMAGE_STORE_GRANT_TTL_SECONDS ?? 3600);
  const issuer = new RegistryTokenIssuer({
    privateKeyPem: readPem(keyFile, "KEY"),
    certificatePem: readPem(certFile, "CERT"),
    issuer: env.EVERDICT_IMAGE_STORE_ISSUER ?? "everdict",
    service: env.EVERDICT_IMAGE_STORE_SERVICE ?? "everdict-registry",
    ...(Number.isFinite(grantTtlSeconds) && grantTtlSeconds > 0 ? { grantTtlSeconds } : {}),
  });
  // Where the CONTROL PLANE reaches the registry, which is not always where clients do: in compose the api talks
  // to http://registry:5000 over the container network while a developer's docker pulls from localhost:5001.
  // Conflating the two is the same mistake CONTROL_PLANE_WS_URL exists to prevent.
  const apiBase = env.EVERDICT_IMAGE_STORE_API ?? `https://${endpoint}`;
  const images = new ManagedImageStore({
    endpoint,
    issuer,
    api: fetchManagedRegistryApi(apiBase, (access) => issuer.mintRegistryToken("everdict-control-plane", access)),
    ...(opts.crossTenantPull ? { crossTenantPull: opts.crossTenantPull } : {}),
  });
  const writer = fetchRegistryWriter(apiBase, (access) => issuer.mintRegistryToken("everdict-control-plane", access));
  return {
    images,
    imageMirror: new ImageMirrorService({
      endpoint,
      namespaceFor: (tenant) => images.namespaceFor(tenant),
      writer,
      // Reading a PRIVATE source uses the workspace's own registered credentials — a mirror must not become a
      // way to reach a registry the workspace never told us about.
      ...(opts.pullAuthsFor ? { pullAuthsFor: opts.pullAuthsFor } : {}),
    }),
    imageTokenService: new ImageTokenService({
      issuer,
      service: env.EVERDICT_IMAGE_STORE_SERVICE ?? "everdict-registry",
    }),
    // The repository is resolved through the STORE (`namespaceFor`), never assembled here — the namespace
    // rule is the isolation boundary, and a second place that spells it is a second place to get it wrong.
    publishLayerSnapshot: async (input) => {
      const repository = `${images.namespaceFor(input.tenant)}/${input.world}`;
      const access: RegistryAccess[] = [{ type: "repository", name: repository, actions: ["pull", "push"] }];
      // Founding a world: the base is an image somewhere else entirely (`debian:stable-slim`), and a manifest
      // may only reference blobs its own repository holds. The daemon path hid this — a `docker commit` push
      // uploads the base's layers along with the new one because the daemon had them locally. So copy the base
      // in first, which is what that push was implicitly doing. Later snapshots find it already there.
      let baseReference = input.baseReference;
      if ((await writer.getManifest(repository, baseReference, access)) === undefined) {
        const copied = await copyImage(
          remoteImageSource(input.baseImage),
          writer,
          { repository, reference: sourceReferenceOf(input.baseImage), tag: `base-${input.tag}` },
          access,
        );
        baseReference = copied.digest; // pin the base by what the TARGET registry stored
      }
      return appendLayer(
        writer,
        {
          repository,
          baseReference,
          tag: input.tag,
          layerGzip: input.layerGzip,
          createdBy: input.createdBy,
          created: new Date().toISOString(),
        },
        access,
      );
    },
  };
}

// Dev/test store — an in-process registry with the same semantics, for a stack that wants the managed surfaces
// without running a registry. Never wired by default: it enforces no real authorization boundary.
export function inMemoryManagedImages(endpoint?: string): ManagedImages {
  return { images: new InMemoryImageStore(endpoint ? { endpoint } : {}) };
}

// The one answer to "what credentials does this job need to pull its images" — the seam executeCase and the
// RuntimeDispatcher both call. Managed grants come FIRST: consumers pick the first credential matching an image's
// host, and when a workspace has also registered a BYO registry on the same host, ours is the one we can vouch for.
//
// Both halves are best-effort by design (the placement stance is warn-only): a registry that cannot be reached
// must not turn into a dispatch failure for a job whose other images pull fine. An image no credential covers is
// simply pulled anonymously, which is correct for public base images and honest for everything else — the failure
// surfaces as the registry's own "unauthorized" at pull time rather than as a gate that guesses.
export function buildImagePullAuths(deps: {
  images?: WorkspaceImages;
  imageRegistry: ImageRegistryService;
}): (workspace: string, imageRefs: string[]) => Promise<RegistryAuth[]> {
  return async (workspace, imageRefs) => {
    const managed = deps.images
      ? await deps.images
          .mintPullGrant(workspace, imageRefs)
          .then((grants) => grants.map(grantAsRegistryAuth))
          .catch(() => [] as RegistryAuth[])
      : [];
    const byo = await deps.imageRegistry.pullAuths(workspace).catch(() => [] as RegistryAuth[]);
    return [...managed, ...byo];
  };
}
