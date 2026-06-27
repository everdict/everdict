import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// 러너가 거는 단일 MCP tool 호출의 결과(텍스트 + 에러여부). 전송/세션 오류는 ResilientMcpSession 이 흡수한다.
export interface ToolResult {
  text: string;
  isError: boolean;
}

// 연결된 MCP 클라이언트 한 세션. ResilientMcpSession 이 죽은 세션을 버리고 새로 만들 때의 단위(테스트는 가짜를 주입).
export interface RunnerClient {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

// 새 세션을 만들어 연결(=initialize)하는 팩터리. 실패하면 throw(호출자가 backoff).
export type ConnectClient = () => Promise<RunnerClient>;

// 실 구현 — rnr_ 토큰으로 /mcp 에 connect 하는 새 Client + StreamableHTTP transport.
// connect() 가 initialize 를 보내 새 mcp-session-id 를 발급받는다 → 매 재연결마다 신선한 세션.
export function mcpConnect(mcpUrl: URL, token: string): ConnectClient {
  return async () => {
    const client = new Client({ name: "assay-runner", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return {
      async callTool(name, args) {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
        return { text, isError: r.isError === true };
      },
      async close() {
        await client.close().catch(() => {});
      },
    };
  };
}

// 러너 MCP 세션 — API 재시작/일시 단절에도 wedge 되지 않도록 세션을 자동 재초기화한다.
//
// 문제: control plane 은 stateful MCP 세션을 인메모리 Map(server.ts)으로 들고 있어, API 가 재시작하면 러너가
// 쥔 mcp-session-id 가 사라진다. 그 죽은 세션으로 보낸 tool 호출은 400(stale session)/404/연결거부로 실패하는데,
// 기존 러너는 같은 트랜스포트로 무한 재시도만 해서 영영 복구되지 못했다(wedge — lease 실패 로그만 반복).
//
// 해결: callTool 이 throw(=전송/세션 오류)하면 죽은 세션을 버리고 새 Client+transport 로 재connect(=initialize
// 재실행 → 새 세션 id)한 뒤 그 호출만 1회 재시도한다. 앱-레벨 오류는 throw 가 아니라 isError 결과로 돌아오므로
// 재연결을 유발하지 않는다. 모든 tool 호출(lease/submit/heartbeat/fail)을 이 한 곳으로 일반화 — 한 번의 API
// 재시작이 러너를 wedge 시키지 않는다. 재시도도 실패하면 throw(호출자=폴 루프가 backoff 후 다음 호출에서 또 재연결).
export class ResilientMcpSession {
  private current: RunnerClient | null = null;
  private connecting: Promise<RunnerClient> | null = null;

  constructor(private readonly connect: ConnectClient) {}

  // 현재 세션 보장(없으면 1회 connect). 동시 호출은 같은 in-flight connect 를 공유 → 재연결 폭주 방지.
  private async ensure(): Promise<RunnerClient> {
    if (this.current) return this.current;
    if (!this.connecting) {
      this.connecting = this.connect().then(
        (c) => {
          this.current = c;
          this.connecting = null;
          return c;
        },
        (e) => {
          this.connecting = null;
          throw e;
        },
      );
    }
    return this.connecting;
  }

  // 초기 연결을 미리 시도(배너용). 실패는 throw — 호출자가 경고만 찍고 폴 루프에서 재시도하면 된다.
  async ensureConnected(): Promise<void> {
    await this.ensure();
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.ensure();
    try {
      return await client.callTool(name, args);
    } catch {
      // 전송/세션 오류 — 죽은 세션을 버리고 재초기화 후 1회 재시도.
      await this.reset();
      const fresh = await this.ensure();
      try {
        return await fresh.callTool(name, args);
      } catch (retryErr) {
        await this.reset(); // 재시도도 실패 → 세션 폐기(다음 호출이 새로 연결)
        throw retryErr;
      }
    }
  }

  private async reset(): Promise<void> {
    const c = this.current;
    this.current = null;
    if (c) await c.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
