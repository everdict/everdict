import type { EnvSnapshot } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { type ArtifactStore, InMemoryArtifactStore, offloadSnapshot } from "./artifact-store.js";

describe("offloadSnapshot (os-use 스크린샷 → object storage)", () => {
  it("os-use 동봉 base64 를 스토어로 오프로드 → screenshotRef=URL, screenshot 비움(레코드 슬림)", async () => {
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
    expect(out.screenshot).toBe(""); // base64 제거됨
    expect(out.screenshotRef).toBe("memory://artifacts/runs/r1.png"); // URL 로 치환
    // 바이트가 실제로 저장됨(원본 디코드와 동일).
    expect(Buffer.from(store.objects.get("runs/r1.png")?.data ?? new Uint8Array()).toString()).toBe("PNGBYTES");
    expect(store.objects.get("runs/r1.png")?.contentType).toBe("image/png");
  });

  it("store 없으면 그대로(폴백: base64 인라인 — dev)", async () => {
    const snap: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "QUJD", windows: [] };
    const out = await offloadSnapshot(snap, undefined, "k.png");
    expect(out).toEqual(snap); // 변형 없음
  });

  it("os-use 가 아니거나 base64 없으면 그대로", async () => {
    const store = new InMemoryArtifactStore();
    const repo: EnvSnapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" };
    expect(await offloadSnapshot(repo, store, "k.png")).toEqual(repo);
    const empty: EnvSnapshot = { kind: "os-use", screenshotRef: "/tmp/s.png", screenshot: "", windows: [] };
    expect(await offloadSnapshot(empty, store, "k.png")).toEqual(empty);
    expect(store.objects.size).toBe(0); // 아무것도 안 올림
  });

  it("ArtifactStore 는 임의 구현 주입 가능(키/콘텐츠타입 전달)", async () => {
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
