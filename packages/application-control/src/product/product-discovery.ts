import { UpstreamError } from "@everdict/contracts";
import type { ProductServiceSource } from "@everdict/contracts";
import type { ProductRepoDiscoveryResponse, RepoVersionSample } from "@everdict/contracts/wire";
import { detectPackages, proposeServices } from "@everdict/domain";
import type { GithubRepositoryTokenSource } from "../issue/github-issue-sync.js";
import type { GithubRepoTreeReaderFactory, GithubVersionReaderFactory } from "../ports/github-repo-writer.js";

// READING A REPOSITORY SO A PRODUCT CAN BE DECLARED BY CHOOSING (docs/architecture/product-timeline.md).
//
// Declaring a service used to mean typing a name, a repository and a `tagPrefix`. The prefix is the field that
// punishes a mistake silently: `api-` against tags that read `api/v1.2.0` matches nothing, the sync reports
// "imported 0", and the product's timeline stays empty forever with nothing anywhere calling it an error. The
// repository already holds both answers — its published versions say which streams exist, its tree says which
// deployable units live in it — so this reads them once and hands the wizard rows to tick.
//
// Read-only: it persists nothing and creates nothing. Its output is evidence for a decision the member is
// about to make, which is also why every degradation here is partial rather than fatal (a tree that cannot be
// read still leaves the version streams worth showing).

// How much version history the wizard samples. Enough to see every stream a repository publishes and to date
// the axis; not an import (that is the sync's job, with its own, larger ceiling).
const SAMPLE_PER_PAGE = 100;
const SAMPLE_MAX_PAGES = 2;
// Tags carry no date of their own, and resolving one costs a commit read each. The newest few are what the
// wizard actually draws ("this stream last moved in March"), so the cost is bounded and DECLARED rather than
// scaling with a repository's tag count.
const DATED_TAGS = 15;

export interface ProductDiscoveryDeps {
  tokens: GithubRepositoryTokenSource;
  readers: GithubVersionReaderFactory;
  // Absent = this deployment can read versions but not trees: discovery still proposes stream-derived
  // services and simply finds no packages, which is honest degradation rather than a broken screen.
  trees?: GithubRepoTreeReaderFactory;
}

export class ProductDiscovery {
  constructor(private readonly deps: ProductDiscoveryDeps) {}

  async discover(tenant: string, input: { repository: string; host?: string }): Promise<ProductRepoDiscoveryResponse> {
    const { token, host } = await this.deps.tokens.tokenForRepository(
      tenant,
      input.repository,
      { contents: "read" },
      input.host,
    );
    const reader = this.deps.readers.for(token, host);
    let complete = true;
    // RELEASES FIRST — a published release is the stronger claim (someone decided it was a release), and a
    // repository that publishes none falls back to its tags. The choice is reported, because every proposed
    // row inherits it as its `source` and the member is agreeing to it.
    let source: ProductServiceSource = "releases";
    let versions: RepoVersionSample[] = [];
    const releases = await reader
      .listReleases(input.repository, { perPage: SAMPLE_PER_PAGE, maxPages: SAMPLE_MAX_PAGES })
      .catch((err: unknown) => {
        throw upstream(input.repository, err);
      });
    if (!releases.complete) complete = false;
    versions = releases.rows
      // A draft has not made the "released" claim yet — the same filter the sync applies, so the wizard's
      // preview counts what an import would actually bring.
      .filter((release) => !release.draft && release.publishedAt !== undefined)
      .map((release) => ({
        name: release.tagName,
        kind: "release" as const,
        prerelease: release.prerelease,
        ...(release.publishedAt !== undefined ? { publishedAt: release.publishedAt } : {}),
        url: release.url,
      }));
    if (versions.length === 0) {
      source = "tags";
      const tags = await reader
        .listTags(input.repository, { perPage: SAMPLE_PER_PAGE, maxPages: SAMPLE_MAX_PAGES })
        .catch((err: unknown) => {
          throw upstream(input.repository, err);
        });
      if (!tags.complete) complete = false;
      versions = [];
      for (const [index, tag] of tags.rows.entries()) {
        // Only the newest few get a date resolved — see DATED_TAGS. An undated sample is still a stream
        // member (it counts, it can be picked); it just cannot place itself on the axis.
        const publishedAt =
          index < DATED_TAGS ? await reader.commitDate(input.repository, tag.sha).catch(() => undefined) : undefined;
        versions.push({
          name: tag.name,
          kind: "tag",
          prerelease: false,
          ...(publishedAt !== undefined ? { publishedAt } : {}),
        });
      }
    }

    // The tree is BEST-EFFORT and separately bounded. A repository whose tree cannot be read (an enormous
    // monorepo, a permission the App was not granted) still has streams worth proposing, and failing the whole
    // discovery over the composition half would send the member back to the blank form this exists to remove.
    let packages: ReturnType<typeof detectPackages> = [];
    if (this.deps.trees !== undefined) {
      const tree = await this.deps.trees
        .for(token, host)
        .listTree(input.repository)
        .catch(() => ({ paths: [] as string[], truncated: true }));
      if (tree.truncated) complete = false;
      packages = detectPackages(tree.paths);
    }

    return {
      repository: input.repository,
      ...(host !== undefined ? { host } : {}),
      source,
      versions,
      packages,
      suggestions: proposeServices({ repository: input.repository, source, versions, packages }),
      complete,
    };
  }
}

// GitHub's failures are remapped, never propagated: the wizard's message must blame the integration, not
// present a raw upstream body to a member who is choosing repositories.
function upstream(repository: string, err: unknown): UpstreamError {
  return new UpstreamError(
    "UPSTREAM_ERROR",
    { repository },
    `Could not read ${repository} from GitHub — ${err instanceof Error ? err.message : String(err)}`,
  );
}
