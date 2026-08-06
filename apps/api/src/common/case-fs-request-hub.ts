import type { CaseFsAnswer, CaseFsRequest } from "@everdict/contracts";

// The parked-request rendezvous behind the run workbench's self-hosted lane: the control plane cannot exec into
// a runner's sandbox, so RunService.fsTree/fsFile PARK a read here and await; the runner's in-case servicing
// loop drains it via the poll_case_fs_requests / answer_case_fs_request MCP lease tools and answers from inside
// the case. In-memory, single control-plane process — the same scope as the in-memory RunnerHub (a store-backed
// twin rides the EVERDICT_SELF_HOSTED_STORE_HUB follow-up).
interface Parked {
  request: CaseFsRequest;
  resolve: (answer: CaseFsAnswer | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
}

export class CaseFsRequestHub {
  private readonly byRun = new Map<string, Map<string, Parked>>();
  private seq = 0;

  constructor(private readonly timeoutMs = 8000) {}

  // Park one read and await the runner's answer. undefined = nobody answered in time — no live case for the
  // runId, or an old runner without the servicing loop. The caller reads that as "no live sandbox".
  request(runId: string, request: Omit<CaseFsRequest, "id">): Promise<CaseFsAnswer | undefined> {
    const id = `fsreq-${++this.seq}`;
    const lane = this.byRun.get(runId) ?? new Map<string, Parked>();
    this.byRun.set(runId, lane);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        lane.delete(id);
        if (lane.size === 0) this.byRun.delete(runId);
        resolve(undefined);
      }, this.timeoutMs);
      timer.unref?.();
      lane.set(id, { request: { id, ...request }, resolve, timer, delivered: false });
    });
  }

  // The runner's poll — this runId's undelivered requests, marked delivered so a repeat poll does not re-run
  // them (the answer window stays open until the timeout regardless).
  pending(runId: string): CaseFsRequest[] {
    const lane = this.byRun.get(runId);
    if (!lane) return [];
    const out: CaseFsRequest[] = [];
    for (const parked of lane.values()) {
      if (parked.delivered) continue;
      parked.delivered = true;
      out.push(parked.request);
    }
    return out;
  }

  // The runner's answer — resolve the parked promise. An unknown id already timed out (no-op, not an error).
  answer(runId: string, requestId: string, answer: CaseFsAnswer): void {
    const lane = this.byRun.get(runId);
    const parked = lane?.get(requestId);
    if (!lane || !parked) return;
    lane.delete(requestId);
    if (lane.size === 0) this.byRun.delete(runId);
    clearTimeout(parked.timer);
    parked.resolve(answer);
  }
}
