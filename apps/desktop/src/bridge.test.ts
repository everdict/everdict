import { describe, expect, it, vi } from "vitest";
import { BRIDGE_CHANNELS, type BridgeDeps, type IpcMainLike, registerBridge, senderAllowed } from "./bridge.js";

const WEB = "https://app.everdict.dev";

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
  it("allows only web-origin frames", () => {
    expect(senderAllowed(`${WEB}/acme/account`, WEB)).toBe(true);
    expect(senderAllowed("https://keycloak.everdict.dev/auth", WEB)).toBe(false);
    expect(senderAllowed(undefined, WEB)).toBe(false);
    expect(senderAllowed("not-a-url", WEB)).toBe(false);
  });
});

describe("registerBridge", () => {
  it("blocks all channels for calls from another origin (e.g. an OAuth page)", () => {
    const ipc = fakeIpc();
    registerBridge(ipc, deps());
    for (const ch of [BRIDGE_CHANNELS.appInfo, BRIDGE_CHANNELS.pair, BRIDGE_CHANNELS.unpair, BRIDGE_CHANNELS.status]) {
      expect(() => ipc.invoke(ch, "https://github.com/login")).toThrow(/origin/);
      expect(() => ipc.invoke(ch, undefined)).toThrow(/origin/);
    }
  });

  it("validates the pairing payload at the Zod boundary (rejects a non-rnr_ token / a malformed URL)", async () => {
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

  it("returns status/appInfo for a web-origin call", async () => {
    const ipc = fakeIpc();
    registerBridge(ipc, deps());
    expect(ipc.invoke(BRIDGE_CHANNELS.status, `${WEB}/a`)).toMatchObject({ paired: false, state: "off" });
    await expect(ipc.invoke(BRIDGE_CHANNELS.appInfo, `${WEB}/a`)).resolves.toMatchObject({ hostname: "host" });
  });
});
