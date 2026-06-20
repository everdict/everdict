import type { ComputeHandle, ExecOpts, ExecResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import { OsUseEnvironment } from "./os-use.js";

function mock(): { compute: ComputeHandle; calls: Array<{ cmd: string; display?: string }> } {
  const calls: Array<{ cmd: string; display?: string }> = [];
  const compute: ComputeHandle = {
    async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
      calls.push({ cmd, display: opts?.env?.DISPLAY });
      const stdout = cmd.startsWith("wmctrl")
        ? "Hermes Desktop\nxclock\n"
        : cmd.startsWith("base64")
          ? "UE5HYmFzZTY0\n" // 스크린샷 base64 (mock)
          : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { compute, calls };
}

describe("OsUseEnvironment (데스크탑 컴퓨터-유즈)", () => {
  it("seed: setup 을 DISPLAY 주입해 실행, snapshot: 스크린샷 캡처 + 창 목록", async () => {
    const env = new OsUseEnvironment();
    const { compute, calls } = mock();
    await env.seed(compute, {
      kind: "os-use",
      display: ":99",
      setup: ["Xvfb :99 -screen 0 1024x768x24 &", "hermes &"],
      screenshotPath: "/tmp/shot.png",
    });
    // setup 명령이 DISPLAY=:99 로 실행됨.
    expect(calls.map((c) => c.cmd)).toEqual(["Xvfb :99 -screen 0 1024x768x24 &", "hermes &"]);
    expect(calls.every((c) => c.display === ":99")).toBe(true);

    const snap = await env.snapshot(compute);
    expect(snap.kind).toBe("os-use");
    expect(snap.screenshotRef).toBe("/tmp/shot.png"); // 설정 경로
    expect(snap.screenshot).toBe("UE5HYmFzZTY0"); // 스크린샷 PNG 를 base64 로 동봉(결과 밖으로 운반)
    expect(snap.windows).toEqual(["Hermes Desktop", "xclock"]); // wmctrl 파싱
    // 스크린샷 캡처(scrot) + base64 읽기 명령이 실행됨.
    expect(calls.some((c) => c.cmd.includes("scrot") && c.cmd.includes("/tmp/shot.png"))).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("base64") && c.cmd.includes("/tmp/shot.png"))).toBe(true);
  });

  it("os-use 가 아닌 spec 은 거부", async () => {
    const { compute } = mock();
    await expect(new OsUseEnvironment().seed(compute, { kind: "prompt" })).rejects.toThrow();
  });
});
