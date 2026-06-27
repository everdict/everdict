import { describe, expect, it } from "vitest";
import { type ConnectClient, ResilientMcpSession, type RunnerClient } from "./runner-session.js";

// 호출별 동작을 스크립트한 가짜 RunnerClient — close 호출을 기록.
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

describe("ResilientMcpSession — API 재시작 시 세션 재초기화(robustness)", () => {
  it("정상: 한 번 연결해 호출하고, 같은 세션을 재사용한다(재연결 없음)", async () => {
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

  it("회귀: stale 세션(callTool throw)이면 자동 재connect 후 재시도해 성공한다(wedge 방지)", async () => {
    // 첫 세션은 죽어 있음(callTool 이 throw = API 재시작 후 stale-session 400). 두 번째 세션은 정상.
    let connects = 0;
    const closed: number[] = [];
    const connect: ConnectClient = async () => {
      const n = ++connects;
      return fakeClient(
        async () => {
          if (n === 1) throw new Error("HTTP 400: 알 수 없는 mcp-session-id");
          return { text: "leased", isError: false };
        },
        () => closed.push(n),
      );
    };
    const s = new ResilientMcpSession(connect);
    const r = await s.call("lease_job", { wait_ms: 1 });
    expect(r).toEqual({ text: "leased", isError: false }); // 재초기화 후 성공
    expect(connects).toBe(2); // 죽은 세션 폐기 + 새 세션
    expect(closed).toContain(1); // 죽은 세션은 close 됨(누수 방지)
  });

  it("앱-레벨 오류(isError 결과)는 재연결을 유발하지 않는다", async () => {
    let connects = 0;
    const connect: ConnectClient = async () => {
      connects++;
      return fakeClient(
        async () => ({ text: "권한 없음", isError: true }),
        () => {},
      );
    };
    const s = new ResilientMcpSession(connect);
    const r = await s.call("lease_job", {});
    expect(r.isError).toBe(true);
    expect(connects).toBe(1); // throw 가 아니므로 세션은 그대로
  });

  it("재시도도 실패하면 throw 하고 세션을 폐기한다(다음 호출이 새로 연결)", async () => {
    let connects = 0;
    const connect: ConnectClient = async () => {
      connects++;
      return fakeClient(
        async () => {
          throw new Error("계속 끊김");
        },
        () => {},
      );
    };
    const s = new ResilientMcpSession(connect);
    await expect(s.call("lease_job", {})).rejects.toThrow("계속 끊김");
    expect(connects).toBe(2); // 최초 + 재초기화 1회
    // 폐기됐으므로 다음 호출은 또 새로 연결을 시도한다.
    await expect(s.call("lease_job", {})).rejects.toThrow();
    expect(connects).toBe(4);
  });

  it("연결 자체가 실패하면(API down) 첫 호출에서 throw — 호출자(폴 루프)가 backoff", async () => {
    const connect: ConnectClient = async () => {
      throw new Error("ECONNREFUSED");
    };
    const s = new ResilientMcpSession(connect);
    await expect(s.call("lease_job", {})).rejects.toThrow("ECONNREFUSED");
  });
});
