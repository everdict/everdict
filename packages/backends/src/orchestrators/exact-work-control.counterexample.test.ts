import type { RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type K8sApi, K8sBackend } from "./k8s.js";

// ── EXACT ADDRESSING IS THE DEFAULT, NOT A KILL-ONLY CAPABILITY (arch-review 53, Wave B) ─────────────
//
// Wave 2 gave `killWork(RuntimeWorkRef)` an exact address and stopped there. Every OTHER control path into
// live work still takes a case id and resolves it the same way the old kill did — list the jobs carrying
// `everdict.dev/case=<slug>`, take the NEWEST one:
//
//     adopt(caseId) · logs(caseId) · caseEvents(caseId) · exec(caseId) · execStream(caseId)
//     inspectCase(caseId) · sampleCase(caseId)
//
// Two runs of one case are two live jobs (a re-evaluation beside a scheduled batch, a retry beside the
// attempt it replaces, a shadow beside its baseline). "Newest" is whichever of them the cluster happened to
// create last, which is not the one the caller asked about. So a run's log tail shows another run's output,
// its exec runs a command in another run's sandbox, and its placement panel reports another run's phase.
//
// `adopt` is the one that is not merely an observability defect. Boot recovery calls it to decide whether an
// execution's compute is still live, and ADOPTS the result it finds as that execution's own — so a recovery
// that resolves "newest job for case c1" can hand run A the verdict that run B's job produced. That changes
// which bytes a receipt vouches for, which puts it on the decision plane.
//
// The invariant these pin: every control call that reaches live work is addressed by the handle that names
// that work, and a handle for a DIFFERENT run is never served in its place. Case-id addressing survives only
// as an explicitly-named legacy compatibility surface, forbidden on recovery/cancellation/decision paths.

const TWO_JOBS_ONE_CASE = [
  // Run A's job — created first.
  { name: "everdict-c1-aaaa", namespace: "everdict-acme", creationTimestamp: "2026-08-17T00:00:00Z" },
  // Run B's job — same case id, created later. Every case-id read below resolves to THIS one.
  { name: "everdict-c1-bbbb", namespace: "everdict-acme", creationTimestamp: "2026-08-17T00:00:05Z" },
];

function api(): { api: K8sApi; reads: string[] } {
  const reads: string[] = [];
  const impl = {
    async ensureNamespace() {},
    async jobsByLabel() {
      return TWO_JOBS_ONE_CASE;
    },
    async podLogs(name: string) {
      reads.push(`logs:${name}`);
      return `output of ${name}\n`;
    },
    async exec(name: string, _ns: string, command: string) {
      reads.push(`exec:${name}`);
      return { stdout: `ran ${command} in ${name}`, stderr: "", exitCode: 0 };
    },
    async podsForJob(name: string) {
      reads.push(`pods:${name}`);
      return [{ name: `${name}-pod`, phase: "Running", node: "node-1" }];
    },
    async podTop(name: string) {
      reads.push(`top:${name}`);
      return { cpuMilli: 100, memMi: 200 };
    },
    async objectEvents(_kind: string, name: string) {
      reads.push(`events:${name}`);
      return [];
    },
    async jobStatus() {
      return { succeeded: 0, failed: 0 };
    },
    async serverVersion() {
      return "v1.30.0";
    },
  } as unknown as K8sApi;
  return { api: impl, reads };
}

// Run A's handle — the exact object the caller is asking about.
const WORK_A: RuntimeWorkRef = {
  tenant: "acme",
  runId: "evd-run-A",
  externalJobId: "everdict-c1-aaaa",
  namespace: "everdict-acme",
};

const methodOf = (backend: object, name: string): unknown => (backend as Record<string, unknown>)[name];

// RED as of 186f9fd9: every probe answers 'undefined' — only `killWork` takes a handle.
describe.skip("[R53 WAVE-B COUNTEREXAMPLE #4] the exact-work control surface exists", () => {
  it("a managed backend addresses adopt/logs/events/exec/inspect/sample by RuntimeWorkRef", () => {
    const backend = new K8sBackend({ image: "i", api: api().api });
    for (const name of ["adoptWork", "logsForWork", "eventsForWork", "execInWork", "inspectWork", "sampleWork"])
      expect(typeof methodOf(backend, name), `${name} is missing — control is still case-id addressed`).toBe(
        "function",
      );
  });
});

// RED as of 186f9fd9: `expected 'logs:everdict-c1-bbbb' to be 'logs:everdict-c1-aaaa'` — the newest job wins.
describe.skip("[R53 WAVE-B COUNTEREXAMPLE #5] a log tail belongs to the run that asked for it", () => {
  it("reads run A's job, not whichever job of that case the cluster created last", async () => {
    const { api: impl, reads } = api();
    const backend = new K8sBackend({ image: "i", api: impl });
    const logsForWork = methodOf(backend, "logsForWork") as
      | ((work: RuntimeWorkRef) => Promise<string | undefined>)
      | undefined;

    await logsForWork?.call(backend, WORK_A);

    expect(reads[0]).toBe("logs:everdict-c1-aaaa");
  });
});

// RED as of 186f9fd9: `expected 'exec:everdict-c1-bbbb' to be 'exec:everdict-c1-aaaa'` — a command runs in a
// stranger's sandbox, which is a write into another run's world, not a read of it.
describe.skip("[R53 WAVE-B COUNTEREXAMPLE #6] an exec lands in the sandbox it was issued for", () => {
  it("runs the command inside run A's job", async () => {
    const { api: impl, reads } = api();
    const backend = new K8sBackend({ image: "i", api: impl });
    const execInWork = methodOf(backend, "execInWork") as
      | ((work: RuntimeWorkRef, command: string) => Promise<unknown>)
      | undefined;

    await execInWork?.call(backend, WORK_A, "ls");

    expect(reads[0]).toBe("exec:everdict-c1-aaaa");
  });
});

// RED as of 186f9fd9: `expected 'pods:everdict-c1-bbbb' to be 'pods:everdict-c1-aaaa'`.
describe.skip("[R53 WAVE-B COUNTEREXAMPLE #7] a placement view describes the work it names", () => {
  it("inspects run A's job", async () => {
    const { api: impl, reads } = api();
    const backend = new K8sBackend({ image: "i", api: impl });
    const inspectWork = methodOf(backend, "inspectWork") as ((work: RuntimeWorkRef) => Promise<unknown>) | undefined;

    await inspectWork?.call(backend, WORK_A);

    expect(reads.some((r) => r.endsWith("everdict-c1-aaaa"))).toBe(true);
    expect(reads.some((r) => r.endsWith("everdict-c1-bbbb"))).toBe(false);
  });
});

// RED as of 186f9fd9: `adoptWork` does not exist; `adopt(caseId)` returns the newest job's verdict.
describe.skip("[R53 WAVE-B COUNTEREXAMPLE #8] recovery adopts the execution it is recovering", () => {
  it("adopt is addressed by the handle, so it can never return another run's job as this run's", async () => {
    const { api: impl } = api();
    const backend = new K8sBackend({ image: "i", api: impl });
    const adoptWork = methodOf(backend, "adoptWork") as
      | ((work: RuntimeWorkRef) => Promise<{ status: string; externalJobId?: string }>)
      | undefined;

    expect(typeof adoptWork).toBe("function");
    const outcome = await adoptWork?.call(backend, WORK_A);
    // Whatever it reports, it reports about the object the handle names — never a sibling of the same case.
    expect(outcome?.externalJobId ?? WORK_A.externalJobId).toBe("everdict-c1-aaaa");
  });
});
