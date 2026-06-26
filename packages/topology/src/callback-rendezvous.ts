import type { CallbackRendezvous } from "./front-door-driver.js";

// in-process 콜백 랑데부 — callback 완료 모델용. run 별 inbound POST 본문을 큐잉하고, 대기자(드라이버)에게 전달한다.
// 전송(HTTP 수신)은 분리: 수신기(셀프호스트 runner / control-plane)가 매칭 POST 를 받아 deliver(runId, body) 를 호출.
// 단일 호스트/프로세스(셀프호스트·dev)용. SaaS 는 control-plane 엔드포인트 + 스토어로 같은 인터페이스를 구현한다.
// 설계: docs/architecture/completion-stream-callback.md.
export class InProcessCallbackRendezvous implements CallbackRendezvous {
  // runId → 아직 소비 안 된 inbound 본문 큐(대기자보다 POST 가 먼저 온 경우).
  private readonly pending = new Map<string, unknown[]>();
  // runId → 대기 중 resolver(POST 가 대기자보다 먼저 없을 때). run 당 대기자는 하나(드라이버 1).
  private readonly waiters = new Map<string, (body: unknown) => void>();

  constructor(private readonly baseUrl: string) {}

  url(runId: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${runId}`;
  }

  // 인바운드 POST 전달 — 수신기가 호출. 대기자가 있으면 즉시 깨우고, 없으면 큐잉(순서 보존).
  deliver(runId: string, body: unknown): void {
    const waiter = this.waiters.get(runId);
    if (waiter) {
      this.waiters.delete(runId);
      waiter(body);
      return;
    }
    const queue = this.pending.get(runId) ?? [];
    queue.push(body);
    this.pending.set(runId, queue);
  }

  // 다음 inbound POST 를 기다린다. 이미 큐에 있으면 즉시, 없으면 timeoutMs 까지 대기(초과 시 undefined).
  async wait(runId: string, timeoutMs: number): Promise<{ body: unknown } | undefined> {
    const queue = this.pending.get(runId);
    if (queue && queue.length > 0) {
      const body = queue.shift();
      if (queue.length === 0) this.pending.delete(runId);
      return { body };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(runId) === onBody) this.waiters.delete(runId);
        resolve(undefined);
      }, timeoutMs);
      const onBody = (body: unknown): void => {
        clearTimeout(timer);
        resolve({ body });
      };
      this.waiters.set(runId, onBody);
    });
  }
}
