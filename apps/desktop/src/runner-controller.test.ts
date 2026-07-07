import type { RunnerHostStatus } from "@everdict/runner-core";
import { describe, expect, it, vi } from "vitest";
import type { DesktopRunnerStatus } from "./bridge.js";
import { RunnerController, type RunnerControllerDeps, type RunnerMeta } from "./runner-controller.js";

function makeDeps(initialToken: string | null = null, initialMeta: RunnerMeta = {}) {
  let token = initialToken;
  let meta = initialMeta;
  const broadcasts: DesktopRunnerStatus[] = [];
  const hosts: Array<{ started: boolean; stopped: boolean; onStatus: (s: RunnerHostStatus) => void }> = [];
  const deps: RunnerControllerDeps = {
    loadToken: () => token,
    saveToken: (t) => {
      token = t;
    },
    clearToken: () => {
      token = null;
    },
    loadMeta: () => meta,
    saveMeta: (m) => {
      meta = m;
    },
    makeHost: ({ onStatus }) => {
      const h = {
        started: false,
        stopped: false,
        onStatus,
        start: async () => {
          h.started = true;
          onStatus({ state: "idle", activeJobs: 0, capabilities: ["repo"] });
        },
        stop: async () => {
          h.stopped = true;
        },
      };
      hosts.push(h);
      return h;
    },
    defaultApiUrl: "http://localhost:8787",
    broadcast: (s) => broadcasts.push(s),
  };
  return { deps, broadcasts, hosts, getToken: () => token, getMeta: () => meta };
}

describe("RunnerController", () => {
  it("startFromStore — 토큰 없으면 미페어 브로드캐스트만, 호스트 안 만든다", async () => {
    const { deps, broadcasts, hosts } = makeDeps();
    await new RunnerController(deps).startFromStore();
    expect(hosts).toHaveLength(0);
    expect(broadcasts.at(-1)).toMatchObject({ paired: false, state: "off" });
  });

  it("startFromStore — 저장된 토큰으로 조용히 복원(메타 runnerId 유지)", async () => {
    const { deps, broadcasts, hosts } = makeDeps("rnr_saved", { runnerId: "r9" });
    const c = new RunnerController(deps);
    await c.startFromStore();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.started).toBe(true);
    expect(broadcasts.at(-1)).toMatchObject({ paired: true, runnerId: "r9", state: "idle" });
  });

  it("pair — 토큰 저장 + 메타 저장 + 호스트 시작; 재페어 시 기존 호스트는 정리", async () => {
    const { deps, hosts, getToken, getMeta } = makeDeps();
    const c = new RunnerController(deps);
    await c.pair({ token: "rnr_a", runnerId: "r1", apiUrl: "http://cp:8787" });
    expect(getToken()).toBe("rnr_a");
    expect(getMeta()).toEqual({ runnerId: "r1", apiUrl: "http://cp:8787" });
    await c.pair({ token: "rnr_b", runnerId: "r2" });
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.stopped).toBe(true);
    expect(c.status()).toMatchObject({ paired: true, runnerId: "r2" });
  });

  it("pair — saveToken 이 throw(safeStorage 불가)하면 페어 상태로 넘어가지 않는다", async () => {
    const { deps, hosts } = makeDeps();
    deps.saveToken = () => {
      throw new Error("safeStorage 불가");
    };
    const c = new RunnerController(deps);
    await expect(c.pair({ token: "rnr_x" })).rejects.toThrow(/safeStorage/);
    expect(hosts).toHaveLength(0);
    expect(c.status().paired).toBe(false);
  });

  it("unpair — 토큰/메타 폐기 + 즉시 off 브로드캐스트(호스트 정지는 백그라운드)", async () => {
    const { deps, broadcasts, hosts, getToken } = makeDeps("rnr_saved", { runnerId: "r9" });
    const c = new RunnerController(deps);
    await c.startFromStore();
    await c.unpair();
    expect(getToken()).toBeNull();
    expect(broadcasts.at(-1)).toMatchObject({ paired: false, state: "off", activeJobs: 0 });
    await vi.waitFor(() => expect(hosts[0]?.stopped).toBe(true));
  });

  it("shutdown — 호스트 정지를 기다린다", async () => {
    const { deps, hosts } = makeDeps("rnr_saved");
    const c = new RunnerController(deps);
    await c.startFromStore();
    await c.shutdown();
    expect(hosts[0]?.stopped).toBe(true);
  });
});
