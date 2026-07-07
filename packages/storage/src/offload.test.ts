import type { EnvSnapshot } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { type ArtifactStore, InMemoryArtifactStore, offloadSnapshot } from "./artifact-store.js";

describe("offloadSnapshot (os-use screenshot → object storage)", () => {
  it("offloads the embedded os-use base64 to the store → screenshotRef=URL, clears screenshot (slim record)", async () => {
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const snap: EnvSnapshot = {
      kind: "os-use",
      screenshotRef: "/tmp/osuse.png",
      screenshot: Buffer.from("PNGBYTES").toString("base64"),
      windows: [],
    };
    const out = await offloadSnapshot(snap, store, "runs/r1.png");
    expect(out.kind).toBe("os-use");
    if (out.kind !== "os-use") throw new Error("kind");
    expect(out.screenshot).toBe(""); // base64 removed
    expect(out.screenshotRef).toBe("memory://artifacts/runs/r1.png"); // replaced with the URL
    // the bytes are actually stored (same as the original decode).
    expect(Buffer.from(store.objects.get("runs/r1.png")?.data ?? new Uint8Array()).toString()).toBe("PNGBYTES");
    expect(store.objects.get("runs/r1.png")?.contentType).toBe("image/png");
  });

  it("unchanged without a store (fallback: inline base64 — dev)", async () => {
    const snap: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "QUJD", windows: [] };
    const out = await offloadSnapshot(snap, undefined, "k.png");
    expect(out).toEqual(snap); // no transformation
  });

  it("unchanged when not os-use or no base64", async () => {
    const store = new InMemoryArtifactStore();
    const repo: EnvSnapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" };
    expect(await offloadSnapshot(repo, store, "k.png")).toEqual(repo);
    const empty: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "", windows: [] };
    expect(await offloadSnapshot(empty, store, "k.png")).toEqual(empty);
    expect(store.objects.size).toBe(0); // nothing uploaded
  });

  it("ArtifactStore allows injecting an arbitrary implementation (passes key/content type)", async () => {
    const calls: Array<{ key: string; contentType: string; len: number }> = [];
    const store: ArtifactStore = {
      async put(key, data, contentType) {
        calls.push({ key, contentType, len: data.byteLength });
        return `s3://bucket/${key}`;
      },
    };
    const snap: EnvSnapshot = { kind: "os-use", screenshotRef: "x", screenshot: "QUJDRA==", windows: [] };
    const out = await offloadSnapshot(snap, store, "scorecards/sc1/case1.png");
    expect(out.kind === "os-use" && out.screenshotRef).toBe("s3://bucket/scorecards/sc1/case1.png");
    expect(calls[0]).toEqual({ key: "scorecards/sc1/case1.png", contentType: "image/png", len: 4 }); // "ABCD"=4 bytes
  });
});
