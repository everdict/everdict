import type { ImageManifestInfo, WorkspaceImages } from "@everdict/application-control";
import { BadRequestError, type ImageGrant, type ImageRepo, NotFoundError } from "@everdict/contracts";
import { imageRepoFor, parseImageRef } from "@everdict/domain";

// Dev/test image store — mirrors ManagedImageStore's semantics (namespace containment, one grant covering many
// repositories, tag→digest deletion) without a registry. Per-process, not persisted. The counterpart of
// InMemoryWorkspaceFs. Grants are opaque strings here: nothing verifies them, so never wire this where a real
// authorization boundary is needed.

interface StoredRepo {
  tags: Map<string, string>; // tag → digest
  sizeBytes: number;
  updatedAt: string;
}

const REPO_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class InMemoryImageStore implements WorkspaceImages {
  readonly endpoint: string;
  // tenant → (repository path → repo). Keyed by tenant, so a test cannot accidentally observe cross-tenant reads.
  private readonly repos = new Map<string, Map<string, StoredRepo>>();
  private grantCounter = 0;

  constructor(opts: { endpoint?: string; now?: () => number } = {}) {
    this.endpoint = opts.endpoint ?? "images.everdict.test";
    this.now = opts.now ?? Date.now;
  }

  private readonly now: () => number;

  namespaceFor(tenant: string): string {
    return imageRepoFor(tenant);
  }

  private resolve(tenant: string, repository: string): string {
    const namespace = this.namespaceFor(tenant);
    const trimmed = repository.trim().replace(/^\/+|\/+$/g, "");
    const name = trimmed.startsWith(`${namespace}/`) ? trimmed.slice(namespace.length + 1) : trimmed;
    if (!REPO_NAME.test(name))
      throw new BadRequestError("BAD_REQUEST", { repository }, `"${repository}" is not a repository in this workspace`);
    return `${namespace}/${name}`;
  }

  private tenantRepos(tenant: string): Map<string, StoredRepo> {
    const existing = this.repos.get(tenant);
    if (existing) return existing;
    const created = new Map<string, StoredRepo>();
    this.repos.set(tenant, created);
    return created;
  }

  // Test seam — put an image in the store as if it had been pushed.
  push(tenant: string, repository: string, tag: string, opts: { digest?: string; sizeBytes?: number } = {}): string {
    const repo = this.resolve(tenant, repository);
    const repos = this.tenantRepos(tenant);
    const stored = repos.get(repo) ?? { tags: new Map(), sizeBytes: 0, updatedAt: "" };
    const digest = opts.digest ?? `sha256:${repo}-${tag}`;
    stored.tags.set(tag, digest);
    stored.sizeBytes += opts.sizeBytes ?? 0;
    stored.updatedAt = new Date(this.now()).toISOString();
    repos.set(repo, stored);
    return digest;
  }

  async listRepositories(tenant: string): Promise<ImageRepo[]> {
    const namespace = this.namespaceFor(tenant);
    return [...this.tenantRepos(tenant).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, repo]) => ({
        name: path.slice(namespace.length + 1),
        repository: path,
        image: `${this.endpoint}/${path}`,
        tags: [...repo.tags.keys()].sort(),
        sizeBytes: repo.sizeBytes,
        updatedAt: repo.updatedAt,
      }));
  }

  async listTags(tenant: string, repository: string): Promise<string[]> {
    return [...(this.tenantRepos(tenant).get(this.resolve(tenant, repository))?.tags.keys() ?? [])].sort();
  }

  async inspect(tenant: string, repository: string, reference: string): Promise<ImageManifestInfo> {
    const repo = this.resolve(tenant, repository);
    const stored = this.tenantRepos(tenant).get(repo);
    const digest = reference.startsWith("sha256:")
      ? [...(stored?.tags.values() ?? [])].find((d) => d === reference)
      : stored?.tags.get(reference);
    if (!digest)
      throw new NotFoundError("NOT_FOUND", { repository: repo, reference }, `${repo}:${reference} is not in the store`);
    return { reference, digest, mediaType: "application/vnd.oci.image.manifest.v1+json" };
  }

  private grant(tenant: string, repositories: string[], actions: Array<"pull" | "push">): ImageGrant {
    this.grantCounter += 1;
    return {
      endpoint: this.endpoint,
      repositories,
      actions,
      token: `grant-${tenant}-${this.grantCounter}`,
      expiresAt: new Date(this.now() + 900_000).toISOString(),
    };
  }

  async mintPushGrant(tenant: string, repository: string): Promise<ImageGrant> {
    return this.grant(tenant, [this.resolve(tenant, repository)], ["pull", "push"]);
  }

  async mintPullGrant(tenant: string, refs: string[]): Promise<ImageGrant[]> {
    const namespace = this.namespaceFor(tenant);
    const repositories = new Set<string>();
    for (const ref of refs) {
      try {
        const parsed = parseImageRef(ref);
        if (parsed.host !== this.endpoint) continue;
        if (parsed.path === namespace || parsed.path.startsWith(`${namespace}/`)) repositories.add(parsed.path);
      } catch {
        // an unparseable ref is not ours to authorize
      }
    }
    return repositories.size === 0 ? [] : [this.grant(tenant, [...repositories], ["pull"])];
  }

  async remove(tenant: string, repository: string, reference?: string): Promise<number> {
    const repo = this.resolve(tenant, repository);
    const repos = this.tenantRepos(tenant);
    const stored = repos.get(repo);
    if (!stored) return 0;
    if (!reference) {
      const removed = new Set(stored.tags.values()).size;
      repos.delete(repo);
      return removed;
    }
    const digest = reference.startsWith("sha256:") ? reference : stored.tags.get(reference);
    if (!digest) return 0;
    // Deleting a manifest drops every tag pointing at it — the registry's own semantics, not a per-tag delete.
    let removedTags = 0;
    for (const [tag, d] of [...stored.tags.entries()]) {
      if (d === digest) {
        stored.tags.delete(tag);
        removedTags += 1;
      }
    }
    if (stored.tags.size === 0) repos.delete(repo);
    return removedTags > 0 ? 1 : 0;
  }

  async usage(tenant: string): Promise<{ repositories: number; bytes?: number }> {
    const repos = [...this.tenantRepos(tenant).values()];
    return { repositories: repos.length, bytes: repos.reduce((sum, r) => sum + r.sizeBytes, 0) };
  }
}
