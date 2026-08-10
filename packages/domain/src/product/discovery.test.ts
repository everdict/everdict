import type { RepoVersionSample } from "@everdict/contracts/wire";
import { describe, expect, it } from "vitest";
import { detectPackages, detectVersionStreams, proposeServices, versionTagPrefix } from "./discovery.js";

function release(name: string, publishedAt?: string): RepoVersionSample {
  return { name, kind: "release", prerelease: false, ...(publishedAt !== undefined ? { publishedAt } : {}) };
}

describe("versionTagPrefix — everything before the version is the stream", () => {
  it("reads the shapes a monorepo actually tags with", () => {
    expect(versionTagPrefix("api-v1.2.0")).toBe("api-v");
    expect(versionTagPrefix("web@3.1.0")).toBe("web@");
    expect(versionTagPrefix("packages/core/v0.4.1")).toBe("packages/core/v");
    expect(versionTagPrefix("v1.2.0")).toBe("v");
    expect(versionTagPrefix("1.2.0")).toBe("");
  });

  it("keeps a digit-less tag as its own stream rather than inventing a relationship", () => {
    expect(versionTagPrefix("nightly")).toBe("nightly");
  });
});

describe("detectVersionStreams — what this repository publishes", () => {
  it("groups a monorepo's tags into one stream per component, biggest first", () => {
    const streams = detectVersionStreams([
      release("api-v1.2.0", "2026-03-01T00:00:00.000Z"),
      release("api-v1.1.0", "2026-01-01T00:00:00.000Z"),
      release("web-v3.1.0", "2026-02-01T00:00:00.000Z"),
    ]);
    expect(streams.map((stream) => [stream.tagPrefix, stream.count])).toEqual([
      ["api-v", 2],
      ["web-v", 1],
    ]);
    expect(streams[0]).toMatchObject({
      latestVersion: "api-v1.2.0",
      latestPublishedAt: "2026-03-01T00:00:00.000Z",
      firstPublishedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("dates a stream by the REMOTE clock, not by the order it was handed the samples", () => {
    const streams = detectVersionStreams([
      release("v1.0.0", "2026-01-01T00:00:00.000Z"),
      release("v2.0.0", "2026-05-01T00:00:00.000Z"),
    ]);
    expect(streams[0]?.latestVersion).toBe("v2.0.0");
  });
});

describe("proposeServices — a composition to tick, not a form to fill", () => {
  it("pairs a stream with the package it releases and pre-checks it", () => {
    const suggestions = proposeServices({
      repository: "acme/platform",
      source: "releases",
      versions: [release("api-v1.2.0", "2026-03-01T00:00:00.000Z"), release("web-v3.1.0", "2026-02-01T00:00:00.000Z")],
      packages: [
        { path: "apps/api", name: "api", manifest: "package.json" },
        { path: "apps/web", name: "web", manifest: "package.json" },
      ],
    });
    expect(suggestions).toEqual([
      {
        name: "api",
        path: "apps/api",
        source: "releases",
        tagPrefix: "api-v",
        recommended: true,
        matched: 1,
        latestVersion: "api-v1.2.0",
        latestPublishedAt: "2026-03-01T00:00:00.000Z",
        firstPublishedAt: "2026-03-01T00:00:00.000Z",
      },
      {
        name: "web",
        path: "apps/web",
        source: "releases",
        tagPrefix: "web-v",
        recommended: true,
        matched: 1,
        latestVersion: "web-v3.1.0",
        latestPublishedAt: "2026-02-01T00:00:00.000Z",
        firstPublishedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("offers a repo-wide monorepo's packages under the one stream they all move on, unchecked", () => {
    const suggestions = proposeServices({
      repository: "acme/platform",
      source: "tags",
      versions: [release("v2026.3", "2026-03-01T00:00:00.000Z")],
      packages: [
        { path: "apps/api", name: "api", manifest: "package.json" },
        { path: "packages/core", name: "core", manifest: "package.json" },
      ],
    });
    // The repo-wide stream itself is the first row (it releases the repository); the packages ride it.
    expect(suggestions.map((s) => [s.name, s.tagPrefix, s.recommended, s.path])).toEqual([
      ["platform", "v", true, undefined],
      ["api", "v", false, "apps/api"],
      ["core", "v", false, "packages/core"],
    ]);
  });

  it("never proposes a bare-numeric stream beside prefixed ones — it would swallow their versions", () => {
    const suggestions = proposeServices({
      repository: "acme/platform",
      source: "tags",
      versions: [release("api-v1.0.0"), release("2026.3")],
      packages: [],
    });
    // `tagPrefix: undefined` means "every tag": declaring it here would claim api-v1.0.0 as well.
    expect(suggestions.every((s) => s.tagPrefix !== undefined)).toBe(true);
    expect(suggestions.map((s) => s.tagPrefix)).toEqual(["api-v"]);
  });

  it("leaves a package with nothing to read out of the proposals rather than guessing a stream for it", () => {
    const suggestions = proposeServices({
      repository: "acme/platform",
      source: "releases",
      versions: [release("api-v1.0.0")],
      packages: [
        { path: "apps/api", name: "api", manifest: "package.json" },
        { path: "packages/core", name: "core", manifest: "package.json" },
      ],
    });
    expect(suggestions.map((s) => s.name)).toEqual(["api"]);
  });

  it("still proposes the repository itself when it publishes nothing yet", () => {
    const suggestions = proposeServices({
      repository: "acme/platform",
      source: "releases",
      versions: [],
      packages: [],
    });
    expect(suggestions).toEqual([{ name: "platform", source: "releases", recommended: true, matched: 0 }]);
  });
});

describe("detectPackages — the deployable units in a tree", () => {
  it("finds manifests at component depth and skips the root, vendored and hidden trees", () => {
    expect(
      detectPackages([
        "package.json", // the repository itself — the repo-wide stream already proposes it
        "apps/api/package.json",
        "apps/api/node_modules/left-pad/package.json",
        "services/worker/go.mod",
        "deep/nested/too/far/package.json",
        ".github/actions/thing/package.json",
        "README.md",
      ]),
    ).toEqual([
      { path: "apps/api", name: "api", manifest: "package.json" },
      { path: "services/worker", name: "worker", manifest: "go.mod" },
    ]);
  });
});
