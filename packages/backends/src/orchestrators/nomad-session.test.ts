import type { Driver } from "@everdict/contracts";
import { perTenantTrustZones } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { isSessionable } from "../backend.js";
import { K8sBackend } from "./k8s.js";
import { parseSessionComputeId } from "./nomad-session.js";
import { NomadBackend, type NomadHttp } from "./nomad.js";

// A session on Nomad is the SAME backend that dispatches eval cases there, narrowed to its session mode. These
// assertions are about the half a dispatched case never exercises: a job that holds a container open, the exec
// channel into it, and the cleanup — plus the guard that decides whether a placement target has the mode at all.

// The captured submit body, shaped just enough for the assertions below — the cast in `submitted` is the test's
// own claim about what it sent, narrowed instead of `any` so the checker still watches every access.
interface SubmittedSessionJob {
  Job: {
    Type?: string;
    Namespace?: string;
    TaskGroups: Array<{
      RestartPolicy?: unknown;
      Tasks: Array<{ Config: { image?: string; entrypoint?: unknown; runtime?: string; args?: unknown[] } }>;
    }>;
  };
}

// A cluster that answers: the job is accepted, then its allocation reaches `running`. Records every request
// so the shape of the submitted job — the part that decides whether a SESSION survives — can be asserted.
function fakeCluster(opts: { allocStatuses?: string[] } = {}): {
  http: NomadHttp;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  submitted: () => SubmittedSessionJob;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const statuses = [...(opts.allocStatuses ?? ["running"])];
  return {
    calls,
    submitted: () => calls.find((c) => c.path === "/v1/jobs")?.body as SubmittedSessionJob,
    http: {
      async request(method, path, body) {
        calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
        if (path === "/v1/jobs") return { status: 200, text: JSON.stringify({ JobModifyIndex: 1 }) };
        if (path.includes("/allocations")) {
          const next = statuses.shift() ?? "running";
          return { status: 200, text: JSON.stringify([{ ID: "alloc-1", ClientStatus: next }]) };
        }
        return { status: 200, text: "{}" };
      },
    },
  };
}

function runner(record: string[][] = []) {
  return {
    record,
    fn: async (bin: string, args: string[]) => {
      record.push([bin, ...args]);
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

function sessionBackend(opts: Partial<ConstructorParameters<typeof NomadBackend>[0]> & { http: NomadHttp }) {
  return new NomadBackend({ addr: "http://nomad:4646", image: "everdict-job-runner", ...opts });
}

describe("NomadBackend session mode — a long-lived allocation, held open by the placement target", () => {
  it("submits a SERVICE job that never restarts, booting the SPEC's image (not the dispatch image)", async () => {
    const cluster = fakeCluster();
    const backend = sessionBackend({ http: cluster.http, execRunner: runner().fn });
    const handle = await backend.provision({ os: "linux", image: "debian:stable-slim", needs: ["shell"] });

    const job = cluster.submitted().Job;
    expect(job.Type).toBe("service"); // a batch job would end the moment its command did
    // The container's filesystem IS the session: a silent restart would hand back a fresh one and lose the work.
    expect(job.TaskGroups[0]?.RestartPolicy).toMatchObject({ Attempts: 0, Mode: "fail" });
    // The backend's `image` is what a dispatched CASE runs (the job-runner); a session runs the world it was
    // asked for. One object, two images — which is exactly what folding the two modes together had to keep apart.
    expect(job.TaskGroups[0]?.Tasks[0]?.Config).toMatchObject({ image: "debian:stable-slim", entrypoint: ["sh"] });
    expect(String(job.TaskGroups[0]?.Tasks[0]?.Config.args?.[1])).toContain("sleep infinity");
    // The id carries what a LATER process needs — the row is all the reaper gets.
    expect(parseSessionComputeId(handle.id ?? "")).toMatchObject({ allocId: "alloc-1" });
  });

  it("applies the tenant's trust zone to the alloc, and refuses a zone that does not isolate", async () => {
    const cluster = fakeCluster();
    const backend = sessionBackend({
      http: cluster.http,
      execRunner: runner().fn,
      trustZones: perTenantTrustZones({ isolationRuntime: "kata", namespacePrefix: "zone-" }),
    });
    const handle = await backend.provision({ os: "linux", image: "img", needs: ["shell"], tenant: "acme" });
    const job = cluster.submitted().Job;
    expect(job.Namespace).toBe("zone-acme");
    expect(job.TaskGroups[0]?.Tasks[0]?.Config.runtime).toBe("kata");
    expect(parseSessionComputeId(handle.id ?? "").namespace).toBe("zone-acme");

    const soft = sessionBackend({
      http: fakeCluster().http,
      execRunner: runner().fn,
      trustZones: perTenantTrustZones({ isolationRuntime: "runc" }),
    });
    await expect(soft.provision({ os: "linux", image: "img", needs: ["shell"], tenant: "acme" })).rejects.toThrow(
      /runc|isolation/i,
    );
  });

  it("execs into the allocation with the namespace, and keeps env OUT of argv", async () => {
    const cluster = fakeCluster();
    const rec = runner();
    const backend = sessionBackend({
      apiToken: "acl-token",
      namespace: "ns1",
      http: cluster.http,
      execRunner: rec.fn,
    });
    const handle = await backend.provision({ os: "linux", image: "img", needs: ["shell"] });
    await handle.exec("echo hi", { cwd: "work", env: { TOKEN: "s3cr3t" } });

    const argv = rec.record.at(-1) ?? [];
    expect(argv.slice(0, 6)).toEqual(["nomad", "alloc", "exec", "-task", "session", "-namespace"]);
    expect(argv).toContain("alloc-1");
    const command = argv.at(-1) ?? "";
    expect(command).toContain("cd '/everdict/work'"); // relative paths resolve under the session's base
    // A credential in argv is readable through `ps` on the client node — it goes through the shell instead.
    expect(command).toContain("export TOKEN=");
    expect(argv.slice(0, -1).join(" ")).not.toContain("s3cr3t");
  });

  it("purges the job on dispose and on reap — a session's job is not history worth keeping", async () => {
    const cluster = fakeCluster();
    const backend = sessionBackend({ namespace: "ns1", http: cluster.http, execRunner: runner().fn });
    const handle = await backend.provision({ os: "linux", image: "img", needs: ["shell"] });
    await handle.dispose();
    const deleted = cluster.calls.filter((c) => c.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.path).toContain("purge=true");
    expect(deleted[0]?.path).toContain("namespace=ns1");

    // A later process holds no handle — only the recorded id.
    await backend.reap(handle.id ?? "");
    expect(cluster.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("does not leave a job the caller has no handle to when the allocation never starts", async () => {
    const cluster = fakeCluster({ allocStatuses: ["failed"] });
    const backend = sessionBackend({ http: cluster.http, execRunner: runner().fn });
    await expect(backend.provision({ os: "linux", image: "img", needs: ["shell"] })).rejects.toThrow(/failed/i);
    expect(cluster.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("counts a session in the SAME capacity probe a dispatched case is placed against", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(_method, path) {
        calls.push(path);
        if (path.startsWith("/v1/jobs?prefix="))
          return { status: 200, text: JSON.stringify([{ ID: "everdict-session-abc", Status: "running" }]) };
        return { status: 200, text: "[]" };
      },
    };
    const used = (await sessionBackend({ http, maxConcurrent: 4 }).capacity()).used;
    // The whole point of one object owning both modes: a held-open session consumes a slot the scheduler can
    // see, instead of a second driver placing work the capacity probe never learns about.
    expect(used).toBe(1);
    expect(calls.some((p) => p.includes("prefix=everdict-"))).toBe(true);
  });

  it("says by TYPE which targets have a session mode — k8s does not, and is refused before anything is placed", () => {
    expect(isSessionable(sessionBackend({ http: fakeCluster().http }))).toBe(true);
    expect(isSessionable(new K8sBackend({ image: "img" }))).toBe(false);
  });

  it("has NO snapshot() — a cluster session is snapshotted through the registry, not a daemon", () => {
    // Typed as the CONTRACT, which is how the session service sees it: the absent capability is what makes
    // it fall back to the layer-append capture.
    const compute: Driver = sessionBackend({ http: fakeCluster().http });
    expect(compute.snapshot).toBeUndefined();
    expect(compute.reap).toBeDefined();
  });
});
