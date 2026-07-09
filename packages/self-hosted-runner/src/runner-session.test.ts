import { describe, expect, it } from "vitest";
import { type ConnectClient, ResilientMcpSession, type RunnerClient } from "./runner-session.js";

// A fake RunnerClient scripting per-call behavior — records close calls.
function fakeClient(
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>,
  onClose: () => void,
): RunnerClient {
  return {
    callTool,
    async close() {
      onClose();
    },
  };
}

describe("ResilientMcpSession — session reinitialization on API restart (robustness)", () => {
  it("normal: connects once, makes calls, and reuses the same session (no reconnect)", async () => {
    let connects = 0;
    const connect: ConnectClient = async () => {
      connects++;
      return fakeClient(
        async () => ({ text: "ok", isError: false }),
        () => {},
      );
    };
    const s = new ResilientMcpSession(connect);
    expect(await s.call("lease_job", {})).toEqual({ text: "ok", isError: false });
    expect(await s.call("lease_job", {})).toEqual({ text: "ok", isError: false });
    expect(connects).toBe(1);
  });

  it("regression: on a stale session (callTool throws), auto-reconnect then retry succeeds (wedge prevention)", async () => {
    // The first session is dead (callTool throws = stale-session 400 after an API restart). The second session is fine.
    let connects = 0;
    const closed: number[] = [];
    const connect: ConnectClient = async () => {
      const n = ++connects;
      return fakeClient(
        async () => {
          if (n === 1) throw new Error("HTTP 400: unknown mcp-session-id");
          return { text: "leased", isError: false };
        },
        () => closed.push(n),
      );
    };
    const s = new ResilientMcpSession(connect);
    const r = await s.call("lease_job", { wait_ms: 1 });
    expect(r).toEqual({ text: "leased", isError: false }); // success after reinitialization
    expect(connects).toBe(2); // dead session discarded + new session
    expect(closed).toContain(1); // the dead session is closed (leak prevention)
  });

  it("an app-level error (isError result) doesn't trigger a reconnect", async () => {
    let connects = 0;
    const connect: ConnectClient = async () => {
      connects++;
      return fakeClient(
        async () => ({ text: "permission denied", isError: true }),
        () => {},
      );
    };
    const s = new ResilientMcpSession(connect);
    const r = await s.call("lease_job", {});
    expect(r.isError).toBe(true);
    expect(connects).toBe(1); // not a throw, so the session stays as-is
  });

  it("if the retry also fails, throw and discard the session (the next call reconnects fresh)", async () => {
    let connects = 0;
    const connect: ConnectClient = async () => {
      connects++;
      return fakeClient(
        async () => {
          throw new Error("keeps disconnecting");
        },
        () => {},
      );
    };
    const s = new ResilientMcpSession(connect);
    await expect(s.call("lease_job", {})).rejects.toThrow("keeps disconnecting");
    expect(connects).toBe(2); // initial + one reinitialization
    // Since it's discarded, the next call attempts a fresh connection again.
    await expect(s.call("lease_job", {})).rejects.toThrow();
    expect(connects).toBe(4);
  });

  it("if the connection itself fails (API down), throw on the first call — the caller (poll loop) backs off", async () => {
    const connect: ConnectClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const s = new ResilientMcpSession(connect);
    await expect(s.call("lease_job", {})).rejects.toThrow("ECONNREFUSED");
  });
});
