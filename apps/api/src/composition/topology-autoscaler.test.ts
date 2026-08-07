import type { LeaderElector } from "@everdict/application-control";
import { soleLeader } from "@everdict/application-control";
import { BackendRegistry, type Scheduler } from "@everdict/backends";
import { describe, expect, it, vi } from "vitest";
import { startTopologyPoolAutoscaler } from "./topology-autoscaler.js";

const follower: LeaderElector = { isLeader: () => false, start: async () => {}, stop: async () => {} };
const scheduler = { queueEntries: () => [] } as unknown as Scheduler;

describe("topology pool autoscaler — one scaling decision per cluster, not per replica", () => {
  it("a follower replica never looks at the pools, so it cannot rewrite a shared deployment's replicas", async () => {
    const backends = new BackendRegistry();
    const roster = vi.spyOn(backends, "names");

    const autoscaler = startTopologyPoolAutoscaler({ backends, scheduler, leader: follower });
    await autoscaler.tick();
    autoscaler.stop();

    expect(roster).not.toHaveBeenCalled();
  });

  it("the leader (and a single-process control plane) walks the live roster as before", async () => {
    const backends = new BackendRegistry();
    const roster = vi.spyOn(backends, "names");

    const autoscaler = startTopologyPoolAutoscaler({ backends, scheduler, leader: soleLeader });
    await autoscaler.tick();
    autoscaler.stop();

    expect(roster).toHaveBeenCalled();
  });
});
