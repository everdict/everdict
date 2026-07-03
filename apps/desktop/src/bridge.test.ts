import { describe, expect, it, vi } from "vitest";
import { BRIDGE_CHANNELS, type BridgeDeps, type IpcMainLike, registerBridge, senderAllowed } from "./bridge.js";

const WEB = "https://app.assay.dev";

function fakeIpc(): IpcMainLike & {
  invoke: (channel: string, frameUrl: string | undefined, payload?: unknown) => unknown;
} {
  const handlers = new Map<string, (event: { senderFrame: { url: string } | null }, payload: unknown) => unknown>();
  return {
    handle: (ch, l) => {
      handlers.set(ch, l);
    },
    invoke: (ch, frameUrl, payload) => {
      const h = handlers.get(ch);
      if (!h) throw new Error(`no handler: ${ch}`);
      return h({ senderFrame: frameUrl === undefined ? null : { url: frameUrl } }, payload);
    },
  };
}

function deps(): BridgeDeps & { pair: ReturnType<typeof vi.fn> } {
  return {
    webOrigin: () => WEB,
    appInfo: async () => ({ version: "0", platform: "linux", hostname: "host", capabilities: ["repo"] }),
    pair: vi.fn(async () => {}),
    unpair: async () => {},
    status: () => ({ paired: false, state: "off", activeJobs: 0, capabilities: [] }),
  };
}

describe("senderAllowed", () => {
  it("웹 origin 프레임만 허용", () => {
    expect(senderAllowed(`${WEB}/acme/account`, WEB)).toBe(true);
    expect(senderAllowed("https://keycloak.assay.dev/auth", WEB)).toBe(false);
    expect(senderAllowed(undefined, WEB)).toBe(false);
    expect(senderAllowed("not-a-url", WEB)).toBe(false);
  });
});

describe("registerBridge", () => {
  it("다른 origin(예: OAuth 페이지)에서의 호출은 전 채널 차단", () => {
    const ipc = fakeIpc();
    registerBridge(ipc, deps());
    for (const ch of [BRIDGE_CHANNELS.appInfo, BRIDGE_CHANNELS.pair, BRIDGE_CHANNELS.unpair, BRIDGE_CHANNELS.status]) {
      expect(() => ipc.invoke(ch, "https://github.com/login")).toThrow(/origin/);
      expect(() => ipc.invoke(ch, undefined)).toThrow(/origin/);
    }
  });

  it("페어링 페이로드는 Zod 경계 검증(rnr_ 아닌 토큰/이상 URL 거부)", async () => {
    const ipc = fakeIpc();
    const d = deps();
    registerBridge(ipc, d);
    expect(() => ipc.invoke(BRIDGE_CHANNELS.pair, `${WEB}/a`, { token: "ak_x" })).toThrow();
    expect(() => ipc.invoke(BRIDGE_CHANNELS.pair, `${WEB}/a`, { token: "rnr_x", apiUrl: "nope" })).toThrow();
    await ipc.invoke(BRIDGE_CHANNELS.pair, `${WEB}/a`, {
      token: "rnr_x",
      runnerId: "r1",
      apiUrl: "http://localhost:8787",
    });
    expect(d.pair).toHaveBeenCalledWith({ token: "rnr_x", runnerId: "r1", apiUrl: "http://localhost:8787" });
  });

  it("웹 origin 호출은 status/appInfo 를 돌려준다", async () => {
    const ipc = fakeIpc();
    registerBridge(ipc, deps());
    expect(ipc.invoke(BRIDGE_CHANNELS.status, `${WEB}/a`)).toMatchObject({ paired: false, state: "off" });
    await expect(ipc.invoke(BRIDGE_CHANNELS.appInfo, `${WEB}/a`)).resolves.toMatchObject({ hostname: "host" });
  });
});
