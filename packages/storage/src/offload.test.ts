import {
  type ArtifactStore,
  DOM_INLINE_MAX,
  offloadSnapshot,
  refreshSnapshotRefs,
} from "@everdict/application-control";
import type { EnvSnapshot } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "./artifact-store.js";

describe("offloadSnapshot (snapshot media → object storage: screenshot + DOM)", () => {
  it("offloads the embedded os-use base64 to the store → screenshotRef=URL, clears screenshot (slim record)", async () => {
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const snap: EnvSnapshot = {
      kind: "os-use",
      screenshotRef: "/tmp/osuse.png",
      screenshot: Buffer.from("PNGBYTES").toString("base64"),
      windows: [],
    };
    const out = await offloadSnapshot(snap, store, "runs/r1");
    expect(out.kind).toBe("os-use");
    if (out.kind !== "os-use") throw new Error("kind");
    expect(out.screenshot).toBe(""); // base64 removed
    expect(out.screenshotRef).toBe("memory://artifacts/runs/r1.png"); // replaced with the URL
    // the bytes are actually stored (same as the original decode).
    expect(Buffer.from(store.objects.get("runs/r1.png")?.data ?? new Uint8Array()).toString()).toBe("PNGBYTES");
    expect(store.objects.get("runs/r1.png")?.contentType).toBe("image/png");
  });

  it("offloads a BROWSER snapshot's embedded screenshot too (WebVoyager-style VLM input, slim record)", async () => {
    // The front-door now embeds the page screenshot in the browser snapshot for VLM judging; offload it like os-use.
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const snap: EnvSnapshot = {
      kind: "browser",
      url: "https://shop.example/cart",
      dom: "<html>…</html>",
      screenshot: Buffer.from("PAGEPNG").toString("base64"),
      console: [],
    };
    const out = await offloadSnapshot(snap, store, "runs/b1");
    expect(out.kind).toBe("browser");
    if (out.kind !== "browser") throw new Error("kind");
    expect(out.screenshot).toBe(""); // base64 removed from the record
    expect(out.screenshotRef).toBe("memory://artifacts/runs/b1.png"); // replaced with the URL
    expect(out.dom).toBe("<html>…</html>"); // a SMALL DOM stays inline (below the cap)
    expect(out.domRef).toBeUndefined();
    expect(Buffer.from(store.objects.get("runs/b1.png")?.data ?? new Uint8Array()).toString()).toBe("PAGEPNG");
  });

  it("offloads a LARGE browser DOM to a ref, keeping an inline preview — the full DOM stays fetchable", async () => {
    const store = new InMemoryArtifactStore("memory://artifacts/");
    const bigDom = `<html>${"x".repeat(20_000)}</html>`; // > DOM_INLINE_MAX
    const snap: EnvSnapshot = { kind: "browser", url: "u", dom: bigDom, console: [] };
    const out = await offloadSnapshot(snap, store, "runs/b2");
    if (out.kind !== "browser") throw new Error("kind");
    expect(out.domRef).toBe("memory://artifacts/runs/b2.dom.html"); // full DOM offloaded
    expect(out.dom).toBe(bigDom.slice(0, DOM_INLINE_MAX)); // inline preview capped
    expect(out.dom.length).toBe(DOM_INLINE_MAX);
    // the FULL DOM is stored (recoverable), not just the preview.
    expect(Buffer.from(store.objects.get("runs/b2.dom.html")?.data ?? new Uint8Array()).toString()).toBe(bigDom);
    expect(store.objects.get("runs/b2.dom.html")?.contentType).toBe("text/html; charset=utf-8");
  });

  it("unchanged without a store (fallback: inline base64 — dev)", async () => {
    const snap: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "QUJD", windows: [] };
    const out = await offloadSnapshot(snap, undefined, "k");
    expect(out).toEqual(snap); // no transformation
  });

  it("unchanged when there is no media to offload (repo, empty screenshot, small DOM)", async () => {
    const store = new InMemoryArtifactStore();
    const repo: EnvSnapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" };
    expect(await offloadSnapshot(repo, store, "k")).toEqual(repo);
    const empty: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "", windows: [] };
    expect(await offloadSnapshot(empty, store, "k")).toEqual(empty);
    expect(store.objects.size).toBe(0); // nothing uploaded
  });

  it("ArtifactStore allows injecting an arbitrary implementation (passes key/content type)", async () => {
    const calls: Array<{ key: string; contentType: string; len: number }> = [];
    const store: ArtifactStore = {
      async put(key, data, contentType) {
        calls.push({ key, contentType, len: data.byteLength });
        return `s3://bucket/${key}`;
      },
      async get() {
        return undefined;
      },
      async publicUrlFor() {
        return undefined;
      },
    };
    const snap: EnvSnapshot = { kind: "os-use", screenshotRef: "x", screenshot: "QUJDRA==", windows: [] };
    const out = await offloadSnapshot(snap, store, "scorecards/sc1/case1");
    expect(out.kind === "os-use" && out.screenshotRef).toBe("s3://bucket/scorecards/sc1/case1.png");
    expect(calls[0]).toEqual({ key: "scorecards/sc1/case1.png", contentType: "image/png", len: 4 }); // "ABCD"=4 bytes
  });
});

describe("refreshSnapshotRefs (display twin: the record's refs → links a browser can open)", () => {
  // Stored refs are server handles on the in-network endpoint; the public twin is what a page may render.
  const store: ArtifactStore = {
    async put(key) {
      return `http://minio:9000/bucket/${key}`;
    },
    async get() {
      return undefined;
    },
    async publicUrlFor(ref) {
      return ref.startsWith("http://minio:9000/") ? ref.replace("http://minio:9000", "https://cdn.example") : undefined;
    },
  };

  it("re-mints screenshotRef and domRef, leaving the rest of the snapshot alone", async () => {
    const snap: EnvSnapshot = {
      kind: "browser",
      url: "https://shop.example/cart",
      dom: "<html>preview</html>",
      domRef: "http://minio:9000/bucket/runs/b1.dom.html",
      screenshotRef: "http://minio:9000/bucket/runs/b1.png",
      console: [],
    };
    const out = await refreshSnapshotRefs(snap, store);
    if (out.kind !== "browser") throw new Error("kind");
    expect(out.screenshotRef).toBe("https://cdn.example/bucket/runs/b1.png");
    expect(out.domRef).toBe("https://cdn.example/bucket/runs/b1.dom.html");
    expect(out.dom).toBe("<html>preview</html>");
    expect(out.url).toBe("https://shop.example/cart");
  });

  it("keeps a ref this store doesn't recognize, and is a no-op without a store", async () => {
    const foreign: EnvSnapshot = {
      kind: "os-use",
      screenshot: "",
      screenshotRef: "https://someone-else.example/x.png",
      windows: [],
    };
    expect(await refreshSnapshotRefs(foreign, store)).toEqual(foreign);
    expect(await refreshSnapshotRefs(foreign, undefined)).toEqual(foreign);
  });
});
