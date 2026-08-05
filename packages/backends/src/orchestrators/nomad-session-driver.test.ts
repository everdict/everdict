import type { Driver } from "@everdict/contracts";
import { perTenantTrustZones } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { NomadSessionDriver, parseSessionComputeId } from "./nomad-session-driver.js";
import type { NomadHttp } from "./nomad.js";

// A cluster that answers: the job is accepted, then its allocation reaches `running`. Records every request
// so the shape of the submitted job — the part that decides whether a SESSION survives — can be asserted.
function fakeCluster(opts: { allocStatuses?: string[]; submitStatus?: number } = {}): {
  http: NomadHttp;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  submitted: () => any;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const statuses = [...(opts.allocStatuses ?? ["running"])];
  return {
    calls,
    submitted: () => calls.find((c) => c.path === "/v1/jobs")?.body,
    http: {
      async request(method, path, body) {
        calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
        if (path === "/v1/jobs") return { status: opts.submitStatus ?? 200, text: "{}" };
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

describe("NomadSessionDriver — a long-lived session as an allocation", () => {
  it("submits a SERVICE job that never restarts, holding the container open for exec", async () => {
    const cluster = fakeCluster();
    const driver = new NomadSessionDriver({ addr: "http://nomad:4646", http: cluster.http, execRunner: runner().fn });
    const handle = await driver.provision({ os: "linux", image: "debian:stable-slim", needs: ["shell"] });

    const job = cluster.submitted().Job;
    expect(job.Type).toBe("service"); // a batch job would end the moment its command did
    // The container's filesystem IS the session: a silent restart would hand back a fresh one and lose the work.
    expect(job.TaskGroups[0].RestartPolicy).toMatchObject({ Attempts: 0, Mode: "fail" });
    expect(job.TaskGroups[0].Tasks[0].Config).toMatchObject({ image: "debian:stable-slim", entrypoint: ["sh"] });
    expect(String(job.TaskGroups[0].Tasks[0].Config.args[1])).toContain("sleep infinity");
    // The id carries what a LATER process needs — the row is all the reaper gets.
    expect(parseSessionComputeId(handle.id ?? "")).toMatchObject({ allocId: "alloc-1" });
  });

  it("applies the tenant's trust zone to the alloc, and refuses a zone that does not isolate", async () => {
    const cluster = fakeCluster();
    const driver = new NomadSessionDriver({
      addr: "http://nomad:4646",
      http: cluster.http,
      execRunner: runner().fn,
      trustZones: perTenantTrustZones({ isolationRuntime: "kata", namespacePrefix: "zone-" }),
    });
    const handle = await driver.provision({ os: "linux", image: "img", needs: ["shell"], tenant: "acme" });
    const job = cluster.submitted().Job;
    expect(job.Namespace).toBe("zone-acme");
    expect(job.TaskGroups[0].Tasks[0].Config.runtime).toBe("kata");
    expect(parseSessionComputeId(handle.id ?? "").namespace).toBe("zone-acme");

    const soft = new NomadSessionDriver({
      addr: "http://nomad:4646",
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
    const driver = new NomadSessionDriver({
      addr: "http://nomad:4646",
      apiToken: "acl-token",
      namespace: "ns1",
      http: cluster.http,
      execRunner: rec.fn,
    });
    const handle = await driver.provision({ os: "linux", image: "img", needs: ["shell"] });
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
    const driver = new NomadSessionDriver({
      addr: "http://nomad:4646",
      namespace: "ns1",
      http: cluster.http,
      execRunner: runner().fn,
    });
    const handle = await driver.provision({ os: "linux", image: "img", needs: ["shell"] });
    await handle.dispose();
    const deleted = cluster.calls.filter((c) => c.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.path).toContain("purge=true");
    expect(deleted[0]?.path).toContain("namespace=ns1");

    // A later process holds no handle — only the recorded id.
    await driver.reap(handle.id ?? "");
    expect(cluster.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("does not leave a job the caller has no handle to when the allocation never starts", async () => {
    const cluster = fakeCluster({ allocStatuses: ["failed"] });
    const driver = new NomadSessionDriver({ addr: "http://nomad:4646", http: cluster.http, execRunner: runner().fn });
    await expect(driver.provision({ os: "linux", image: "img", needs: ["shell"] })).rejects.toThrow(/failed/i);
    expect(cluster.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("has NO snapshot() — a cluster session is snapshotted through the registry, not a daemon", () => {
    // Typed as the CONTRACT, which is how the session service sees it: the absent capability is what makes
    // it fall back to the layer-append capture.
    const driver: Driver = new NomadSessionDriver({ addr: "http://nomad:4646", http: fakeCluster().http });
    expect(driver.snapshot).toBeUndefined();
    expect(driver.reap).toBeDefined();
  });
});
