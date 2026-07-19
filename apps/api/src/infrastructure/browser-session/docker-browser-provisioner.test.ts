import { DEFAULT_BROWSER_IMAGE, type Docker, type DockerRunSpec } from "@everdict/topology";
import { describe, expect, it } from "vitest";
import { DockerBrowserProvisioner } from "./docker-browser-provisioner.js";

// A fake Docker adapter — records the run spec + rm, hands back a container id + a fixed host port (no daemon).
function fakeDocker() {
  const runs: DockerRunSpec[] = [];
  const removed: string[][] = [];
  const docker: Docker = {
    async ensureNetwork() {},
    async run(spec) {
      runs.push(spec);
      return "container-1";
    },
    async hostPort() {
      return 54231;
    },
    async exec() {},
    async rm(containers) {
      removed.push(containers);
    },
    async removeNetwork() {},
    async running() {
      return []; // session containers are never adopted — the provisioner always runs fresh
    },
    async createNetwork() {
      return true; // the provisioner never races another deployer on its per-session names
    },
    async networkCreatedAt() {
      return undefined;
    },
  };
  return { docker, runs, removed };
}

const okFetch = (async (url: string) =>
  new Response(String(url).endsWith("/json/version") ? '{"Browser":"HeadlessChrome"}' : "ok", {
    status: 200,
  })) as unknown as typeof fetch;

describe("DockerBrowserProvisioner (browser-profiles S6)", () => {
  it("runs a headless-shell container, publishes CDP, and returns the reachable host CDP base", async () => {
    const { docker, runs } = fakeDocker();
    const p = new DockerBrowserProvisioner({ docker, fetch: okFetch, newName: () => "abcd" });
    const browser = await p.provision();
    expect(browser.cdpBase).toBe("http://127.0.0.1:54231"); // the published host port, not the internal 9222
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      name: "evd-browser-session-abcd",
      image: DEFAULT_BROWSER_IMAGE,
      publish: 9222,
    });
    expect(runs[0]?.args).toContain("--remote-allow-origins=*");
  });

  it("folds a geo proxy (S4) into the container's --proxy-server", async () => {
    const { docker, runs } = fakeDocker();
    const p = new DockerBrowserProvisioner({ docker, fetch: okFetch, newName: () => "x" });
    await p.provision({ proxyServer: "http://user:pass@proxy:8080" });
    expect(runs[0]?.args).toContain("--proxy-server=http://user:pass@proxy:8080");
  });

  it("disposes by removing the container", async () => {
    const { docker, removed } = fakeDocker();
    const p = new DockerBrowserProvisioner({ docker, fetch: okFetch, newName: () => "x" });
    const browser = await p.provision();
    await browser.dispose();
    expect(removed).toEqual([["container-1"]]);
  });

  it("tears the container down and throws if the CDP never comes up", async () => {
    const { docker, removed } = fakeDocker();
    const failFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const p = new DockerBrowserProvisioner({ docker, fetch: failFetch, readyTimeoutMs: 30, newName: () => "x" });
    await expect(p.provision()).rejects.toThrow(/did not come up/);
    expect(removed).toEqual([["container-1"]]); // the half-provisioned container is cleaned up
  });
});
