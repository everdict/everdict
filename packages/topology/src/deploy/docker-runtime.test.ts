import type { ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CdpSocket } from "../front-door/capture-cdp.js";
import { DockerTopologyRuntime } from "./docker-runtime.js";
import { type Docker, type DockerRunSpec, dockerRunArgs, parseHostPort } from "./docker.js";
import { worldTopologyId } from "./topology-runtime.js";

const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [
    {
      name: "agent-server",
      image: "reg/bu-agent:1",
      port: 8000,
      needs: ["postgres", "redis"],
      perRun: [],
      replicas: 1,
      env: {},
    },
  ],
  dependencies: [
    { store: "postgres", role: "checkpoints", purpose: "plumbing", isolateBy: "thread_id" },
    { store: "redis", role: "action-stream", purpose: "plumbing", isolateBy: "key-prefix" },
  ],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["dom"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
};

// Fake Docker — records calls and returns published ports deterministically (no daemon needed).
// runningNames seeds `running()` (the adopt-don't-kill gate) and stays MUTABLE — tests push/splice it to
// simulate containers dying or another process's deploy landing. networkExists=true makes createNetwork
// report "already existed" (the cold-start loser's view).
function fakeDocker(
  runningNames: string[] = [],
  opts: { networkExists?: boolean; captureOut?: string } = {},
): {
  docker: Docker;
  runs: DockerRunSpec[];
  networks: string[];
  removed: string[];
  rmNets: string[];
  execs: string[][];
  execCaptures: string[][];
  runningNames: string[];
} {
  const runs: DockerRunSpec[] = [];
  const networks: string[] = [];
  const removed: string[] = [];
  const rmNets: string[] = [];
  const execs: string[][] = [];
  const execCaptures: string[][] = [];
  let nextPort = 49152;
  // Per-name network existence (like the daemon): createNetwork is atomic-exclusive, removeNetwork frees the
  // name. networkExists pre-seeds the MAIN topology network (the cold-start loser's / heal contender's view).
  const existingNetworks = new Set<string>(opts.networkExists ? ["everdict-bu-1.0.0"] : []);
  const docker: Docker = {
    async ensureNetwork(name) {
      networks.push(name);
    },
    async createNetwork(name) {
      if (existingNetworks.has(name)) return false;
      existingNetworks.add(name);
      networks.push(name);
      return true;
    },
    async run(spec) {
      runs.push(spec);
      return `cid-${spec.name}`;
    },
    async hostPort() {
      return nextPort++;
    },
    async exec(container, cmd) {
      execs.push([container, ...cmd]);
    },
    async execCapture(container, cmd) {
      execCaptures.push([container, ...cmd]);
      return opts.captureOut ?? "";
    },
    async rm(c) {
      removed.push(...c);
    },
    async removeNetwork(n) {
      existingNetworks.delete(n);
      rmNets.push(n);
    },
    async running(names) {
      return names.filter((n) => runningNames.includes(n));
    },
    async networkCreatedAt(name) {
      return existingNetworks.has(name) ? Date.now() : undefined; // existing = fresh (never stale) in the fake
    },
  };
  return { docker, runs, networks, removed, rmNets, execs, execCaptures, runningNames };
}

const okFetch: typeof fetch = (async (url: string) => {
  if (String(url).endsWith("/json/list")) return new Response(JSON.stringify([{ url: "https://x" }]), { status: 200 });
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

describe("dockerRunArgs / parseHostPort (pure)", () => {
  it("assembles docker run args (name/network/alias/env/publish/args)", () => {
    expect(
      dockerRunArgs({
        name: "c",
        image: "img:1",
        network: "net",
        alias: "svc",
        env: { A: "1" },
        publish: 8000,
        args: ["x"],
      }),
    ).toEqual([
      "run",
      "-d",
      "--name",
      "c",
      "--network",
      "net",
      // host.docker.internal → host gateway: a service can reach a host-local model gateway (LiteLLM etc.).
      "--add-host",
      "host.docker.internal:host-gateway",
      "--network-alias",
      "svc",
      "-e",
      "A=1",
      "-p",
      "8000",
      "img:1",
      "x",
    ]);
  });

  it("expands volumes into -v args (after env, before publish)", () => {
    expect(
      dockerRunArgs({
        name: "c",
        image: "img:1",
        network: "net",
        volumes: ["data:/var/lib/x", "/host:/c:ro"],
        publish: 8000,
      }),
    ).toEqual([
      "run",
      "-d",
      "--name",
      "c",
      "--network",
      "net",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      "data:/var/lib/x",
      "-v",
      "/host:/c:ro",
      "-p",
      "8000",
      "img:1",
    ]);
  });

  it("no -v when volumes are unspecified", () => {
    expect(dockerRunArgs({ name: "c", image: "img:1", network: "net" })).not.toContain("-v");
  });

  it("expands cpus/memoryMb into --cpus/--memory, and omits them when unspecified", () => {
    const args = dockerRunArgs({ name: "c", image: "img:1", network: "net", cpus: 2, memoryMb: 4096 });
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toBe("4096m");
    const none = dockerRunArgs({ name: "c", image: "img:1", network: "net" });
    expect(none).not.toContain("--cpus");
    expect(none).not.toContain("--memory");
  });

  it("extracts the host port from docker port output", () => {
    expect(parseHostPort("0.0.0.0:49153\n[::]:49153")).toBe(49153);
  });
});

describe("DockerTopologyRuntime", () => {
  it("ensureTopology: brings up stores + services on the network and discovers endpoints via published host ports", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    const handle = await rt.ensureTopology(SPEC);

    expect(f.networks).toEqual(["everdict-bu-1.0.0"]);
    // 2 stores (postgres/redis) + 1 service = 3 runs.
    expect(f.runs.map((r) => r.alias)).toEqual(["bu-postgres", "bu-redis", "agent-server"]);
    // the service is injected with DATABASE_URL/REDIS_URL via the network alias (<id>-<store>:port).
    const agent = f.runs.find((r) => r.alias === "agent-server");
    expect(agent?.env?.DATABASE_URL).toBe("postgresql://everdict:everdict@bu-postgres:5432/everdict");
    expect(agent?.env?.REDIS_URL).toBe("redis://bu-redis:6379");
    expect(agent?.publish).toBe(8000);
    // endpoint = http://127.0.0.1:<published host port>.
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("seedFixtures: execs the postgres seed into the store container's per-case schema slice (P2)", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.seedFixtures(SPEC, "run1", [
      {
        store: "postgres",
        role: "world",
        isolateBy: "schema",
        slice: "run_run1",
        seed: { inline: "INSERT INTO t VALUES (1);" },
        format: "sql",
      },
    ]);
    // reaches the deterministic postgres container name and runs psql with the schema-scoped seed script.
    const pg = f.execs.find((e) => e[0] === "everdict-bu-1.0.0-bu-postgres");
    expect(pg?.[1]).toBe("psql");
    const script = pg?.[pg.length - 1] ?? "";
    expect(script).toContain('CREATE SCHEMA IF NOT EXISTS "run_run1"');
    expect(script).toContain("INSERT INTO t VALUES (1);");
  });

  it("readStoreState: reads the postgres slice via psql and returns stdout (P2)", async () => {
    const f = fakeDocker([], { captureOut: "1|alice\n2|bob\n" });
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      dependencies: [
        ...(SPEC.dependencies ?? []),
        { store: "postgres", role: "world", purpose: "data", isolateBy: "schema" },
      ],
    };
    const out = await rt.readStoreState(spec, "run1", {
      store: "postgres",
      role: "world",
      query: "SELECT id,name FROM t",
    });
    expect(out).toBe("1|alice\n2|bob\n");
    const cap = f.execCaptures.find((e) => e[0] === "everdict-bu-1.0.0-bu-postgres");
    expect(cap?.[1]).toBe("psql");
    // schema scoped on the connection (search_path startup option), query unpolluted as the last arg.
    expect(cap?.some((a) => a.includes("search_path=run_run1"))).toBe(true);
    expect(cap?.[cap.length - 1]).toBe("SELECT id,name FROM t");
  });

  // Container names are deterministic across processes, so two runners on one host reach the same names.
  const SPEC_CONTAINERS = [
    "everdict-bu-1.0.0-bu-postgres",
    "everdict-bu-1.0.0-bu-redis",
    "everdict-bu-1.0.0-agent-server",
  ];

  it("adopts a fully-running same-name topology instead of removing it (two runner processes share one host)", async () => {
    const f = fakeDocker(SPEC_CONTAINERS);
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(f.runs).toEqual([]); // nothing deployed…
    expect(f.removed).toEqual([]); // …and, critically, the other process's LIVE containers were not rm -f'd
    // liveness was actually probed (stores accept connections), not assumed from the name match
    expect(f.execs.some((e) => e[0] === "everdict-bu-1.0.0-bu-redis" && e.includes("ping"))).toBe(true);
    // postgres is probed over TCP (-h 127.0.0.1), NOT the socket — the socket passes on the temporary initdb server
    // and lets a seed race its restart ("database system is shutting down"). Regression: keep it TCP.
    expect(
      f.execs.some(
        (e) => e[0] === "everdict-bu-1.0.0-bu-postgres" && e.includes("pg_isready") && e.includes("127.0.0.1"),
      ),
    ).toBe(true);
  });

  it("removes and redeploys when the same-name leftover set is only partially running", async () => {
    const f = fakeDocker(["everdict-bu-1.0.0-bu-postgres"]); // a restart leftover: only one store survived
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    expect(f.runs).toHaveLength(3); // fresh deploy
    expect(f.removed).toContain("everdict-bu-1.0.0-bu-postgres"); // the leftover is cleaned before its redeploy
  });

  it("self-heals a poisoned warm entry — dead containers invalidate the cache and the next ensure redeploys", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    expect(f.runs).toHaveLength(3);
    // The topology is deployed and warm; now its containers die (crash / docker rm -f / host reboot):
    // runningNames stays empty, so the warm entry's liveness check sees 0/3 running.
    const handle = await rt.ensureTopology(SPEC);
    expect(f.runs).toHaveLength(6); // redeployed instead of serving the dead handle forever
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("cold-start loser waits for the winner's deploy and adopts it (never tears it down)", async () => {
    // The network already exists (another process won docker network create); its containers land mid-wait.
    const f = fakeDocker([], { networkExists: true });
    // Poll slower than the containers' arrival so the zero-running grace (3 polls) can't expire first.
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch, pollIntervalMs: 10 });
    setTimeout(() => f.runningNames.push(...SPEC_CONTAINERS), 2); // the winner's containers come up shortly
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(f.runs).toEqual([]); // adopted — this process deployed nothing…
    expect(f.removed).toEqual([]); // …and never rm -f'd the winner's containers
  });

  it("cold-start takeover — a stale network with no deploy behind it is healed over after a short grace", async () => {
    const f = fakeDocker([], { networkExists: true }); // leftover network from a crashed deployer, nothing running
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch, pollIntervalMs: 1 });
    const handle = await rt.ensureTopology(SPEC);
    expect(f.runs).toHaveLength(3); // gave up waiting → won the heal lock → demolished + deployed
    expect(f.rmNets).toContain("everdict-bu-1.0.0.heal"); // the heal lock was released
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("a MAIMED topology (some containers dead) is demolished and redeployed under the heal lock", async () => {
    // relay/agent died, one store survived — not adoptable (partial), and the main network still exists so
    // the cold-start mutex can't arbitrate: pre-fix, concurrent takeovers collided on docker run --name.
    const f = fakeDocker(["everdict-bu-1.0.0-bu-postgres"], { networkExists: true });
    // readyTimeoutMs bounds the wait-adopt budget — a maimed set never becomes adoptable, so keep it tiny.
    const rt = new DockerTopologyRuntime({
      docker: f.docker,
      fetchImpl: okFetch,
      pollIntervalMs: 1,
      readyTimeoutMs: 30,
    });
    const handle = await rt.ensureTopology(SPEC);
    expect(f.removed).toContain("everdict-bu-1.0.0-bu-postgres"); // the survivor was demolished with the set
    expect(f.runs).toHaveLength(3); // full redeploy
    expect(f.rmNets).toContain("everdict-bu-1.0.0.heal"); // lock released after healing
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("does not adopt an unready topology — a failing probe falls back to rm+redeploy", async () => {
    const f = fakeDocker(SPEC_CONTAINERS);
    // The pre-existing front door answers 500 (mid-boot elsewhere); post-deploy readiness answers 200.
    const bootingFetch: typeof fetch = (async () =>
      new Response("{}", { status: f.runs.length === 0 ? 500 : 200 })) as unknown as typeof fetch;
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: bootingFetch });
    const handle = await rt.ensureTopology(SPEC);
    expect(f.runs).toHaveLength(3); // adoption refused → fresh deploy
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ensureTopology: injects the service static env (svc.env) + precedence (connEnv < svc.env < storeEnv)", async () => {
    const f = fakeDocker();
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "agent-server",
          image: "reg/bu-agent:1",
          port: 8000,
          needs: ["postgres"],
          perRun: [],
          replicas: 1,
          env: { LOG_LEVEL: "info", DATABASE_URL: "postgresql://svc" },
        },
      ],
    };
    const rt = new DockerTopologyRuntime({
      docker: f.docker,
      fetchImpl: okFetch,
      storeEnv: { DATABASE_URL: "postgresql://store" },
    });
    await rt.ensureTopology(spec);
    const agent = f.runs.find((r) => r.alias === "agent-server");
    expect(agent?.env?.LOG_LEVEL).toBe("info"); // svc.env alone
    expect(agent?.env?.DATABASE_URL).toBe("postgresql://store"); // storeEnv wins over svc.env (and connEnv)
  });

  it("ensureTopology: dependencies[].inject renders a BYO store env name that beats BOTH the svc.env literal and storeEnv", async () => {
    // The SPICA rupture: an image reading VALKEY_URL (not REDIS_URL) used to see only the stale literal — the deployed
    // store's endpoint never reached it. The inject mapping is the deployed truth, so nothing may shadow it.
    const f = fakeDocker();
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "agent-server",
          image: "reg/spica:1",
          port: 8000,
          needs: ["redis"],
          perRun: [],
          replicas: 1,
          env: { VALKEY_URL: "redis://stale-literal:6379" },
        },
      ],
      dependencies: [
        {
          store: "redis",
          role: "queue",
          purpose: "plumbing",
          isolateBy: "key-prefix",
          inject: [
            { env: "VALKEY_URL", template: "valkey://{host}:{port}" },
            { env: "QUEUE_ENDPOINT", template: "{endpoint}" },
          ],
        },
      ],
    };
    const rt = new DockerTopologyRuntime({
      docker: f.docker,
      fetchImpl: okFetch,
      storeEnv: { VALKEY_URL: "redis://operator-override:6379" },
    });
    await rt.ensureTopology(spec);
    const agent = f.runs.find((r) => r.alias === "agent-server");
    expect(agent?.env?.VALKEY_URL).toBe("valkey://bu-redis:6379"); // rendered from the deployed store's alias, shadowing literal + storeEnv
    expect(agent?.env?.QUEUE_ENDPOINT).toBe("bu-redis:6379");
    expect(agent?.env?.REDIS_URL).toBe("redis://bu-redis:6379"); // conventional keys still injected alongside
  });

  it("ensureTopology: interpolates a {{peer}} env ref to the peer's network-alias URL (one pass, static)", async () => {
    const f = fakeDocker();
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      dependencies: [],
      services: [
        {
          name: "agent-server",
          image: "reg/bu-agent:1",
          port: 8000,
          needs: ["mcp"],
          perRun: [],
          replicas: 1,
          env: { MCP_URL: "{{mcp}}", MCP_HOST: "{{mcp.host}}", MCP_PORT: "{{mcp.port}}" },
        },
        { name: "mcp", image: "reg/mcp:1", port: 9000, needs: [], perRun: [], replicas: 1, env: {} },
      ],
    };
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(spec);
    const agent = f.runs.find((r) => r.alias === "agent-server");
    expect(agent?.env?.MCP_URL).toBe("http://mcp:9000"); // bare token = the peer's alias URL
    expect(agent?.env?.MCP_HOST).toBe("mcp");
    expect(agent?.env?.MCP_PORT).toBe("9000");
  });

  it("ensureTopology: runner redeploy — succeeds without a collision by pre-removing leftover fixed-name containers via rm", async () => {
    // Like a real daemon, docker run (--name) is non-idempotent: a live same-name container collides (throws). Reproduce a leftover container from a prior deploy.
    const live = new Set<string>(["everdict-bu-1.0.0-bu-postgres", "everdict-bu-1.0.0-agent-server"]);
    const docker: Docker = {
      async ensureNetwork() {},
      async run(spec) {
        if (live.has(spec.name)) throw new Error(`container name already in use: ${spec.name}`);
        live.add(spec.name);
        return `cid-${spec.name}`;
      },
      async hostPort() {
        return 49152;
      },
      async exec() {},
      async execCapture() {
        return "";
      },
      async rm(c) {
        for (const name of c) live.delete(name);
      },
      async removeNetwork() {},
      async running(names) {
        return names.filter((n) => live.has(n)); // partial set (2 of 3) → adoption declines → rm+redeploy path
      },
      async createNetwork() {
        return true;
      },
      async networkCreatedAt() {
        return undefined;
      },
    };
    const rt = new DockerTopologyRuntime({ docker, fetchImpl: okFetch });
    // If a leftover container isn't rm'd before run, this throws on a name-collision cascade (regression guard).
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ensureTopology: a re-call for the same version is a warm cache — no redeploy", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    f.runningNames.push(...f.runs.map((r) => r.name)); // the deployed containers are up (the warm liveness check sees 3/3)
    const runsAfterFirst = f.runs.length;
    await rt.ensureTopology(SPEC);
    expect(f.runs.length).toBe(runsAfterFirst); // the second is cached
  });

  it("ensureTopology: concurrent calls are single-flight — deploys the same topology only once (no duplicate docker run)", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    // Under case-level parallelism, concurrent ensures while warm is still empty → if two deploy, the fixed-name containers collide.
    const [a, b, c] = await Promise.all([rt.ensureTopology(SPEC), rt.ensureTopology(SPEC), rt.ensureTopology(SPEC)]);
    expect(f.networks).toEqual(["everdict-bu-1.0.0"]); // network once
    expect(f.runs.map((r) => r.alias)).toEqual(["bu-postgres", "bu-redis", "agent-server"]); // only one deploy's worth
    expect(a).toEqual(b); // all three share the same handle
    expect(b).toEqual(c);
  });

  it("ensureTopology: a re-call after a failed deploy tries fresh (a failed topology isn't cached in single-flight)", async () => {
    const f = fakeDocker();
    let firstNetwork = true;
    f.docker.createNetwork = async (name: string) => {
      if (firstNetwork) {
        firstNetwork = false;
        throw new Error("docker down");
      }
      f.networks.push(name);
      return true;
    };
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await expect(rt.ensureTopology(SPEC)).rejects.toThrow("docker down");
    // inFlight must have been cleared for the retry to work (caching the failure would fail forever).
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("provisionBrowserEnv: browser container + cdpUrl (internal alias) + snapshot (fetch via host port)", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    const browser = await rt.provisionBrowserEnv(SPEC, "run-1");
    // the address the agent (inside the network) reaches — the internal alias.
    expect(browser.wiring.target_cdp_url).toBe("http://browser-run-1:9222");
    const snap = await browser.snapshot();
    if (snap.kind !== "browser") throw new Error("expected a browser snapshot");
    expect(snap.url).toBe("https://x");
    // dispose removes only the browser container (keeps the warm topology).
    await browser.dispose();
    expect(f.removed).toContain("everdict-bu-1.0.0-browser-run-1");
  });

  it("provisionBrowserEnv: a declared client-extension image replaces the browser AND keeps its own launch args", async () => {
    // Ignoring target.extension.ref was silent: the case ran against a plain headless browser with no extension
    // and simply scored badly. Docker is the runtime the self-hosted runner uses, so this is where a harness that
    // works on Nomad would quietly stop evaluating the thing it exists to evaluate.
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    const withExt = {
      ...SPEC,
      target: { ...SPEC.target, kind: "browser" as const, extension: { ref: "reg/spica-ext:1" } },
    } as typeof SPEC;
    await rt.ensureTopology(withExt);
    await rt.provisionBrowserEnv(withExt, "run-ext");

    const browserRun = f.runs.find((r) => String(r.name).includes("browser-run-ext"));
    expect(browserRun?.image).toBe("reg/spica-ext:1");
    // No args: the image launches headful Chromium with --load-extension from its own entrypoint.
    expect(browserRun?.args).toBeUndefined();
  });

  it("provisionBrowserEnv snapshot: captures the REAL page DOM + screenshot via CDP (browser benchmark grading signals)", async () => {
    // Regression: dom used to be JSON.stringify(targets) (the CDP target list), not the rendered page — so a live
    // front-door run couldn't be graded on page content (dom-contains / WebArena string_match / program_html) and
    // WebVoyager had no screenshot. Now the snapshot pulls outerHTML + a PNG over CDP.
    const html = "<html><body><h1>Cart</h1><span id='total'>$42.00</span></body></html>";
    const cdpFetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/json/list"))
        return new Response(JSON.stringify([{ url: "https://shop.example/cart" }]), { status: 200 });
      if (u.endsWith("/json"))
        return new Response(
          JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://browser-run-1:9222/page/1" }]),
          { status: 200 },
        );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    // fake CDP socket — replies to Runtime.evaluate (DOM) and Page.captureScreenshot (PNG)
    const connect = (_url: string): CdpSocket => {
      const msgHandlers: Array<(ev: { data: unknown }) => void> = [];
      return {
        send(data: string) {
          const sent = JSON.parse(data) as { method?: string };
          const out =
            sent.method === "Runtime.evaluate"
              ? { id: 1, result: { result: { type: "string", value: html } } }
              : sent.method === "Page.captureScreenshot"
                ? { id: 1, result: { data: "PNGB64" } }
                : undefined;
          if (out)
            queueMicrotask(() => {
              for (const h of msgHandlers) h({ data: JSON.stringify(out) });
            });
        },
        close() {},
        addEventListener(type: "message" | "open" | "error", cb: ((ev: { data: unknown }) => void) & (() => void)) {
          if (type === "message") msgHandlers.push(cb);
          else if (type === "open") queueMicrotask(() => cb());
        },
      } as CdpSocket;
    };
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: cdpFetch, cdpConnect: connect });
    await rt.ensureTopology(SPEC);
    const browser = await rt.provisionBrowserEnv(SPEC, "run-1");
    const snap = await browser.snapshot();
    if (snap.kind !== "browser") throw new Error("expected a browser snapshot");
    expect(snap.url).toBe("https://shop.example/cart");
    expect(snap.dom).toBe(html); // the rendered HTML, not the target list JSON
    expect(snap.dom).toContain("$42.00"); // a benchmark grader can now string-match page content
    expect(snap.screenshot).toBe("PNGB64"); // embedded for VLM (WebVoyager) judging
  });

  it("ensureTopology: a retry after partial failure succeeds without a container name collision (cascade prevention)", async () => {
    // A fake that behaves like a real daemon — docker run (--name) is non-idempotent, so a live same-name container collides (throws).
    // The store fails readiness on the first topology attempt (exec throws) → ensureTopology throws midway.
    const live = new Set<string>();
    const removed: string[] = [];
    let storeReady = false; // not ready on the first attempt → turned on just before the second.
    const docker: Docker = {
      async ensureNetwork() {},
      async run(spec) {
        if (live.has(spec.name)) throw new Error(`container name already in use: ${spec.name}`);
        live.add(spec.name);
        return `cid-${spec.name}`;
      },
      async hostPort() {
        return 49152;
      },
      async exec() {
        if (!storeReady) throw new Error("store not accepting yet");
      },
      async execCapture() {
        return "";
      },
      async rm(c) {
        for (const name of c) live.delete(name);
        removed.push(...c);
      },
      async removeNetwork() {},
      async running(names) {
        return names.filter((n) => live.has(n)); // empty on both attempts (first = fresh, second = cleaned up)
      },
      async createNetwork() {
        return true;
      },
      async networkCreatedAt() {
        return undefined;
      },
    };
    // readyTimeoutMs/pollIntervalMs at 1ms — so the failure-path polling ends immediately.
    const rt = new DockerTopologyRuntime({ docker, fetchImpl: okFetch, readyTimeoutMs: 1, pollIntervalMs: 1 });

    // First attempt: store readiness fails → throw. Once cleaned up, the postgres container leaves live.
    await expect(rt.ensureTopology(SPEC)).rejects.toThrow();
    expect(removed).toContain("everdict-bu-1.0.0-bu-postgres"); // the partial startup is cleaned up (before the fix, empty → cascade)

    // Second attempt: the store is ready now. Before the fix, this is where it would collide (throw) with the postgres name left by the first.
    storeReady = true;
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ensureTopology: passes service volumes to docker run as -v", async () => {
    const f = fakeDocker();
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "agent-server",
          image: "reg/bu-agent:1",
          port: 8000,
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          volumes: ["bu-cache:/cache", "/data:/data:ro"],
        },
      ],
    };
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(spec);
    const agent = f.runs.find((r) => r.alias === "agent-server");
    expect(agent?.volumes).toEqual(["bu-cache:/cache", "/data:/data:ro"]);
  });

  it("ensureTopology: applies the service-declared readiness budget (times out fast, not the runtime 60s default)", async () => {
    // The endpoint is 500 forever — never ready. With per-service readiness (30/10ms) it times out within ~30ms;
    // had the runtime default (60s) applied, it would have hit vitest's 5s timeout and failed → proving per-service is applied.
    const never: typeof fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const f = fakeDocker();
    const spec: ServiceHarnessSpec = {
      ...SPEC,
      services: [
        {
          name: "agent-server",
          image: "reg/bu-agent:1",
          port: 8000,
          needs: [],
          perRun: [],
          replicas: 1,
          env: {},
          readiness: { timeoutMs: 30, intervalMs: 10 },
        },
      ],
    };
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: never });
    await expect(rt.ensureTopology(spec)).rejects.toThrow(/never became reachable/);
  });

  it("teardown: removes the topology containers + network", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    const beforeTeardown = f.removed.length; // check only teardown removals, after the idempotent rm during ensure (before each container run)
    await rt.teardown(SPEC);
    expect(f.removed.slice(beforeTeardown)).toEqual([
      "everdict-bu-1.0.0-bu-postgres",
      "everdict-bu-1.0.0-bu-redis",
      "everdict-bu-1.0.0-agent-server",
    ]);
    expect(f.rmNets).toEqual(["everdict-bu-1.0.0"]);
  });
});

// A9 — warm-topology reclamation on the laptop runner: teardown() existed but had NO caller, so superseded warm
// topologies (containers + networks) accumulated forever on the user's daemon.
describe("DockerTopologyRuntime — warm-topology idle reclamation", () => {
  it("sweepIdle removes an idle warm topology's containers + network; an actively-touched one survives", async () => {
    const f = fakeDocker();
    let t = 0;
    const rt = new DockerTopologyRuntime({
      docker: f.docker,
      fetchImpl: okFetch,
      warmIdleTtlMs: 0, // self-timer off — sweeps driven explicitly for determinism
      now: () => t,
    });
    await rt.ensureTopology(SPEC);
    // Keep the containers "running" so the warm-cache liveness guard serves (and touches) the cached entry.
    f.runningNames.push(
      "everdict-bu-1.0.0-bu-postgres",
      "everdict-bu-1.0.0-bu-redis",
      "everdict-bu-1.0.0-agent-server",
    );
    const baseline = f.removed.length; // deploy itself does idempotent pre-rm's — only count NEW removals below
    // Given the topology stays actively used — Then a sweep reclaims nothing
    t = 4 * 60_000;
    await rt.ensureTopology(SPEC); // cache hit → touch
    t = 8 * 60_000; // 4 min since last use
    expect(await rt.sweepIdle(5 * 60_000)).toEqual([]);
    expect(f.removed.length).toBe(baseline);
    // Given it then idles past the TTL — Then the sweep tears containers + network down
    t = 20 * 60_000;
    expect(await rt.sweepIdle(5 * 60_000)).toEqual(["bu@1.0.0"]);
    expect(f.removed.slice(baseline)).toEqual(expect.arrayContaining(["everdict-bu-1.0.0-agent-server"]));
    expect(f.rmNets).toContain("everdict-bu-1.0.0");
  });

  // ── [COUNTEREXAMPLE] TWO RECLAIMERS FOR ONE OBJECT (world-and-engagement-model.md, 3.9) ────────────
  //
  // A created WORLD is owned by the created-world ledger, whose refcount says how many cases are inside it.
  // The warm pool answers the same question from `lastUsedAt`, which is bumped by `ensureTopology` — and a
  // world shared by a batch is ensured ONCE. With the default thirty-minute idle TTL, any batch longer than
  // that would have its world reclaimed underneath live cases, and every score after that would read as an
  // ordinary agent failure. So the sweeper defers, and this is the assertion that says so.
  it("never reclaims a created WORLD, however idle it looks — the ledger owns that decision", async () => {
    const f = fakeDocker();
    let t = 0;
    const rt = new DockerTopologyRuntime({
      docker: f.docker,
      fetchImpl: okFetch,
      warmIdleTtlMs: 0, // self-timer off — the sweep below is driven explicitly
      now: () => t,
    });
    await rt.ensureTopology({ ...SPEC, id: worldTopologyId("run-1") });
    const baseline = f.removed.length;
    // Hours after the one and only ensure: to the pool this looks like the idlest thing it has.
    t = 6 * 60 * 60_000;
    expect(await rt.sweepIdle(5 * 60_000)).toEqual([]);
    expect(f.removed.length, "a world torn out from under a live batch reads as an agent that failed").toBe(baseline);
    // …and an ordinary topology of the same age is still reclaimed, so the exemption is the world's alone.
    await rt.ensureTopology(SPEC);
    t = 12 * 60 * 60_000;
    expect(await rt.sweepIdle(5 * 60_000)).toEqual(["bu@1.0.0"]);
  });
});
