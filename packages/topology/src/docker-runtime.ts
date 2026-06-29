import { type BrowserSnapshot, type ServiceHarnessSpec, type ServiceReadiness, UpstreamError } from "@assay/core";
import { dependencyConnEnv, dependencyStores } from "./dependencies.js";
import { type Docker, dockerCli } from "./docker.js";
import type { TargetEnvHandle, TopologyHandle, TopologyRuntime } from "./topology-runtime.js";

export interface DockerTopologyRuntimeOptions {
  docker?: Docker; // 주입형(테스트는 가짜 Docker). 기본 execFile("docker", …)
  browserImage?: string; // per-case 브라우저 이미지(기본 chromedp/headless-shell:latest)
  storeEnv?: Record<string, string>; // 명시 접속 env(자동 connEnv 를 덮어쓴다 — harness 별 변수명)
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch; // 엔드포인트 readiness/CDP 조회용(테스트 주입)
}

interface WarmEntry {
  handle: TopologyHandle;
  network: string;
  containers: string[]; // 이 토폴로지가 띄운 컨테이너(teardown 대상)
}

// docker 이름 규칙([a-zA-Z0-9][a-zA-Z0-9_.-])에 맞게 정리.
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
function netName(spec: ServiceHarnessSpec): string {
  return `assay-${sanitize(spec.id)}-${sanitize(spec.version)}`;
}

// 라이브 DockerTopologyRuntime: 사용자 Docker 데몬에 토폴로지(스토어+서비스) + per-case 브라우저를 띄운다.
// NomadTopologyRuntime / K8sTopologyRuntime 의 형제 — ServiceTopologyBackend 는 셋을 교체만 한다(오케스트레이터-비종속).
// self-hosted runner 가 service 하니스를 노트북에서 구동하기 위한 로컬 토폴로지. 설계: docs/architecture/self-hosted-service-runner.md.
// 개인 호스트 = 단일 trust 도메인 → TrustZone/강격리/pool·silo 없음(설계 비목표). 케이스별 논리격리는 front-door wiring 이 담당.
export class DockerTopologyRuntime implements TopologyRuntime {
  readonly id = "docker";
  private readonly docker: Docker;
  private readonly fetchImpl: typeof fetch;
  private readonly warm = new Map<string, WarmEntry>(); // key: id@version (per-version warm)

  constructor(private readonly opts: DockerTopologyRuntimeOptions = {}) {
    this.docker = opts.docker ?? dockerCli();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ensureTopology(spec: ServiceHarnessSpec): Promise<TopologyHandle> {
    const key = `${spec.id}@${spec.version}`;
    const cached = this.warm.get(key);
    if (cached) return cached.handle; // warm: 버전당 한 번만 배포

    const network = netName(spec);
    // 기동한(또는 기동 시도한) 컨테이너 이름 — 부분실패 시 정리 대상. run 전에 push 하므로 run 자체가 throw 한 이름도 잡힌다.
    const containers: string[] = [];
    try {
      await this.docker.ensureNetwork(network);

      // 1) 의존 스토어(타입별 1개) — 네트워크 alias = `<id>-<store>`(dependencyConnEnv 의 호스트와 일치 → 서비스가 그 이름으로 접속).
      for (const { store, name, def } of dependencyStores(spec)) {
        const cname = `${network}-${name}`;
        containers.push(cname);
        await this.docker.run({ name: cname, image: def.image, network, alias: name, env: def.env, args: def.args });
        await this.waitStoreAccepting(store, cname); // pg_isready/redis ping — 서비스가 부팅 시 접속하므로 먼저 준비.
      }
      // 서비스 접속 env: 자동 connEnv(<id>-<store>:<port>). 우선순위: connEnv < svc.env(서비스 정적) < storeEnv(명시가 이긴다).
      const connEnv = dependencyConnEnv(spec);

      // 2) 서비스 — alias = svc.name(needs/front-door 내부 주소). port 있으면 임의 호스트 포트로 게시 → 러너(도커 밖)가 도달.
      const endpoints: Record<string, string> = {};
      for (const svc of spec.services) {
        const cname = `${network}-${sanitize(svc.name)}`;
        containers.push(cname);
        await this.docker.run({
          name: cname,
          image: svc.image,
          network,
          alias: svc.name,
          env: { ...connEnv, ...svc.env, ...this.opts.storeEnv },
          ...(svc.volumes && svc.volumes.length > 0 ? { volumes: svc.volumes } : {}),
          ...(svc.port !== undefined ? { publish: svc.port } : {}),
          // 리소스 요청: cpu 1000=1코어 → --cpus 코어(=cpu/1000), memoryMb → --memory. 정의된 것만.
          ...(svc.resources?.cpu !== undefined ? { cpus: svc.resources.cpu / 1000 } : {}),
          ...(svc.resources?.memoryMb !== undefined ? { memoryMb: svc.resources.memoryMb } : {}),
        });
        if (svc.port !== undefined) {
          const hostPort = await this.docker.hostPort(cname, svc.port);
          const url = `http://127.0.0.1:${hostPort}`;
          await this.waitForHttp(url, svc.readiness); // 서비스가 자체 readiness 상한을 선언하면 그걸, 아니면 런타임 기본
          endpoints[svc.name] = url;
        }
      }

      const handle: TopologyHandle = { endpoints };
      this.warm.set(key, { handle, network, containers });
      return handle;
    } catch (err) {
      // 부분 기동 정리 — 고정 이름 컨테이너가 남으면 다음 케이스의 docker run(--name 비멱등)이 이름 충돌로 cascade 실패한다.
      // 실패 토폴로지는 warm 캐시에 넣지 않으므로(깨진 핸들 캐싱 금지) teardown 으로도 못 잡는다 → 여기서 즉시 제거.
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
      args: ["--remote-allow-origins=*"], // headless-shell 은 CDP 를 스스로 9222 로 노출
    });
    try {
      const hostPort = await this.docker.hostPort(cname, 9222);
      return await this.connectBrowser(runId, cname, alias, hostPort);
    } catch (err) {
      await this.docker.rm([cname]).catch(() => {});
      throw err;
    }
  }

  // 브라우저 핸들: 에이전트(네트워크 내부)는 cdpUrl=alias:9222 로, snapshot(러너=도커 밖)은 호스트 게시 포트로 도달.
  private async connectBrowser(
    runId: string,
    cname: string,
    alias: string,
    hostPort: number,
  ): Promise<TargetEnvHandle> {
    const fetchImpl = this.fetchImpl; // 반환 closure 에서 this 가 바뀌므로 로컬 캡처
    const docker = this.docker;
    const hostCdp = `http://127.0.0.1:${hostPort}`;
    await this.waitForHttp(`${hostCdp}/json/version`);
    try {
      await fetchImpl(`${hostCdp}/json/new?about:blank`, { method: "PUT" });
    } catch {
      // 빈 탭 생성 실패는 치명적 아님
    }
    return {
      // 에이전트(같은 네트워크)가 도달할 CDP — wiring 의 target_cdp_url 로 front-door 페이로드에 주입된다.
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
        await docker.rm([cname]).catch(() => {}); // per-case 브라우저만 제거 — warm 토폴로지는 유지
      },
    };
  }

  // 명시 teardown — warm 토폴로지의 컨테이너 + 네트워크 제거(인터페이스 외 — ServiceTopologyBackend 는 dispose 만 호출).
  async teardown(spec: ServiceHarnessSpec): Promise<void> {
    const key = `${spec.id}@${spec.version}`;
    const entry = this.warm.get(key);
    this.warm.delete(key);
    if (!entry) return;
    await this.docker.rm(entry.containers).catch(() => {});
    await this.docker.removeNetwork(entry.network).catch(() => {});
  }

  // 런타임 기본 readiness(서비스가 자체 readiness 를 선언하지 않을 때 + 스토어/브라우저 폴링에 쓰임).
  private get defaultReadyTimeoutMs(): number {
    return this.opts.readyTimeoutMs ?? 60_000;
  }
  private get defaultIntervalMs(): number {
    return this.opts.pollIntervalMs ?? 1000;
  }

  // 준비성 폴링(공유) — timeoutMs/intervalMs 동안 probe 가 true 를 돌려줄 때까지 재시도. 초과하면 onTimeout 으로 throw.
  // probe 가 throw 하는 것도 "아직 안 준비"로 보고 재시도(연결거부/명령실패 등).
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
        // 아직 안 준비 → 재시도
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    onTimeout();
  }

  // 스토어가 실제 연결을 받을 때까지 폴링(docker exec pg_isready / redis-cli ping). minio 는 스킵.
  private async waitStoreAccepting(store: string, container: string): Promise<void> {
    const probe =
      store === "postgres" ? ["pg_isready", "-U", "assay"] : store === "redis" ? ["redis-cli", "ping"] : undefined;
    if (!probe) return;
    await this.pollReady(
      this.defaultReadyTimeoutMs,
      this.defaultIntervalMs,
      async () => {
        await this.docker.exec(container, probe);
        return true;
      },
      () => {
        throw new UpstreamError("UPSTREAM_ERROR", { store }, "스토어 준비 대기 시간초과");
      },
    );
  }

  // HTTP 엔드포인트 준비 대기. readiness 가 주어지면 서비스가 선언한 timeout/interval 을, 아니면 런타임 기본을 쓴다.
  private async waitForHttp(url: string, readiness?: ServiceReadiness): Promise<void> {
    await this.pollReady(
      readiness?.timeoutMs ?? this.defaultReadyTimeoutMs,
      readiness?.intervalMs ?? this.defaultIntervalMs,
      async () => (await this.fetchImpl(url)).status < 500,
      () => {
        throw new UpstreamError("UPSTREAM_ERROR", { url }, "엔드포인트 준비 대기 시간초과");
      },
    );
  }
}
