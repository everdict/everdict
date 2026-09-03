import {
  BadRequestError,
  type BrowserSnapshot,
  type ServiceHarnessSpec,
  type ServiceReadiness,
  type StoreReadQuery,
  UpstreamError,
  serviceIsHostExec,
} from "@everdict/contracts";
import type { TopologyStatus } from "@everdict/contracts/wire";
import { type CdpSocket, captureCdpDom, captureCdpScreenshot } from "../front-door/capture-cdp.js";
import { DEFAULT_BROWSER_IMAGE } from "./browser-image.js";
import {
  dependencyConnEnv,
  dependencyStoreValues,
  dependencyStores,
  resolveStoreConfig,
  storeArgs,
  storeName,
} from "./dependencies.js";
import { type Docker, dockerCli } from "./docker.js";
import { dependencyInjectEnv } from "./inject-env.js";
import { interpolateServiceEnv, staticWiringEnv } from "./nomad-topology.js";
import { aliasPeerHost } from "./peer-resolver.js";
import { endpointUnreachableError } from "./reachability.js";
import { type StoreSeedPlan, buildReadExec, buildSeedExec, resolveStoreReadSlice } from "./store-seed.js";
import {
  DEFAULT_WARM_IDLE_TTL_MS,
  DEFAULT_WARM_SWEEP_INTERVAL_MS,
  type TargetEnvHandle,
  type TopologyHandle,
  type TopologyRuntime,
  isWorldTopology,
} from "./topology-runtime.js";

export interface DockerTopologyRuntimeOptions {
  docker?: Docker; // injectable (tests pass a fake Docker). Default execFile("docker", …)
  browserImage?: string; // per-case browser image (default = DEFAULT_BROWSER_IMAGE, the pinned headless-shell)
  storeEnv?: Record<string, string>; // explicit connection env (overrides the automatic connEnv — per-harness variable names)
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch; // for endpoint readiness/CDP lookups (test injection)
  cdpConnect?: (url: string) => CdpSocket; // CDP WebSocket factory for DOM/screenshot capture (test injection; default = global WebSocket)
  // Warm-topology reclamation (A9): tear down warm entries idle past this TTL (default 30 min; <=0 disables).
  warmIdleTtlMs?: number;
  sweepIntervalMs?: number; // reclamation loop cadence (default 60s)
  now?: () => number; // injectable clock (idle-TTL test determinism)
}

interface WarmEntry {
  handle: TopologyHandle;
  network: string;
  containers: string[]; // the containers this topology brought up (teardown targets)
  spec: ServiceHarnessSpec; // idle-sweep input (A9) — teardown resolves names from the spec
  lastUsedAt: number;
}

// Sanitize to the docker naming rule ([a-zA-Z0-9][a-zA-Z0-9_.-]).
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
function netName(spec: ServiceHarnessSpec): string {
  return `everdict-${sanitize(spec.id)}-${sanitize(spec.version)}`;
}
// The heal-lock network name — the daemon-atomic mutex that serializes demolition+redeploy of a maimed set.
function healLockName(network: string): string {
  return `${network}.heal`;
}

// Store liveness probe command (docker exec). Shared by the deploy-time readiness poll and the
// adoption single-shot probe so both judge "accepting connections" identically. minio has none (skipped).
// postgres is probed over TCP (`-h 127.0.0.1`), NOT the socket: first-boot initdb runs a temporary server on the
// socket only (listen_addresses='') and then restarts for the real TCP server — a socket probe passes on that temp
// server and lets a seed race the restart ("the database system is shutting down"). TCP passes only on the real server.
function storeProbeCmd(store: string): string[] | undefined {
  return store === "postgres"
    ? ["pg_isready", "-h", "127.0.0.1", "-U", "everdict"]
    : store === "redis"
      ? ["redis-cli", "ping"]
      : undefined;
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
    // The Docker runtime only realizes containers — a host-exec service (raw_exec-style, exec.kind "host") has no
    // non-container path here. Fail fast and honestly instead of `docker run`-ing an imageless service.
    const hostSvc = spec.services.find((s) => serviceIsHostExec(s));
    if (hostSvc) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: hostSvc.name },
        `Host-exec service "${hostSvc.name}" cannot run on the Docker runtime (containers only) — use a Nomad runtime (raw_exec).`,
      );
    }
    this.ensureSweeper(); // lazy-start the idle-TTL reclamation loop (A9) — see sweepIdle
    const key = `${spec.id}@${spec.version}`;
    const cached = this.warm.get(key);
    if (cached) {
      // Warm-poisoning guard: a warm handle whose containers died (crash / docker rm / host reboot) must not
      // be served forever — every later case would fail against dead endpoints with no self-heal. One docker ps
      // per ensure is cheap; on a partial/absent set, drop the entry and fall through to adopt-or-redeploy.
      const up = await this.docker.running(cached.containers).catch(() => undefined);
      if (up === undefined || up.length === cached.containers.length) {
        cached.lastUsedAt = this.now(); // touch — an actively-used topology never idles out (A9)
        return cached.handle; // daemon blip → serve cached (best effort)
      }
      this.warm.delete(key);
    }
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight; // concurrent ensures join in — prevents duplicate deploy (name collision)

    // Register the deploy promise in inFlight so concurrent callers share it, and remove it on completion (success/failure).
    // On failure, deploy cleans up the partial startup and throws → not cached in warm (the next ensure retries fresh).
    const p = this.deploy(spec, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  // Deploy coordination (cross-process safe). Container names are deterministic — every runner process on
  // this daemon reaches the same ones — so deploy arbitration must be atomic ON THE DAEMON:
  //   1) adopt: a fully-running, ready same-name topology is adopted, never torn down (adopt-don't-kill);
  //   2) cold start: `docker network create` is atomic → exactly one process wins and deploys; losers
  //      wait-adopt the winner's topology (never rm its half-deployed containers);
  //   3) heal: a MAIMED set (some containers dead — crash, docker rm) can't be adopted and can't be
  //      arbitrated by the main network (it still exists), so demolition+redeploy is serialized by a
  //      dedicated heal-lock network (`<network>.heal`, atomic create; stale locks expire by age). The
  //      lock loser loops back and adopts the healer's fresh deploy.
  // Bounded attempts: adopt → cold-start race → wait → heal → (loop). Design: self-hosted-service-runner.md.
  private async deploy(spec: ServiceHarnessSpec, key: string): Promise<TopologyHandle> {
    const network = netName(spec);
    for (let attempt = 0; attempt < 3; attempt++) {
      const adopted = await this.tryAdopt(spec, network);
      if (adopted) {
        this.warm.set(key, adopted);
        return adopted.handle;
      }
      if (await this.docker.createNetwork(network)) {
        const handle = await this.deployContainers(spec, network); // we own the fresh network → deploy
        this.warm.set(key, this.warmEntryFor(spec, network, handle));
        return handle;
      }
      const later = await this.waitAdopt(spec, network);
      if (later) {
        this.warm.set(key, later);
        return later.handle;
      }
      // Nothing became adoptable within the budget: the network fronts a stale or maimed set. Serialize the
      // demolition behind the heal lock — the winner clears + redeploys, losers loop back and adopt.
      if (await this.acquireHealLock(network)) {
        try {
          await this.docker.rm(this.topologyContainerNames(spec, network)).catch(() => {});
          await this.docker.removeNetwork(network).catch(() => {});
          if (await this.docker.createNetwork(network)) {
            const handle = await this.deployContainers(spec, network);
            this.warm.set(key, this.warmEntryFor(spec, network, handle));
            return handle;
          }
        } finally {
          await this.docker.removeNetwork(healLockName(network)).catch(() => {});
        }
      }
      // heal lock lost (another process is healing) or an unlucky re-create race — loop and adopt theirs.
    }
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { network },
      "Could not deploy, adopt, or heal the topology after repeated attempts — inspect the docker daemon state.",
    );
  }

  // The live per-service DETAIL roster of the warm topology (topology observability) — the declared identity
  // (role/image/port) + running/absent per deterministic container name + the warm endpoint. Docker `ps` carries
  // no restart/event history, so those fields stay absent here. Best-effort.
  async describeTopology(spec: ServiceHarnessSpec): Promise<TopologyStatus | undefined> {
    try {
      const network = netName(spec);
      const rows: Array<{
        name: string;
        role: "service" | "store";
        image?: string;
        port?: number;
        container: string;
      }> = [
        ...dependencyStores(spec).map(({ name, def }) => ({
          name,
          role: "store" as const,
          image: def.image,
          port: def.port,
          container: `${network}-${name}`,
        })),
        ...spec.services.map((svc) => ({
          name: svc.name,
          role: "service" as const,
          ...(svc.image ? { image: svc.image } : {}),
          ...(svc.port !== undefined ? { port: svc.port } : {}),
          container: `${network}-${sanitize(svc.name)}`,
        })),
      ];
      const up = new Set(await this.docker.running(rows.map((r) => r.container)));
      const endpoints = this.warm.get(`${spec.id}@${spec.version}`)?.handle.endpoints ?? {};
      const services = rows.map(({ container, ...identity }) => ({
        ...identity,
        status: up.has(container) ? "running" : "absent",
        ready: up.has(container),
        ...(endpoints[identity.name] ? { endpoint: endpoints[identity.name] } : {}),
        events: [],
      }));
      return { deployed: services.some((s) => s.ready), runtime: "docker", services };
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // One deployed service's (or store's) current log tail — `docker logs` on the deterministic container name.
  async serviceLogs(spec: ServiceHarnessSpec, service: string): Promise<string | undefined> {
    const read = this.docker.logs?.bind(this.docker);
    if (!read) return undefined;
    try {
      const network = netName(spec);
      const container = spec.services.some((s) => s.name === service)
        ? `${network}-${sanitize(service)}`
        : dependencyStores(spec).some(({ name }) => name === service)
          ? `${network}-${service}`
          : undefined;
      if (!container) return undefined;
      return await read(container);
    } catch {
      return undefined; // best-effort — observability must never fail a run
    }
  }

  // All this topology's deterministic container names (stores + services) — adoption/heal targets.
  private topologyContainerNames(spec: ServiceHarnessSpec, network: string): string[] {
    return [
      ...dependencyStores(spec).map(({ name }) => `${network}-${name}`),
      ...spec.services.map((svc) => `${network}-${sanitize(svc.name)}`),
    ];
  }

  private warmEntryFor(spec: ServiceHarnessSpec, network: string, handle: TopologyHandle): WarmEntry {
    return { handle, network, containers: this.topologyContainerNames(spec, network), spec, lastUsedAt: this.now() };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  // Lazy-start the reclamation loop (A9) — one unref'd interval per runtime instance. Isomorphic to Nomad/K8s.
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private ensureSweeper(): void {
    if (this.sweeper !== undefined) return;
    const ttl = this.opts.warmIdleTtlMs ?? DEFAULT_WARM_IDLE_TTL_MS;
    if (ttl <= 0) return; // 0/negative = reclamation disabled (operator opt-out)
    this.sweeper = setInterval(() => {
      void this.sweepIdle(ttl).catch(() => {});
    }, this.opts.sweepIntervalMs ?? DEFAULT_WARM_SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  // Reclaim idle warm topologies (A9) — teardown() existed but had NO caller, so a laptop runner accumulated
  // superseded warm topologies (containers + networks) forever. Best-effort per entry; never throws.
  async sweepIdle(idleMs: number): Promise<string[]> {
    const cutoff = this.now() - idleMs;
    const reclaimed: string[] = [];
    for (const [key, entry] of [...this.warm]) {
      if (entry.lastUsedAt > cutoff) continue;
      if (this.inFlight.has(key)) continue; // a deploy in flight = someone wants it right now — not idle
      // A created WORLD is the ledger's to reclaim, never this pool's: it is ensured once and used by every
      // case of a batch, so `lastUsedAt` says idle while cases are still inside it (`isWorldTopology`).
      if (isWorldTopology(entry.spec.id)) continue;
      await this.teardown(entry.spec).catch(() => {});
      reclaimed.push(key);
    }
    return reclaimed;
  }

  // Win the right to demolish+redeploy a stuck topology. Atomic via network create; a lock left by a
  // crashed healer expires by age (readiness budget + slack) and is broken by the next contender.
  private async acquireHealLock(network: string): Promise<boolean> {
    const lock = healLockName(network);
    if (await this.docker.createNetwork(lock)) return true;
    const createdAt = await this.docker.networkCreatedAt(lock);
    const staleMs = this.defaultReadyTimeoutMs + 30_000;
    if (createdAt !== undefined && Date.now() - createdAt > staleMs) {
      await this.docker.removeNetwork(lock).catch(() => {});
      return this.docker.createNetwork(lock); // re-race after breaking the stale lock — one contender wins
    }
    return false;
  }

  // The container deploy itself (stores → services) onto an OWNED network. Only the arbitration in deploy() calls it.
  private async deployContainers(spec: ServiceHarnessSpec, network: string): Promise<TopologyHandle> {
    // Names of the containers we brought up (or tried to) — cleanup targets on partial failure. Pushed before run, so a name whose run itself threw is still caught.
    const containers: string[] = [];
    try {
      // 1) Dependency stores (one per type) — network alias = `<id>-<store>` (matches the host in dependencyConnEnv → services connect by that name).
      for (const { store, name, def } of dependencyStores(spec)) {
        const cname = `${network}-${name}`;
        containers.push(cname);
        await this.docker.rm([cname]).catch(() => {}); // idempotent redeploy — first remove a leftover same-name container from a runner restart (avoid --name collision cascade)
        const args = storeArgs(store, def, resolveStoreConfig(spec.dependencies, store)); // per-role tuning (plumbing→cache, data→durable)
        await this.docker.run({ name: cname, image: def.image, network, alias: name, env: def.env, args });
        await this.waitStoreAccepting(store, cname); // pg_isready/redis ping — ready it first since services connect on boot.
      }
      // Service connection env: automatic connEnv (<id>-<store>:<port>). Precedence: connEnv < svc.env (service static) < storeEnv (explicit wins).
      const connEnv = dependencyConnEnv(spec);
      // Structured coordinates of the SAME stores — dependencies[].inject renders BYO env names from these, merged topmost
      // (an inject mapping is the deployed truth; neither a stale service.env literal nor storeEnv may shadow it).
      const storeValues = dependencyStoreValues(spec);

      // 2) Services — alias = svc.name (needs/front-door internal address). With a port, publish to an arbitrary host port → the runner (outside docker) can reach it.
      const endpoints: Record<string, string> = {};
      for (const svc of spec.services) {
        const cname = `${network}-${sanitize(svc.name)}`;
        containers.push(cname);
        await this.docker.rm([cname]).catch(() => {}); // idempotent redeploy — remove a leftover same-name container (avoid the non-idempotent --name collision cascade)
        if (svc.image === undefined) {
          // ensureTopology already rejected host-exec specs — this guards registry-bypassing callers.
          throw new BadRequestError(
            "BAD_REQUEST",
            { service: svc.name },
            `Containerized service "${svc.name}" has no image.`,
          );
        }
        await this.docker.run({
          name: cname,
          image: svc.image,
          network,
          alias: svc.name,
          // Peer wiring (BYO env names) resolves to the peer's network alias (svc.name). connEnv < wiring < service env
          // (with {{peer}} refs → the peer's alias URL) < storeEnv < dependency inject (BYO store env names).
          env: {
            ...connEnv,
            ...staticWiringEnv(svc, spec.services, aliasPeerHost),
            ...interpolateServiceEnv(svc, spec.services, aliasPeerHost),
            ...this.opts.storeEnv,
            ...dependencyInjectEnv(spec, storeValues, svc.name),
          },
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
      return handle;
    } catch (err) {
      // Clean up the partial startup — a leftover fixed-name container makes the next case's docker run (--name is non-idempotent) cascade-fail on a name collision.
      // A failed topology is never put in the warm cache (no caching broken handles), so teardown can't catch it either → remove it here immediately.
      await this.docker.rm(containers).catch(() => {});
      await this.docker.removeNetwork(network).catch(() => {});
      throw err;
    }
  }

  // Adoption probe: the whole deterministic container set must be RUNNING, every store must accept a
  // connection, and every ported service must answer HTTP — all single-shot (an adoptable topology is
  // already ready; a mid-deploy or wedged set fails a probe and falls back to rm+redeploy). Returns the
  // warm entry to cache, or undefined to take the fresh-deploy path.
  private async tryAdopt(spec: ServiceHarnessSpec, network: string): Promise<WarmEntry | undefined> {
    const stores = dependencyStores(spec).map(({ store, name }) => ({ store, cname: `${network}-${name}` }));
    const services = spec.services.map((svc) => ({ svc, cname: `${network}-${sanitize(svc.name)}` }));
    const names = [...stores.map((s) => s.cname), ...services.map((s) => s.cname)];
    if (names.length === 0) return undefined;
    const up = await this.docker.running(names).catch(() => []);
    if (up.length !== names.length) return undefined; // absent, stopped, or partial → rm+redeploy
    try {
      for (const { store, cname } of stores) {
        const probe = storeProbeCmd(store);
        if (probe) await this.docker.exec(cname, probe);
      }
      const endpoints: Record<string, string> = {};
      for (const { svc, cname } of services) {
        if (svc.port === undefined) continue; // no probe surface — adopted alongside its ported peers
        const hostPort = await this.docker.hostPort(cname, svc.port);
        const url = `http://127.0.0.1:${hostPort}`;
        if ((await this.fetchImpl(url)).status >= 500) return undefined;
        endpoints[svc.name] = url;
      }
      return { handle: { endpoints }, network, containers: names, spec, lastUsedAt: this.now() };
    } catch {
      return undefined; // any probe failure = not adoptable (never kills what it probed — redeploy decides)
    }
  }

  // Wait for another process's in-flight deploy of the SAME topology to become adoptable (the cold-start
  // loser's path). Zero running containers across a few polls = no deploy is actually happening behind the
  // existing network (a crashed deployer's leftover) → give up so the caller takes over. Bounded by the
  // runtime readiness budget — the same patience a fresh deploy's slowest service would get.
  private async waitAdopt(spec: ServiceHarnessSpec, network: string): Promise<WarmEntry | undefined> {
    const names = this.topologyContainerNames(spec, network);
    const intervalMs = this.defaultIntervalMs;
    const deadline = Date.now() + this.defaultReadyTimeoutMs;
    let idlePolls = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const adopted = await this.tryAdopt(spec, network);
      if (adopted) return adopted;
      const up = await this.docker.running(names).catch(() => []);
      if (up.length === 0) {
        idlePolls += 1;
        if (idlePolls >= 3) return undefined; // nothing is coming — stale network, take over
      } else {
        idlePolls = 0; // containers exist → a deploy is in progress, keep waiting
      }
    }
    return undefined;
  }

  // World-state fixture seeding (P2): apply each resolved plan inside its store container in the warm topology. The
  // container name is deterministic (`<network>-<id>-<store>`), so the seed reaches the same store the services connect
  // to; buildSeedExec produces the in-container command (psql into the schema slice). A failed exec rejects → fails the
  // run (a precondition). docs/architecture/dependency-store-roles.md P2.
  async seedFixtures(spec: ServiceHarnessSpec, _runId: string, plans: StoreSeedPlan[]): Promise<void> {
    const network = netName(spec);
    for (const plan of plans) {
      const exec = buildSeedExec(plan);
      const cname = `${network}-${storeName(spec, exec.store)}`;
      for (const argv of exec.argvs) await this.docker.exec(cname, argv);
    }
  }

  // Store-state grading read (P2): resolve the store's per-case slice and run the query there, capturing stdout. The
  // co-located read the grader can't do remotely (buildReadExec = tuples-only psql / redis-cli, scoped to the slice).
  async readStoreState(spec: ServiceHarnessSpec, runId: string, query: StoreReadQuery): Promise<string> {
    const slice = resolveStoreReadSlice(spec.dependencies, query.store, query.role, runId);
    const cname = `${netName(spec)}-${storeName(spec, query.store)}`;
    return await this.docker.execCapture(cname, buildReadExec(query.store, slice, query.query));
  }

  async provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string): Promise<TargetEnvHandle> {
    const key = `${spec.id}@${spec.version}`;
    const network = this.warm.get(key)?.network ?? netName(spec);
    const alias = `browser-${sanitize(runId)}`;
    const cname = `${network}-${alias}`;
    // The harness's client-extension browser wins over any default: it is a headful image that loads the
    // extension from its OWN entrypoint, so it also gets NO args — passing them would replace that launch line.
    // Ignoring the declaration was silent, and silence here means the case runs without the extension it exists
    // to evaluate and scores badly for a reason nothing reports.
    const extensionImage = spec.target?.kind === "browser" ? spec.target.extension?.ref : undefined;
    await this.docker.run({
      name: cname,
      image: extensionImage ?? this.opts.browserImage ?? DEFAULT_BROWSER_IMAGE,
      network,
      alias,
      publish: 9222,
      ...(extensionImage ? {} : { args: ["--remote-allow-origins=*"] }), // headless-shell exposes CDP itself on 9222
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
    const cdpConnect = this.opts.cdpConnect;
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
      // The runner-reachable CDP (host published port) — where the environment recorder taps network/console/nav.
      cdpBase: hostCdp,
      async snapshot(): Promise<BrowserSnapshot> {
        let targets: Array<{ url?: string }> = [];
        try {
          targets = (await (await fetchImpl(`${hostCdp}/json/list`)).json()) as typeof targets;
        } catch {
          targets = [];
        }
        // The rendered page DOM (post-JS outerHTML) — the observation real browser benchmarks grade on
        // (dom-contains, WebArena string_match/program_html, WebShop). Best-effort: fall back to the CDP target list
        // if the page can't be evaluated, so a snapshot always returns.
        const cdpOpts = { fetch: fetchImpl, ...(cdpConnect ? { connect: cdpConnect } : {}) };
        let dom = "";
        try {
          dom = await captureCdpDom(hostCdp, cdpOpts);
        } catch {
          dom = "";
        }
        // Screenshot for VLM judging (WebVoyager). Inline base64, best-effort; offloadSnapshot moves it to object
        // storage so the persisted record stays slim (parity with os-use).
        let screenshot: string | undefined;
        try {
          screenshot = await captureCdpScreenshot(hostCdp, cdpOpts);
        } catch {
          screenshot = undefined;
        }
        return {
          kind: "browser",
          url: targets[0]?.url ?? "about:blank",
          dom: dom || JSON.stringify(targets),
          screenshotRef: `runs/${runId}/screenshot.png`,
          ...(screenshot ? { screenshot } : {}),
          console: [],
        };
      },
      dispose: async () => {
        await docker.rm([cname]).catch(() => {}); // remove only the per-case browser — keep the warm topology
      },
    };
  }

  // Explicit teardown — remove the warm topology's containers + network. On the port since A9 (the idle sweep calls it).
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
    const probe = storeProbeCmd(store);
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
        throw endpointUnreachableError(url);
      },
    );
  }
}
