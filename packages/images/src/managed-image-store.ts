import type { ImageManifestInfo, WorkspaceImages } from "@everdict/application-control";
import { BadRequestError, IMAGE_GRANT_USERNAME, type ImageGrant, type ImageRepo } from "@everdict/contracts";
import { IMAGE_REPOSITORY_NAME, imageRepoFor, parseImageRef } from "@everdict/domain";
import type { ManagedRegistryApi } from "./registry-api.js";
import type { RegistryAccess, RegistryTokenIssuer } from "./token-issuer.js";

// everdict's OWN image store — the image analog of S3WorkspaceFs. The workspace boundary is enforced HERE, in the
// adapter: every method resolves its repository argument INTO the tenant's namespace and refuses anything that
// would land outside it, and every registry call carries a token minted for exactly that repository. A caller
// cannot address another workspace's images, whatever it passes.
// Design: docs/architecture/managed-image-store.md

export interface ManagedImageStoreOptions {
  // Registry host[:port] refs are addressed by — reachable from EVERY execution node (a self-hosted runner on a
  // user's machine included), so it is an operator-configured public address, not a container-network name.
  endpoint: string;
  issuer: RegistryTokenIssuer;
  api: ManagedRegistryApi;
  // M6 — cross-tenant pull. May `tenant` pull `ref`, which lives in ANOTHER workspace's namespace? The store does
  // not answer this: reach is a capability question (canConsumeCapability over the environment that DECLARES the
  // ref), and the capability layer sits above this adapter. Injected as a narrow predicate so the store stays a
  // token minter that authorizes what it is told to, never a policy engine that decides on its own.
  // Absent (BYO-only wiring, tests) → cross-tenant refs are omitted, which is the pre-M6 safe default.
  crossTenantPull?: (tenant: string, ref: string) => Promise<boolean>;
}

const PULL: Array<"pull" | "push" | "delete"> = ["pull"];
const PULL_PUSH: Array<"pull" | "push" | "delete"> = ["pull", "push"];
// Distribution treats manifest deletion as its OWN action, not as a write: a pull+push token is refused at
// DELETE /v2/<name>/manifests/<digest> with a 401. `pull` rides along because the same token resolves the tag
// to the digest it deletes by.
const PULL_DELETE: Array<"pull" | "push" | "delete"> = ["pull", "delete"];

// A repository name a workspace may create: one path segment, the OCI grammar's lowercase alphanumerics with
// single separators. Deliberately stricter than the spec's multi-segment form — a nested path would let a caller
// smuggle a `/` and reason about someone else's namespace, and a flat name is all an environment image needs.
// The rule lives in @everdict/domain (IMAGE_REPOSITORY_NAME) because a sandbox WORLD id must satisfy it too.
const REPO_NAME = IMAGE_REPOSITORY_NAME;

export class ManagedImageStore implements WorkspaceImages {
  readonly endpoint: string;

  constructor(private readonly opts: ManagedImageStoreOptions) {
    this.endpoint = opts.endpoint;
  }

  namespaceFor(tenant: string): string {
    return imageRepoFor(tenant);
  }

  // Resolve whatever the caller passed — a bare name ("officeqa") or a full path ("<ns>/officeqa") — to the
  // repository path inside THIS tenant's namespace. A path naming another namespace is a 400, not a silent
  // rewrite: quietly redirecting it would make a mistyped ref look like it worked on someone else's image.
  private resolve(tenant: string, repository: string): string {
    const namespace = this.namespaceFor(tenant);
    const trimmed = repository.trim().replace(/^\/+|\/+$/g, "");
    const name = trimmed.startsWith(`${namespace}/`) ? trimmed.slice(namespace.length + 1) : trimmed;
    if (!REPO_NAME.test(name))
      throw new BadRequestError(
        "BAD_REQUEST",
        { repository },
        `"${repository}" is not a repository in this workspace — use a name like "officeqa-env" (lowercase letters, digits, '.', '_', '-').`,
      );
    return `${namespace}/${name}`;
  }

  private access(repository: string, actions: Array<"pull" | "push" | "delete">): RegistryAccess[] {
    return [{ type: "repository", name: repository, actions }];
  }

  async listRepositories(tenant: string): Promise<ImageRepo[]> {
    const namespace = this.namespaceFor(tenant);
    // `_catalog` is registry-WIDE, and distribution guards it with `registry:catalog:*` — a repository-scoped
    // token is refused there with a 401 no matter how broad its name pattern (a `<ns>/*` scope 401s, which is
    // how this was found: unit tests hand the adapter a fake registry, so only a live one can say). The scope is
    // registry-wide, so the workspace boundary here is the PREFIX FILTER applied to the result, and it is applied
    // unconditionally below rather than trusted to the token.
    const paths = await this.opts.api.catalog(namespace, [{ type: "registry", name: "catalog", actions: ["*"] }]);
    // Tags are NOT resolved here — one call per repository would turn a listing into a fan-out. The caller asks
    // for the tags of the repository it opens (`listTags`), which is also the only place they are needed.
    return paths.map((path) => ({
      name: path.slice(namespace.length + 1),
      repository: path,
      image: `${this.endpoint}/${path}`,
    }));
  }

  async listTags(tenant: string, repository: string): Promise<string[]> {
    const repo = this.resolve(tenant, repository);
    return this.opts.api.tags(repo, this.access(repo, PULL));
  }

  async inspect(tenant: string, repository: string, reference: string): Promise<ImageManifestInfo> {
    const repo = this.resolve(tenant, repository);
    // The enriched read (config blob → build history/runtime config) — digest-resolution paths (remove) stay on
    // the cheap `manifest` summary, so only the caller who opens a detail pays the extra round-trips.
    return this.opts.api.inspect(repo, reference, this.access(repo, PULL));
  }

  async mintPushGrant(tenant: string, repository: string): Promise<ImageGrant> {
    const repo = this.resolve(tenant, repository);
    // push implies pull: docker's push flow reads existing layers/manifests to skip what is already there.
    const access = this.access(repo, PULL_PUSH);
    const { token, expiresAt } = await this.opts.issuer.mintGrant(tenant, access);
    return { endpoint: this.endpoint, repositories: [repo], actions: ["pull", "push"], token, expiresAt };
  }

  async mintPullGrant(tenant: string, refs: string[]): Promise<ImageGrant[]> {
    const namespace = this.namespaceFor(tenant);
    const repositories: string[] = [];
    for (const ref of refs) {
      let parsed: ReturnType<typeof parseImageRef>;
      try {
        parsed = parseImageRef(ref);
      } catch {
        continue; // an unparseable ref is not ours to authorize; the pull will fail on its own terms
      }
      if (parsed.host !== this.endpoint) continue; // not a managed image at all (BYO/public — another adapter's job)
      // Own namespace → granted outright.
      if (parsed.path === namespace || parsed.path.startsWith(`${namespace}/`)) {
        repositories.push(parsed.path);
        continue;
      }
      // Another workspace's namespace → granted ONLY when the reach policy says this consumer may pull it (M6).
      // Without a policy the ref is omitted and the pull fails with the registry's own 401, which stays the safe
      // default: an omission costs a failed pull, an invented grant costs cross-tenant isolation.
      if (this.opts.crossTenantPull && (await this.opts.crossTenantPull(tenant, ref))) repositories.push(parsed.path);
    }
    const unique = [...new Set(repositories)];
    if (unique.length === 0) return [];
    // ONE grant covering every repository — the property a per-host BYO credential cannot have, and the reason a
    // multi-service topology can authenticate all of its managed images with a single credential.
    const access: RegistryAccess[] = unique.map((name) => ({ type: "repository", name, actions: PULL }));
    const { token, expiresAt } = await this.opts.issuer.mintGrant(tenant, access);
    return [{ endpoint: this.endpoint, repositories: unique, actions: ["pull"], token, expiresAt }];
  }

  async remove(tenant: string, repository: string, reference?: string): Promise<number> {
    const repo = this.resolve(tenant, repository);
    const access = this.access(repo, PULL_DELETE); // `delete` is its own registry action, not a flavour of push
    // Distribution deletes manifests by DIGEST only, so a tag is resolved to its digest first. Without a
    // reference the whole repository goes: every tag's digest, deduplicated (tags commonly share one manifest).
    const references = reference ? [reference] : await this.opts.api.tags(repo, this.access(repo, PULL));
    const digests = new Set<string>();
    for (const ref of references) {
      const info = await this.opts.api.manifest(repo, ref, this.access(repo, PULL)).catch(() => undefined);
      if (info?.digest) digests.add(info.digest);
    }
    let removed = 0;
    for (const digest of digests) {
      if (await this.opts.api.deleteManifest(repo, digest, access)) removed += 1;
    }
    return removed;
  }

  async usage(tenant: string): Promise<{ repositories: number; bytes?: number }> {
    // `bytes` is deliberately absent: distribution exposes no size API, and deriving it means walking every
    // manifest's blob list per repository. Reporting a count we know beats reporting a size we guessed.
    return { repositories: (await this.listRepositories(tenant)).length };
  }
}

// The docker credential a grant is presented as — `docker login -u <username> -p <token>`, or the transient
// DOCKER_CONFIG the CLI and the pre-pull paths write. Keeps the "grant → RegistryAuth" mapping in one place so
// no caller invents its own username.
export function grantAsRegistryAuth(grant: ImageGrant): { host: string; username: string; password: string } {
  return { host: grant.endpoint, username: IMAGE_GRANT_USERNAME, password: grant.token };
}
