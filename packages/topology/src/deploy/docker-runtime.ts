import {
  type BrowserSnapshot,
  type ServiceHarnessSpec,
  type ServiceReadiness,
  UpstreamError,
  flattenEnv,
} from "@everdict/core";
import { dependencyConnEnv, dependencyStores } from "./dependencies.js";
import { type Docker, dockerCli } from "./docker.js";
import type { TargetEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

export interface DockerTopologyRuntimeOptions {
  docker?: Docker; // injectable (tests pass a fake Docker). Default execFile("docker", …)
  browserImage?: string; // per-case browser image (default chromedp/headless-shell:latest)
  storeEnv?: Record<string, string>; // explicit connection env (overrides the automatic connEnv — per-harness variable names)
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch; // for endpoint readiness/CDP lookups (test injection)
}

interface WarmEntry {
  handle: TopologyHandle;
  network: string;
  containers: string[]; // the containers this topology brought up (teardown targets)
}

// Sanitize to the docker naming rule ([a-zA-Z0-9][a-zA-Z0-9_.-]).
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
function netName(spec: ServiceHarnessSpec): string {
  return `everdict-${sanitize(spec.id)}-${sanitize(spec.version)}`;
}

// Live DockerTopologyRuntime: brings up the topology (stores + services) + a per-case browser on the user's Docker daemon.
// A sibling of NomadTopologyRuntime / K8sTopologyRuntime — ServiceTopologyBackend only swaps among the three (orchestrator-agnostic).
// The local topology by which the self-hosted runner drives service harnesses on a laptop. Design: docs/architecture/self-hosted-service-runner.md.
// A personal host = a single trust domain → no TrustZone/strong-isolation/pool·silo (a design non-goal). Per-case logical isolation is handled by front-door wiring.
export class DockerTopologyRuntime implements TopologyRuntime {
  readonly id = "docker";
  private readonly docker: Docker;
  private readonly fetchImpl: typeof fetch;
  private readonly warm = new Map<string, WarmEntry>(); // key: id@version (per-version warm)
  // In-progress deploy (key: id@version) — concurrent ensures of the same topology join in (single-flight).
  // Under case-level parallelism (runner maxConcurrent), if two deploy at once while warm is still empty, the fixed-name
  // containers cascade-fail on a docker run --name collision → share the first deploy promise so the topology comes up only once per version.
  private readonly inFlight = new Map<string, Promise<TopologyHandle>>();

  constructor(private readonly opts: DockerTopologyRuntimeOptions = {}) {
    this.docker = opts.docker ?? dockerCli();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ensureTopology(spec: ServiceHarnessSpec): Promise<TopologyHandle> {
    const key = `${spec.id}@${spec.version}`;
    const cached = this.warm.get(key);
    if (cached) return cached.handle; // warm: deployed only once per version
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight; // concurrent ensures join in — prevents duplicate deploy (name collision)

    // Register the deploy promise in inFlight so concurrent callers share it, and remove it on completion (success/failure).
    // On failure, deploy cleans up the partial startup and throws → not cached in warm (the next ensure retries fresh).
    const p = this.deploy(spec, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  // The actual topology deploy (network → stores → services). Only the single-flight wrapper (ensureTopology) calls it.
  private async deploy(spec: ServiceHarnessSpec, key: string): Promise<TopologyHandle> {
    const network = netName(spec);
    // Names of the containers we brought up (or tried to) — cleanup targets on partial failure. Pushed before run, so a name whose run itself threw is still caught.
    const containers: string[] = [];
    try {
      await this.docker.ensureNetwork(network);

      // 1) Dependency stores (one per type) — network alias = `<id>-<store>` (matches the host in dependencyConnEnv → services connect by that name).
      for (const { store, name, def } of dependencyStores(spec)) {
        const cname = `${network}-${name}`;
        containers.push(cname);
        await this.docker.rm([cname]).catch(() => {}); // idempotent redeploy — first remove a leftover same-name container from a runner restart (avoid --name collision cascade)
        await this.docker.run({ name: cname, image: def.image, network, alias: name, env: def.env, args: def.args });
        await this.waitStoreAccepting(store, cname); // pg_isready/redis ping — ready it first since services connect on boot.
      }
      // Service connection env: automatic connEnv (<id>-<store>:<port>). Precedence: connEnv < svc.env (service static) < storeEnv (explicit wins).
      const connEnv = dependencyConnEnv(spec);

      // 2) Services — alias = svc.name (needs/front-door internal address). With a port, publish to an arbitrary host port → the runner (outside docker) can reach it.
      const endpoints: Record<string, string> = {};
      for (const svc of spec.services) {
        const cname = `${network}-${sanitize(svc.name)}`;
        containers.push(cname);
        await this.docker.rm([cname]).catch(() => {}); // idempotent redeploy — remove a leftover same-name container (avoid the non-idempotent --name collision cascade)
        await this.docker.run({
          name: cname,
          image: svc.image,
          network,
          alias: svc.name,
          env: { ...connEnv, ...flattenEnv(svc.env), ...this.opts.storeEnv },
          ...(svc.volumes && svc.volumes.length > 0 ? { volumes: svc.volumes } : {}),
          ...(svc.port !== undefined ? { publish: svc.port } : {}),
          // Resource request: cpu 1000 = 1 core → --cpus cores (=cpu/1000), memoryMb → --memory. Only what is defined.
          ...(svc.resources?.cpu !== undefined ? { cpus: svc.resources.cpu / 1000 } : {}),
          ...(svc.resources?.memoryMb !== undefined ? { memoryMb: svc.resources.memoryMb } : {}),
        });
        if (svc.port !== undefined) {
          const hostPort = await this.docker.hostPort(cname, svc.port);
          const url = `http://127.0.0.1:${hostPort}`;
          await this.waitForHttp(url, svc.readiness); // use the service's own readiness budget if declared, otherwise the runtime default
          endpoints[svc.name] = url;
        }
      }

      const handle: TopologyHandle = { endpoints };
      this.warm.set(key, { handle, network, containers });
      return handle;
    } catch (err) {
      // Clean up the partial startup — a leftover fixed-name container makes the next case's docker run (--name is non-idempotent) cascade-fail on a name collision.
      // A failed topology is never put in the warm cache (no caching broken handles), so teardown can't catch it either → remove it here immediately.
      await this.docker.rm(containers).catch(() => {});
      await this.docker.removeNetwork(network).catch(() => {});
      throw err;
    }
  }

  async provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string): Promise<TargetEnvHandle> {
    const key = `${spec.id}@${spec.version}`;
    const network = this.warm.get(key)?.network ?? netName(spec);
    const alias = `browser-${sanitize(runId)}`;
    const cname = `${network}-${alias}`;
    await this.docker.run({
      name: cname,
      image: this.opts.browserImage ?? "chromedp/headless-shell:latest",
      network,
      alias,
      publish: 9222,
      args: ["--remote-allow-origins=*"], // headless-shell exposes CDP itself on 9222
    });
    try {
      const hostPort = await this.docker.hostPort(cname, 9222);
      return await this.connectBrowser(runId, cname, alias, hostPort);
    } catch (err) {
      await this.docker.rm([cname]).catch(() => {});
      throw err;
    }
  }

  // Browser handle: the agent (inside the network) reaches it via cdpUrl=alias:9222, snapshot (runner = outside docker) via the host published port.
  private async connectBrowser(
    runId: string,
    cname: string,
    alias: string,
    hostPort: number,
  ): Promise<TargetEnvHandle> {
    const fetchImpl = this.fetchImpl; // capture locally since `this` changes inside the returned closures
    const docker = this.docker;
    const hostCdp = `http://127.0.0.1:${hostPort}`;
    await this.waitForHttp(`${hostCdp}/json/version`);
    try {
      await fetchImpl(`${hostCdp}/json/new?about:blank`, { method: "PUT" });
    } catch {
      // failing to create a blank tab is not fatal
    }
    return {
      // The CDP the agent (same network) reaches — injected into the front-door payload as wiring's target_cdp_url.
      wiring: { target_cdp_url: `http://${alias}:9222` },
      async snapshot(): Promise<BrowserSnapshot> {
        let targets: Array<{ url?: string }> = [];
        try {
          targets = (await (await fetchImpl(`${hostCdp}/json/list`)).json()) as typeof targets;
        } catch {
          targets = [];
        }
        return {
          kind: "browser",
          url: targets[0]?.url ?? "about:blank",
          dom: JSON.stringify(targets),
          screenshotRef: `runs/${runId}/screenshot.png`,
          console: [],
        };
      },
      dispose: async () => {
        await docker.rm([cname]).catch(() => {}); // remove only the per-case browser — keep the warm topology
      },
    };
  }

  // Explicit teardown — remove the warm topology's containers + network (outside the interface — ServiceTopologyBackend only calls dispose).
  async teardown(spec: ServiceHarnessSpec): Promise<void> {
    const key = `${spec.id}@${spec.version}`;
    const entry = this.warm.get(key);
    this.warm.delete(key);
    if (!entry) return;
    await this.docker.rm(entry.containers).catch(() => {});
    await this.docker.removeNetwork(entry.network).catch(() => {});
  }

  // Runtime default readiness (when a service declares no readiness of its own + used for store/browser polling).
  private get defaultReadyTimeoutMs(): number {
    return this.opts.readyTimeoutMs ?? 60_000;
  }
  private get defaultIntervalMs(): number {
    return this.opts.pollIntervalMs ?? 1000;
  }

  // Readiness polling (shared) — retry until probe returns true within timeoutMs/intervalMs. On timeout, throw via onTimeout.
  // A probe that throws is also treated as "not ready yet" and retried (connection refused / command failure etc.).
  private async pollReady(
    timeoutMs: number,
    intervalMs: number,
    probe: () => Promise<boolean>,
    onTimeout: () => never,
  ): Promise<void> {
    const steps = Math.max(1, Math.floor(timeoutMs / intervalMs));
    for (let i = 0; i < steps; i++) {
      try {
        if (await probe()) return;
      } catch {
        // not ready yet → retry
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    onTimeout();
  }

  // Poll until the store actually accepts connections (docker exec pg_isready / redis-cli ping). minio is skipped.
  private async waitStoreAccepting(store: string, container: string): Promise<void> {
    const probe =
      store === "postgres" ? ["pg_isready", "-U", "everdict"] : store === "redis" ? ["redis-cli", "ping"] : undefined;
    if (!probe) return;
    await this.pollReady(
      this.defaultReadyTimeoutMs,
      this.defaultIntervalMs,
      async () => {
        await this.docker.exec(container, probe);
        return true;
      },
      () => {
        throw new UpstreamError("UPSTREAM_ERROR", { store }, "Timed out waiting for the store to become ready");
      },
    );
  }

  // Wait for the HTTP endpoint to become ready. With readiness given, use the service's declared timeout/interval, otherwise the runtime default.
  private async waitForHttp(url: string, readiness?: ServiceReadiness): Promise<void> {
    await this.pollReady(
      readiness?.timeoutMs ?? this.defaultReadyTimeoutMs,
      readiness?.intervalMs ?? this.defaultIntervalMs,
      async () => (await this.fetchImpl(url)).status < 500,
      () => {
        throw new UpstreamError("UPSTREAM_ERROR", { url }, "Timed out waiting for the endpoint to become ready");
      },
    );
  }
}
