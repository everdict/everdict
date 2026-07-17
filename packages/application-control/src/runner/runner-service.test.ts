import {
  type PairRunnerInput,
  type PairedRunner,
  RUNNER_PROTOCOL_VERSION,
  type ResolvedRunner,
  type RunnerMeta,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { RunnerStore } from "../ports/runner-store.js";
import { RunnerService, runnerUpdateRequired } from "./runner-service.js";

// A minimal in-test RunnerStore (application-control must not depend on @everdict/db). Enough for the version paths.
class FakeRunnerStore implements RunnerStore {
  private readonly byOwner = new Map<string, Map<string, RunnerMeta>>();
  seed(owner: string, meta: RunnerMeta): void {
    const m = this.byOwner.get(owner) ?? new Map<string, RunnerMeta>();
    m.set(meta.id, meta);
    this.byOwner.set(owner, m);
  }
  async pair(_input: PairRunnerInput): Promise<PairedRunner> {
    throw new Error("not used");
  }
  async list(owner: string): Promise<RunnerMeta[]> {
    return [...(this.byOwner.get(owner)?.values() ?? [])];
  }
  async get(owner: string, id: string): Promise<RunnerMeta | null> {
    return this.byOwner.get(owner)?.get(id) ?? null;
  }
  async listByWorkspace(_workspace: string): Promise<RunnerMeta[]> {
    return [...this.byOwner.values()].flatMap((m) => [...m.values()]);
  }
  async remove(): Promise<void> {}
  async touch(): Promise<void> {}
  async setCapabilities(): Promise<void> {}
  async setVersion(owner: string, id: string, version: string, protocol: number): Promise<void> {
    const meta = this.byOwner.get(owner)?.get(id);
    if (meta) this.byOwner.get(owner)?.set(id, { ...meta, version, protocol });
  }
  async resolveByToken(): Promise<ResolvedRunner | null> {
    return null;
  }
}

const meta = (id: string, protocol?: number): RunnerMeta => ({
  id,
  label: id,
  capabilities: [],
  pairedAt: "2026-07-17T00:00:00.000Z",
  ...(protocol !== undefined ? { protocol } : {}),
});

describe("runnerUpdateRequired", () => {
  it("flags a runner whose protocol is below the control plane", () => {
    expect(runnerUpdateRequired(RUNNER_PROTOCOL_VERSION - 1)).toBe(true);
  });
  it("does not flag an up-to-date or newer runner", () => {
    expect(runnerUpdateRequired(RUNNER_PROTOCOL_VERSION)).toBe(false);
    expect(runnerUpdateRequired(RUNNER_PROTOCOL_VERSION + 1)).toBe(false);
  });
  it("does not flag a pre-version runner that reports no protocol (avoids day-one nagging)", () => {
    expect(runnerUpdateRequired(undefined)).toBe(false);
  });
});

describe("RunnerService — version reporting + roster overlay", () => {
  it("reportVersion persists the runner's build/protocol version", async () => {
    const store = new FakeRunnerStore();
    store.seed("u-alice", meta("r1"));
    const svc = new RunnerService(store);
    await svc.reportVersion("u-alice", "r1", "1.2.3", RUNNER_PROTOCOL_VERSION);
    const [r] = await svc.list("u-alice");
    expect(r?.version).toBe("1.2.3");
    expect(r?.protocol).toBe(RUNNER_PROTOCOL_VERSION);
  });

  it("reportVersion ignores a non-integer protocol (malformed self-report) rather than persist garbage", async () => {
    const store = new FakeRunnerStore();
    store.seed("u-alice", meta("r1"));
    const svc = new RunnerService(store);
    await svc.reportVersion("u-alice", "r1", "1.2.3", 1.5);
    const [r] = await svc.list("u-alice");
    expect(r?.protocol).toBeUndefined();
  });

  it("list/listForWorkspace annotate updateRequired for a behind runner, and leave a current one untouched", async () => {
    const store = new FakeRunnerStore();
    store.seed("u-alice", meta("old", RUNNER_PROTOCOL_VERSION - 1));
    store.seed("u-alice", meta("current", RUNNER_PROTOCOL_VERSION));
    const svc = new RunnerService(store);
    const list = await svc.list("u-alice");
    expect(list.find((r) => r.id === "old")?.updateRequired).toBe(true);
    expect(list.find((r) => r.id === "current")?.updateRequired).toBeUndefined();
    const roster = await svc.listForWorkspace("acme");
    expect(roster.find((r) => r.id === "old")?.updateRequired).toBe(true);
  });
});
