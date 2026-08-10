import type { ProductServiceSource } from "@everdict/contracts";
import type { ProductServiceSuggestion, RepoPackage, RepoVersionSample } from "@everdict/contracts/wire";

// TURNING A REPOSITORY INTO A PROPOSED COMPOSITION (docs/architecture/product-timeline.md §wizard).
//
// A product's services used to be typed: a name, a repository, and a `tagPrefix` somebody had to know. The
// prefix is the part that punishes a typo silently — `api-` when the tags read `api/v1.2.0` matches nothing,
// the sync reports "imported 0", and the timeline stays empty forever with no error anywhere. The repository
// already knows the answer: its tags say which streams exist, its tree says which deployable units live in it.
// This module is the pure derivation from those two facts to the rows a wizard renders as checkboxes.
//
// Pure and total — the I/O (tokens, the GitHub reads) is the application layer's; everything here is a
// decision over data already in hand, which is what makes the proposals testable against real tag shapes.

// The first digit run is where the version starts, and everything before it is the stream's prefix:
// "api-v1.2.0" → "api-v", "v1.2.0" → "v", "1.2.0" → "", "release-2026.3" → "release-". A tag with no digits
// at all is its own prefix, which is honest — "nightly" names no version stream, and grouping it with
// something else would invent a relationship the repository never stated.
const VERSION_START = /\d/;

export function versionTagPrefix(tag: string): string {
  const at = tag.search(VERSION_START);
  return at === -1 ? tag : tag.slice(0, at);
}

// One detected stream: a prefix, how much of the sample it claims, and when it moved. `count` is a FLOOR when
// the sample was truncated — the caller reports that separately rather than letting a bounded read read as a
// complete census.
export interface DetectedVersionStream {
  tagPrefix: string; // "" = bare numeric tags, which claim everything (see proposeServices)
  count: number;
  latestVersion?: string;
  latestPublishedAt?: string;
  firstPublishedAt?: string;
}

export function detectVersionStreams(versions: readonly RepoVersionSample[]): DetectedVersionStream[] {
  const streams = new Map<string, DetectedVersionStream>();
  for (const version of versions) {
    const tagPrefix = versionTagPrefix(version.name);
    const current = streams.get(tagPrefix) ?? { tagPrefix, count: 0 };
    current.count += 1;
    // The newest by the REMOTE clock, not by sample order: a caller may hand these over unsorted, and "which
    // version is current" is a question about publication, not about arrival.
    if (
      version.publishedAt !== undefined &&
      (current.latestPublishedAt === undefined || version.publishedAt > current.latestPublishedAt)
    ) {
      current.latestPublishedAt = version.publishedAt;
      current.latestVersion = version.name;
    }
    if (
      version.publishedAt !== undefined &&
      (current.firstPublishedAt === undefined || version.publishedAt < current.firstPublishedAt)
    )
      current.firstPublishedAt = version.publishedAt;
    // A stream whose every sample is dateless (unresolved tag commits) still names its newest by order — the
    // caller hands the samples over newest-first, and having no name at all would render as an empty row.
    if (current.latestVersion === undefined) current.latestVersion = version.name;
    streams.set(tagPrefix, current);
  }
  return [...streams.values()].sort((a, b) => b.count - a.count || a.tagPrefix.localeCompare(b.tagPrefix));
}

// How many streams a repository may propose. A repository that tags every commit produces hundreds of
// one-member "streams"; a wall of checkboxes is the same failure as a blank form, one screen further on.
const MAX_STREAMS = 12;
const MAX_SUGGESTIONS = 40;

// What people call the thing a stream releases: "api-v" → "api", "web@" → "web", "v"/"" → the repository's
// own tail (a repo-wide stream releases the repository, not a component of it).
function streamLabel(tagPrefix: string, repository: string): string {
  const repoTail = repository.split("/").at(-1) ?? repository;
  const withoutTrailingSeparators = tagPrefix.replace(/[-_/@.]+$/, "");
  if (withoutTrailingSeparators === "" || /^v$/i.test(withoutTrailingSeparators)) return repoTail;
  const withoutVersionMarker = withoutTrailingSeparators.replace(/[-_/@.]*v$/i, "").replace(/[-_/@.]+$/, "");
  return withoutVersionMarker === "" ? repoTail : withoutVersionMarker;
}

// Names match on their SHAPE, not their spelling: "@everdict/api", "apps/api" and "api-v" are three ways one
// repository refers to one service, and a monorepo that spells any of them differently just stays unmatched
// (a package the wizard still lists, never a wrong pairing it asserts).
function normalize(value: string): string {
  const tail = value.split("/").at(-1) ?? value;
  return tail.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ProposeServicesInput {
  repository: string; // "owner/name"
  source: ProductServiceSource;
  versions: readonly RepoVersionSample[];
  packages: readonly RepoPackage[];
}

// The wizard's rows. Two populations, and the difference between them is the whole point of `recommended`:
//
//   a STREAM is evidence — this repository demonstrably publishes versions under this prefix, so a service
//   declared on it will import something. Pre-checked.
//   a PACKAGE is a candidate — this directory looks deployable. Under a repo-wide tag stream it is a real
//   monorepo service (all of them move together, which is what a global tag means); with no stream to attach
//   to it is a guess, so it is offered unchecked, or not at all.
export function proposeServices(input: ProposeServicesInput): ProductServiceSuggestion[] {
  const streams = detectVersionStreams(input.versions).slice(0, MAX_STREAMS);
  const packagesByName = new Map(input.packages.map((entry) => [normalize(entry.name), entry] as const));
  const packagesByPath = new Map(input.packages.map((entry) => [normalize(entry.path), entry] as const));
  const claimed = new Set<string>();
  const suggestions: ProductServiceSuggestion[] = [];

  for (const stream of streams) {
    // A BARE-NUMERIC stream cannot be declared alongside others. `tagPrefix: undefined` means "every tag", so
    // proposing it next to "api-v" and "web-v" would hand the user a row that silently swallows the other two
    // streams' versions. Where it is the only stream it means exactly what it says.
    if (stream.tagPrefix === "" && streams.length > 1) continue;
    const label = streamLabel(stream.tagPrefix, input.repository);
    const pkg = packagesByName.get(normalize(label)) ?? packagesByPath.get(normalize(label));
    if (pkg !== undefined) claimed.add(pkg.path);
    suggestions.push({
      name: label,
      ...(pkg !== undefined ? { path: pkg.path } : {}),
      source: input.source,
      ...(stream.tagPrefix !== "" ? { tagPrefix: stream.tagPrefix } : {}),
      recommended: true,
      matched: stream.count,
      ...(stream.latestVersion !== undefined ? { latestVersion: stream.latestVersion } : {}),
      ...(stream.latestPublishedAt !== undefined ? { latestPublishedAt: stream.latestPublishedAt } : {}),
      ...(stream.firstPublishedAt !== undefined ? { firstPublishedAt: stream.firstPublishedAt } : {}),
    });
  }

  // The repo-wide stream, if there is one — what an unmatched package attaches to. A monorepo tagged
  // `v2026.3` releases every one of its packages at once, and that is a real composition, not an approximation.
  const wide = streams.find(
    (stream) => streamLabel(stream.tagPrefix, input.repository) === streamLabel("", input.repository),
  );
  for (const pkg of input.packages) {
    if (claimed.has(pkg.path)) continue;
    if (wide === undefined) continue; // nothing to read: listed as a package, never asserted as a service
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    suggestions.push({
      name: normalize(pkg.name) === "" ? pkg.path : (pkg.name.split("/").at(-1) ?? pkg.name),
      path: pkg.path,
      source: input.source,
      ...(wide.tagPrefix !== "" ? { tagPrefix: wide.tagPrefix } : {}),
      recommended: false,
      matched: wide.count,
      ...(wide.latestVersion !== undefined ? { latestVersion: wide.latestVersion } : {}),
      ...(wide.latestPublishedAt !== undefined ? { latestPublishedAt: wide.latestPublishedAt } : {}),
      ...(wide.firstPublishedAt !== undefined ? { firstPublishedAt: wide.firstPublishedAt } : {}),
    });
  }

  // A repository with neither streams nor packages still composes something — itself. Offering one row named
  // after the repository is what turns "we found nothing" into a product somebody can still create and sync.
  if (suggestions.length === 0)
    suggestions.push({
      name: streamLabel("", input.repository),
      source: input.source,
      recommended: true,
      matched: 0,
    });
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

// --- Reading the tree ------------------------------------------------------------------------------------
// Which files mark a deployable unit, and what the unit is called. Kept here rather than in the adapter
// because "what counts as a service in a monorepo" is a product decision, and the adapter's job is bytes.
export const PACKAGE_MANIFESTS = ["package.json", "go.mod", "pyproject.toml", "Cargo.toml", "Dockerfile"] as const;
export type PackageManifest = (typeof PACKAGE_MANIFESTS)[number];

// How deep a manifest may sit before it stops describing a top-level component. `apps/api/package.json` is a
// service; `apps/api/node_modules/x/package.json` is a dependency, and a vendored tree would otherwise
// produce thousands of "services".
const MAX_PACKAGE_DEPTH = 3;
const IGNORED_SEGMENTS = new Set(["node_modules", "vendor", "dist", "build", "target", ".git", "third_party"]);
const MAX_PACKAGES = 50;

// Turn a repository's file list into candidate packages. The ROOT manifest is deliberately excluded: every
// repository has one, and a row for "the repository itself" is what the repo-wide stream already proposes.
export function detectPackages(paths: readonly string[]): RepoPackage[] {
  const found = new Map<string, RepoPackage>();
  for (const path of paths) {
    const segments = path.split("/");
    const file = segments.at(-1);
    if (file === undefined) continue;
    if (!(PACKAGE_MANIFESTS as readonly string[]).includes(file)) continue;
    const directory = segments.slice(0, -1);
    if (directory.length === 0 || directory.length > MAX_PACKAGE_DEPTH) continue;
    if (directory.some((segment) => IGNORED_SEGMENTS.has(segment) || segment.startsWith("."))) continue;
    const dirPath = directory.join("/");
    // First manifest wins by declaration order (PACKAGE_MANIFESTS), so a directory holding both a
    // package.json and a Dockerfile is named by the manifest that carries a name.
    if (found.has(dirPath)) continue;
    found.set(dirPath, { path: dirPath, name: directory.at(-1) ?? dirPath, manifest: file });
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_PACKAGES);
}
