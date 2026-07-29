import { readFileSync } from "node:fs";
import type { WorkspaceImages } from "@everdict/application-control";
import {
  ImageTokenService,
  InMemoryImageStore,
  ManagedImageStore,
  RegistryTokenIssuer,
  fetchManagedRegistryApi,
} from "@everdict/images";

// Managed image store wiring. Entirely optional: with no endpoint or signing key configured the deployment is
// "BYO registries only" and both the store and the token endpoint stay undefined, so nothing pretends a registry
// exists. Design: docs/architecture/managed-image-store.md
export interface ManagedImages {
  images?: WorkspaceImages;
  imageTokenService?: ImageTokenService;
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

export function buildManagedImages(env: NodeJS.ProcessEnv = process.env): ManagedImages {
  // The address IMAGE REFS carry — every execution node must reach it (a self-hosted runner on someone's laptop
  // included), so it is an operator-set public host, never a container-network name.
  const endpoint = env.EVERDICT_IMAGE_STORE_ENDPOINT;
  const keyFile = env.EVERDICT_IMAGE_STORE_KEY_FILE;
  const certFile = env.EVERDICT_IMAGE_STORE_CERT_FILE;
  if (!endpoint || !keyFile || !certFile) return {};

  const issuer = new RegistryTokenIssuer({
    privateKeyPem: readPem(keyFile, "KEY"),
    certificatePem: readPem(certFile, "CERT"),
    issuer: env.EVERDICT_IMAGE_STORE_ISSUER ?? "everdict",
    service: env.EVERDICT_IMAGE_STORE_SERVICE ?? "everdict-registry",
  });
  // Where the CONTROL PLANE reaches the registry, which is not always where clients do: in compose the api talks
  // to http://registry:5000 over the container network while a developer's docker pulls from localhost:5001.
  // Conflating the two is the same mistake CONTROL_PLANE_WS_URL exists to prevent.
  const apiBase = env.EVERDICT_IMAGE_STORE_API ?? `https://${endpoint}`;
  const images = new ManagedImageStore({
    endpoint,
    issuer,
    api: fetchManagedRegistryApi(apiBase, (access) => issuer.mintRegistryToken("everdict-control-plane", access)),
  });
  return {
    images,
    imageTokenService: new ImageTokenService({
      issuer,
      service: env.EVERDICT_IMAGE_STORE_SERVICE ?? "everdict-registry",
    }),
  };
}

// Dev/test store — an in-process registry with the same semantics, for a stack that wants the managed surfaces
// without running a registry. Never wired by default: it enforces no real authorization boundary.
export function inMemoryManagedImages(endpoint?: string): ManagedImages {
  return { images: new InMemoryImageStore(endpoint ? { endpoint } : {}) };
}
