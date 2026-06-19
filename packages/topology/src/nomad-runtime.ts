import { spawn } from "node:child_process";
import { type BrowserSnapshot, type ServiceHarnessSpec, type TrustZone, UpstreamError } from "@assay/core";
import {
  type ConsulClient,
  buildSharedStoreIntention,
  buildTenantIntentions,
  meshServiceName,
} from "./consul-intentions.js";
import { STORE_DEFS, dependencyStores } from "./dependencies.js";
import {
  type AllocLike,
  SHARED_STORE_JOB_ID,
  browserJobId,
  buildBrowserJob,
  buildNomadTopologyJob,
  buildSharedStoreJob,
  resolvePort,
  topologyJobId,
} from "./nomad-topology.js";
import { type StorePlan, planTenantStores, resolveStoreIsolation } from "./store-binding.js";
import type { BrowserEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

// Nomad HTTP 추상화 (테스트에서 모킹 가능; @assay/backends 의 NomadHttp 와 동일 형태).
export interface NomadHttp {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
}

// alloc 안에서 명령 실행(공유 스토어 DDL/ACL 용). 기본 impl 은 `nomad alloc exec` CLI 로 셸아웃(K8s 의 kubectl exec 대응).
export interface NomadExec {
  exec(
    allocId: string,
    task: string,
    command: string[],
    opts?: { namespace?: string; stdin?: string },
  ): Promise<string>;
}

function nomadCliExec(addr: string, bin = "nomad"): NomadExec {
  return {
    exec(allocId, task, command, opts) {
      return new Promise<string>((resolve, reject) => {
        const args = [
          "alloc",
          "exec",
          ...(opts?.namespace ? ["-namespace", opts.namespace] : []),
          "-task",
          task,
          allocId,
          ...command,
        ];
        const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMAD_ADDR: addr } });
        let out = "";
        let err = "";
        proc.stdout.on("data", (d) => {
          out += d.toString();
        });
        proc.stderr.on("data", (d) => {
          err += d.toString();
        });
        proc.on("error", reject);
        proc.on("close", (code) =>
          code === 0
            ? resolve(out)
            : reject(new Error(`nomad alloc exec ${command[0]} failed (${code}): ${err || out}`)),
        );
        if (opts?.stdin !== undefined) proc.stdin.write(opts.stdin);
        proc.stdin.end();
      });
    },
  };
}

function fetchNomadHttp(addr: string): NomadHttp {
  const base = addr.replace(/\/$/, "");
  return {
    async request(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export interface NomadTopologyRuntimeOptions {
  addr: string; // Nomad HTTP endpoint
  http?: NomadHttp;
  exec?: NomadExec; // alloc exec (pool DDL/ACL); 기본 = nomad CLI
  consul?: ConsulClient; // 설정 시 zone.network 로 Consul Connect intentions 생성(네트워크 격리)
  datacenters?: string[];
  runtime?: string; // docker 격리 런타임 (예: "runsc" = gVisor)
  namespace?: string;
  storeEnv?: Record<string, string>; // 공유 스토어 엔드포인트 주입 (postgres/redis/minio)
  poolNamespace?: string; // pool 공유 스토어 Nomad 네임스페이스(미설정=default)
  storeSecret?: string; // pool 테넌트 비번 mint 시드(프로덕션: KEK/Vault)
  browserImage?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  readyTimeoutMs?: number;
}

// 라이브 NomadTopologyRuntime: warm 서비스 잡 등록 + 엔드포인트 발견 + per-case 브라우저(실 CDP).
// 오케스트레이터-비종속 ServiceTopologyBackend 가 이걸 통해 Nomad 위에서 토폴로지를 구동한다.
export class NomadTopologyRuntime implements TopologyRuntime {
  readonly id = "nomad";
  private readonly http: NomadHttp;
  private readonly execImpl: NomadExec;
  private readonly warm = new Map<string, TopologyHandle>(); // key: id@version
  // pool 공유 스토어: 클러스터 1회 배포 → host:port + allocId 발견(테넌트 scoped creds 엔드포인트로 사용).
  private readonly sharedStores = new Map<string, { hostPort: string; allocId: string; task: string }>();

  constructor(private readonly opts: NomadTopologyRuntimeOptions) {
    this.http = opts.http ?? fetchNomadHttp(opts.addr);
    this.execImpl = opts.exec ?? nomadCliExec(opts.addr);
  }

  async ensureTopology(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<TopologyHandle> {
    // warm 풀을 테넌트(존)별로 분리 — 임의 코드 실행을 같은 프로세스에서 공유하지 않게.
    const key = `${spec.id}@${spec.version}@${zone?.id ?? "default"}`;
    const cached = this.warm.get(key);
    if (cached) return cached; // warm: (버전,존)당 한 번만 배포

    const ns = zone?.namespace ?? this.opts.namespace;
    // pool: 공유 스토어(클러스터 1회) → 테넌트별 DB/role/ACL mint(alloc exec) → scoped creds 를 서비스 env 로.
    // (Nomad 는 Consul 없이 DNS 가 없어 K8s 와 달리 런타임에 host:port 를 발견해 주입한다.)
    let storeEnv = this.opts.storeEnv;
    if (zone && resolveStoreIsolation(zone) === "pool") {
      storeEnv = { ...(await this.provisionPool(spec, zone)), ...this.opts.storeEnv };
    }

    // 네트워크 격리: Consul Connect intentions(같은 테넌트만 allow + 그 외 deny). enforce 엔 Connect-enabled 잡 필요.
    if (zone && this.opts.consul && zone.network !== "open") {
      for (const intent of buildTenantIntentions(spec, zone)) await this.opts.consul.applyIntention(intent);
    }

    const job = buildNomadTopologyJob(spec, {
      datacenters: this.opts.datacenters,
      runtime: zone?.isolationRuntime ?? this.opts.runtime,
      namespace: ns,
      storeEnv,
      zoneId: zone?.id,
    });
    await this.register(job, ns);

    const jobId = topologyJobId(spec, zone?.id);
    const endpoints: Record<string, string> = {};
    for (const svc of spec.services) {
      if (svc.port === undefined) continue; // 포트 없는 서비스는 발견 대상 아님
      const alloc = await this.waitForGroupRunning(jobId, svc.name, ns);
      const p = resolvePort(alloc, "http");
      if (!p) {
        throw new UpstreamError("UPSTREAM_ERROR", { service: svc.name }, "서비스 포트를 alloc 에서 찾지 못했습니다.");
      }
      const url = `http://${p.hostIp}:${p.port}`;
      await this.waitForHttp(url);
      endpoints[svc.name] = url;
    }

    const handle: TopologyHandle = { endpoints };
    this.warm.set(key, handle);
    return handle;
  }

  // pool: 공유 스토어를 한 번 띄우고(host:port 발견), 테넌트별 논리객체(전용 DB+role / Redis ACL)를 alloc exec 로 mint.
  // 적대적 테넌트 코드여도 자기 DB creds 만 받으므로 교차 접근은 PG 인증/Redis ACL 에서 거부된다(K8s pool 과 동일 보장).
  private async provisionPool(spec: ServiceHarnessSpec, zone: TrustZone): Promise<Record<string, string>> {
    const ns = this.opts.poolNamespace;
    const stores = dependencyStores(spec).map((s) => s.store);
    await this.ensureSharedStores(stores);
    const plan: StorePlan = planTenantStores(spec, zone, {
      poolNamespace: this.opts.poolNamespace,
      storeSecret: this.opts.storeSecret,
      storeEndpoint: (store) => this.sharedStores.get(store)?.hostPort ?? "",
    });
    for (const t of plan.tenants) {
      const rec = this.sharedStores.get(t.store);
      if (!rec) continue;
      if (t.store === "postgres" && t.postgresSetup) {
        await this.execImpl.exec(
          rec.allocId,
          rec.task,
          ["psql", "-U", "assay", "-d", "assay", "-v", "ON_ERROR_STOP=1"],
          {
            namespace: ns,
            stdin: t.postgresSetup,
          },
        );
      } else if (t.store === "redis" && t.redisSetup) {
        for (const cmd of t.redisSetup)
          await this.execImpl.exec(rec.allocId, rec.task, ["redis-cli", ...cmd], { namespace: ns });
      }
    }
    return plan.serviceEnv;
  }

  private async ensureSharedStores(stores: string[]): Promise<void> {
    const ns = this.opts.poolNamespace;
    const missing = [...new Set(stores)].filter((s) => STORE_DEFS[s] && !this.sharedStores.has(s));
    if (missing.length === 0) return;
    await this.register(buildSharedStoreJob(missing, { datacenters: this.opts.datacenters, namespace: ns }), ns);
    for (const s of missing) {
      const task = `assay-shared-${s}`;
      const alloc = await this.waitForGroupRunning(SHARED_STORE_JOB_ID, task, ns);
      const p = resolvePort(alloc, "store");
      if (!p || !alloc.ID) {
        throw new UpstreamError("UPSTREAM_ERROR", { store: s }, "공유 스토어 포트를 alloc 에서 찾지 못했습니다.");
      }
      const rec = { hostPort: `${p.hostIp}:${p.port}`, allocId: alloc.ID, task };
      await this.waitStoreAccepting(s, rec);
      this.sharedStores.set(s, rec);
      // 공유 스토어 intention: 메시 서비스만 도달(테넌트 격리는 DB creds). enforce 엔 Connect-enabled 잡 필요.
      if (this.opts.consul) await this.opts.consul.applyIntention(buildSharedStoreIntention(s));
    }
  }

  // 스토어가 실제 연결을 받을 때까지 폴링(rollout running ≠ accepting; postgres initdb 등). DDL 전에 호출.
  private async waitStoreAccepting(store: string, rec: { allocId: string; task: string }): Promise<void> {
    const probe =
      store === "postgres" ? ["pg_isready", "-U", "assay"] : store === "redis" ? ["redis-cli", "ping"] : undefined;
    if (!probe) return;
    const interval = this.opts.pollIntervalMs ?? 2000;
    const steps = this.opts.maxPolls ?? 60;
    for (let i = 0; i < steps; i++) {
      try {
        await this.execImpl.exec(rec.allocId, rec.task, probe, { namespace: this.opts.poolNamespace });
        return;
      } catch {
        // 아직 안 받음 → 재시도
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { store }, "공유 스토어 준비 대기 시간초과");
  }

  async provisionBrowserEnv(spec: ServiceHarnessSpec, runId: string, zone?: TrustZone): Promise<BrowserEnvHandle> {
    const ns = zone?.namespace ?? this.opts.namespace;
    const job = buildBrowserJob(spec, runId, {
      datacenters: this.opts.datacenters,
      runtime: zone?.isolationRuntime ?? this.opts.runtime,
      namespace: ns,
      image: this.opts.browserImage,
    });
    await this.register(job, ns);
    // register 이후 어디서든 실패하면 alloc 이 새므로(핸들 미반환 → dispose 불가) 즉시 정리한다.
    try {
      return await this.connectBrowser(runId, ns);
    } catch (err) {
      await this.deregister(browserJobId(runId), ns);
      throw err;
    }
  }

  private async connectBrowser(runId: string, ns?: string): Promise<BrowserEnvHandle> {
    const alloc = await this.waitForGroupRunning(browserJobId(runId), "browser", ns);
    const p = resolvePort(alloc, "cdp");
    if (!p) {
      throw new UpstreamError("UPSTREAM_ERROR", { runId }, "브라우저 CDP 포트를 alloc 에서 찾지 못했습니다.");
    }
    const cdpHttp = `http://${p.hostIp}:${p.port}`;
    await this.waitForHttp(`${cdpHttp}/json/version`);

    let cdpUrl = cdpHttp;
    try {
      const ver = (await (await fetch(`${cdpHttp}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
      if (ver.webSocketDebuggerUrl) cdpUrl = ver.webSocketDebuggerUrl;
    } catch {
      // /json/version 파싱 실패 시 HTTP 엔드포인트를 cdpUrl 로 사용 (라이브 디버깅용).
    }
    // 신선한 세션: 빈 탭 하나를 연다(실 하니스/익스텐션이 이후 여기서 네비게이션). best-effort.
    try {
      await fetch(`${cdpHttp}/json/new?about:blank`, { method: "PUT" });
    } catch {
      // 탭 생성 실패는 치명적 아님 — 스냅샷은 빈 타깃 목록을 그대로 관측.
    }

    const deregister = () => this.deregister(browserJobId(runId), ns);
    return {
      cdpUrl,
      async snapshot(): Promise<BrowserSnapshot> {
        // 실 브라우저 관측: 열린 타깃 목록(현재 URL). 익스텐션 주도 네비게이션은 Phase 2.
        let targets: Array<{ url?: string; title?: string }> = [];
        try {
          targets = (await (await fetch(`${cdpHttp}/json/list`)).json()) as typeof targets;
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
      async dispose(): Promise<void> {
        await deregister();
      },
    };
  }

  // warm 토폴로지 정리 (라이브 실행 후 teardown 용). 존을 주면 그 존의 warm 만 정리한다.
  async teardown(spec: ServiceHarnessSpec, zone?: TrustZone): Promise<void> {
    this.warm.delete(`${spec.id}@${spec.version}@${zone?.id ?? "default"}`);
    if (zone && this.opts.consul) {
      for (const svc of spec.services) {
        await this.opts.consul.deleteIntention(meshServiceName(zone.id, svc.name)).catch(() => {});
      }
    }
    await this.deregister(topologyJobId(spec, zone?.id), zone?.namespace ?? this.opts.namespace);
  }

  private nsq(namespace: string | undefined, sep: "?" | "&"): string {
    return namespace ? `${sep}namespace=${encodeURIComponent(namespace)}` : "";
  }

  private async register(job: { Job: { ID: string } }, namespace?: string): Promise<void> {
    const res = await this.http.request("POST", `/v1/jobs${this.nsq(namespace, "?")}`, job);
    if (res.status >= 300) {
      throw new UpstreamError("UPSTREAM_ERROR", { status: res.status, job: job.Job.ID }, "Nomad 잡 제출 실패");
    }
  }

  private async deregister(jobId: string, namespace?: string): Promise<void> {
    await this.http.request("DELETE", `/v1/job/${jobId}?purge=true${this.nsq(namespace, "&")}`);
  }

  // 그룹의 alloc 이 running 이 될 때까지 폴링하고, 전체 alloc(포트 포함)을 돌려준다.
  private async waitForGroupRunning(jobId: string, group: string, namespace?: string): Promise<AllocLike> {
    const interval = this.opts.pollIntervalMs ?? 2000;
    const maxPolls = this.opts.maxPolls ?? 150;
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.http.request("GET", `/v1/job/${jobId}/allocations${this.nsq(namespace, "?")}`);
      if (res.status < 300) {
        const allocs = JSON.parse(res.text) as AllocLike[];
        const mine = allocs.filter((a) => a.TaskGroup === group);
        const failed = mine.find((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost");
        if (failed) {
          throw new UpstreamError("UPSTREAM_ERROR", { group, status: failed.ClientStatus }, "토폴로지 alloc 실패");
        }
        const running = mine.find((a) => a.ClientStatus === "running");
        if (running?.ID) {
          const full = await this.http.request("GET", `/v1/allocation/${running.ID}${this.nsq(namespace, "?")}`);
          if (full.status < 300) return JSON.parse(full.text) as AllocLike;
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { jobId, group }, "토폴로지 alloc running 대기 시간초과");
  }

  // 엔드포인트가 HTTP 응답을 줄 때까지 폴링 (5xx/연결거부는 재시도).
  private async waitForHttp(url: string): Promise<void> {
    const deadline = this.opts.readyTimeoutMs ?? 60_000;
    const interval = this.opts.pollIntervalMs ?? 2000;
    const steps = Math.max(1, Math.floor(deadline / interval));
    for (let i = 0; i < steps; i++) {
      try {
        const res = await fetch(url);
        if (res.status < 500) return;
      } catch {
        // 아직 안 떴음 → 재시도
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new UpstreamError("UPSTREAM_ERROR", { url }, "엔드포인트 준비 대기 시간초과");
  }
}
