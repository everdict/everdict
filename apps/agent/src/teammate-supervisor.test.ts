import { describe, expect, it, vi } from "vitest";
import { TeammateSupervisor } from "./teammate-supervisor.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("TeammateSupervisor", () => {
  it("registers, lists, and unregisters teammates", () => {
    const sup = new TeammateSupervisor(async () => {});
    sup.register("s1", "researcher");
    sup.register("s2", "analyst");
    expect(sup.isTeammate("s1")).toBe(true);
    expect(sup.list()).toEqual([
      { sessionId: "s1", name: "researcher" },
      { sessionId: "s2", name: "analyst" },
    ]);
    sup.unregister("s1");
    expect(sup.isTeammate("s1")).toBe(false);
  });

  it("wakes a registered teammate's turn, and is a no-op for an unregistered one", async () => {
    const runTurn = vi.fn(async () => {});
    const sup = new TeammateSupervisor(runTurn);
    sup.wake("unknown"); // no-op
    sup.register("s1", "researcher");
    sup.wake("s1");
    await tick();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith("s1");
  });

  it("serializes turns and coalesces mid-turn wakes into a single follow-up", async () => {
    const calls: string[] = [];
    const resolvers: (() => void)[] = [];
    const runTurn = vi.fn(async (sessionId: string) => {
      calls.push(sessionId);
      await new Promise<void>((r) => resolvers.push(r)); // block until released
    });
    const sup = new TeammateSupervisor(runTurn);
    sup.register("s1", "r");

    sup.wake("s1"); // turn 1 starts, blocks
    await tick();
    expect(calls).toEqual(["s1"]);

    sup.wake("s1"); // mid-turn wake → dirty
    sup.wake("s1"); // another → still just dirty (coalesced, not queued)
    resolvers.shift()?.(); // finish turn 1 → dirty → turn 2 starts, blocks
    await tick();
    expect(calls).toEqual(["s1", "s1"]); // exactly ONE follow-up

    resolvers.shift()?.(); // finish turn 2 → not dirty → stop
    await tick();
    expect(calls).toEqual(["s1", "s1"]); // no third turn
  });

  it("does not re-run a teammate that was unregistered mid-turn, even if it was woken again", async () => {
    const calls: string[] = [];
    const resolvers: (() => void)[] = [];
    const runTurn = vi.fn(async (sessionId: string) => {
      calls.push(sessionId);
      await new Promise<void>((r) => resolvers.push(r));
    });
    const sup = new TeammateSupervisor(runTurn);
    sup.register("s1", "r");
    sup.wake("s1"); // turn 1 starts, blocks
    await tick();
    sup.wake("s1"); // dirty
    sup.unregister("s1"); // stop watching
    resolvers.shift()?.(); // finish turn 1 → dirty but no longer a teammate → no re-run
    await tick();
    expect(calls).toEqual(["s1"]);
  });
});
