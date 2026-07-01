import type { ServiceHarnessSpec } from "@assay/core";
import { describe, expect, it } from "vitest";
import { DockerTopologyRuntime } from "./docker-runtime.js";
import { type Docker, type DockerRunSpec, dockerRunArgs, parseHostPort } from "./docker.js";

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
    { store: "postgres", role: "checkpoints", isolateBy: "thread_id" },
    { store: "redis", role: "action-stream", isolateBy: "key-prefix" },
  ],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["dom"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://mlflow:5000" },
};

// 가짜 Docker — 호출을 기록하고 게시 포트를 결정적으로 돌려준다(데몬 불필요).
function fakeDocker(): {
  docker: Docker;
  runs: DockerRunSpec[];
  networks: string[];
  removed: string[];
  rmNets: string[];
} {
  const runs: DockerRunSpec[] = [];
  const networks: string[] = [];
  const removed: string[] = [];
  const rmNets: string[] = [];
  let nextPort = 49152;
  const docker: Docker = {
    async ensureNetwork(name) {
      networks.push(name);
    },
    async run(spec) {
      runs.push(spec);
      return `cid-${spec.name}`;
    },
    async hostPort() {
      return nextPort++;
    },
    async exec() {},
    async rm(c) {
      removed.push(...c);
    },
    async removeNetwork(n) {
      rmNets.push(n);
    },
  };
  return { docker, runs, networks, removed, rmNets };
}

const okFetch: typeof fetch = (async (url: string) => {
  if (String(url).endsWith("/json/list")) return new Response(JSON.stringify([{ url: "https://x" }]), { status: 200 });
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

describe("dockerRunArgs / parseHostPort (pure)", () => {
  it("docker run 인자를 조립한다(name/network/alias/env/publish/args)", () => {
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

  it("volumes 를 -v 인자로 펼친다(env 뒤, publish 앞)", () => {
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
      "-v",
      "data:/var/lib/x",
      "-v",
      "/host:/c:ro",
      "-p",
      "8000",
      "img:1",
    ]);
  });

  it("volumes 미지정이면 -v 가 붙지 않는다", () => {
    expect(dockerRunArgs({ name: "c", image: "img:1", network: "net" })).not.toContain("-v");
  });

  it("cpus/memoryMb 를 --cpus/--memory 로 펼치고, 미지정이면 붙지 않는다", () => {
    const args = dockerRunArgs({ name: "c", image: "img:1", network: "net", cpus: 2, memoryMb: 4096 });
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toBe("4096m");
    const none = dockerRunArgs({ name: "c", image: "img:1", network: "net" });
    expect(none).not.toContain("--cpus");
    expect(none).not.toContain("--memory");
  });

  it("docker port 출력에서 호스트 포트를 뽑는다", () => {
    expect(parseHostPort("0.0.0.0:49153\n[::]:49153")).toBe(49153);
  });
});

describe("DockerTopologyRuntime", () => {
  it("ensureTopology: 스토어 + 서비스를 네트워크에 띄우고 게시 호스트 포트로 엔드포인트를 발견한다", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    const handle = await rt.ensureTopology(SPEC);

    expect(f.networks).toEqual(["assay-bu-1.0.0"]);
    // 스토어 2(postgres/redis) + 서비스 1 = run 3회.
    expect(f.runs.map((r) => r.alias)).toEqual(["bu-postgres", "bu-redis", "agent-server"]);
    // 서비스는 DATABASE_URL/REDIS_URL 을 네트워크 alias(<id>-<store>:port)로 주입받는다.
    const agent = f.runs.find((r) => r.alias === "agent-server");
    expect(agent?.env?.DATABASE_URL).toBe("postgresql://assay:assay@bu-postgres:5432/assay");
    expect(agent?.env?.REDIS_URL).toBe("redis://bu-redis:6379");
    expect(agent?.publish).toBe(8000);
    // 엔드포인트 = http://127.0.0.1:<게시 호스트 포트>.
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ensureTopology: 서비스 정적 env(svc.env) 주입 + 우선순위(connEnv < svc.env < storeEnv)", async () => {
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
    expect(agent?.env?.LOG_LEVEL).toBe("info"); // svc.env 단독
    expect(agent?.env?.DATABASE_URL).toBe("postgresql://store"); // storeEnv 가 svc.env(및 connEnv)를 이긴다
  });

  it("ensureTopology: 러너 재배포 — 남은 고정 이름 컨테이너가 있어도 rm 선제 제거로 충돌 없이 성공한다", async () => {
    // 실 데몬처럼 docker run(--name)은 비멱등: 같은 이름이 살아 있으면 충돌(throw). 이전 배포의 잔존 컨테이너 재현.
    const live = new Set<string>(["assay-bu-1.0.0-bu-postgres", "assay-bu-1.0.0-agent-server"]);
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
      async rm(c) {
        for (const name of c) live.delete(name);
      },
      async removeNetwork() {},
    };
    const rt = new DockerTopologyRuntime({ docker, fetchImpl: okFetch });
    // 잔존 컨테이너를 run 전에 rm 하지 않으면 여기서 이름 충돌 cascade 로 throw 한다(회귀 가드).
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ensureTopology: 같은 버전 재호출은 warm 캐시 — 재배포 없음", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    const runsAfterFirst = f.runs.length;
    await rt.ensureTopology(SPEC);
    expect(f.runs.length).toBe(runsAfterFirst); // 두 번째는 캐시
  });

  it("ensureTopology: 동시 호출은 single-flight — 같은 토폴로지를 한 번만 배포(중복 docker run 없음)", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    // case-level 병렬에서 warm 이 아직 비었을 때 동시에 ensure → 둘이 배포하면 고정 이름 컨테이너가 충돌한다.
    const [a, b, c] = await Promise.all([rt.ensureTopology(SPEC), rt.ensureTopology(SPEC), rt.ensureTopology(SPEC)]);
    expect(f.networks).toEqual(["assay-bu-1.0.0"]); // 네트워크 1회
    expect(f.runs.map((r) => r.alias)).toEqual(["bu-postgres", "bu-redis", "agent-server"]); // 배포 1회분만
    expect(a).toEqual(b); // 셋 다 같은 핸들을 공유
    expect(b).toEqual(c);
  });

  it("ensureTopology: 배포 실패 후 재호출은 새로 시도한다(실패 토폴로지는 single-flight 에 캐싱 안 함)", async () => {
    const f = fakeDocker();
    let firstNetwork = true;
    f.docker.ensureNetwork = async (name: string) => {
      if (firstNetwork) {
        firstNetwork = false;
        throw new Error("docker down");
      }
      f.networks.push(name);
    };
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await expect(rt.ensureTopology(SPEC)).rejects.toThrow("docker down");
    // inFlight 가 비워졌어야 재시도가 동작한다(실패를 캐싱하면 영영 실패).
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("provisionBrowserEnv: 브라우저 컨테이너 + cdpUrl(내부 alias) + snapshot(호스트 포트 fetch)", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    const browser = await rt.provisionBrowserEnv(SPEC, "run-1");
    // 에이전트(네트워크 내부)가 도달하는 주소 — 내부 alias.
    expect(browser.wiring.target_cdp_url).toBe("http://browser-run-1:9222");
    const snap = await browser.snapshot();
    if (snap.kind !== "browser") throw new Error("브라우저 스냅샷이어야 한다");
    expect(snap.url).toBe("https://x");
    // dispose 는 브라우저 컨테이너만 제거(warm 토폴로지 유지).
    await browser.dispose();
    expect(f.removed).toContain("assay-bu-1.0.0-browser-run-1");
  });

  it("ensureTopology: 부분 실패 후 재시도가 컨테이너 이름 충돌 없이 성공한다(cascade 방지)", async () => {
    // 실 데몬처럼 동작하는 fake — docker run(--name)은 비멱등이라 같은 이름이 살아 있으면 충돌(throw).
    // 스토어는 첫 토폴로지 시도에서 readiness 실패(exec throw) → ensureTopology 가 중도 throw.
    const live = new Set<string>();
    const removed: string[] = [];
    let storeReady = false; // 첫 시도엔 준비 안 됨 → 두 번째 시도 직전에 켠다.
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
      async rm(c) {
        for (const name of c) live.delete(name);
        removed.push(...c);
      },
      async removeNetwork() {},
    };
    // readyTimeoutMs/pollIntervalMs 를 1ms 로 — 실패 경로의 폴링이 즉시 끝나게.
    const rt = new DockerTopologyRuntime({ docker, fetchImpl: okFetch, readyTimeoutMs: 1, pollIntervalMs: 1 });

    // 1차 시도: 스토어 readiness 실패 → throw. 정리되면 postgres 컨테이너가 live 에서 빠진다.
    await expect(rt.ensureTopology(SPEC)).rejects.toThrow();
    expect(removed).toContain("assay-bu-1.0.0-bu-postgres"); // 부분 기동분 정리됨(픽스 전엔 비어 cascade)

    // 2차 시도: 이제 스토어 준비됨. 픽스 전이면 1차가 남긴 postgres 이름과 충돌(throw)했을 자리.
    storeReady = true;
    const handle = await rt.ensureTopology(SPEC);
    expect(handle.endpoints["agent-server"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("ensureTopology: 서비스 volumes 를 docker run 에 -v 로 전달한다", async () => {
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

  it("ensureTopology: 서비스가 선언한 readiness 상한을 적용한다(런타임 60s 기본이 아니라 빠르게 타임아웃)", async () => {
    // 엔드포인트가 영원히 500 — 준비되지 않는다. per-service readiness(30/10ms)면 ~30ms 안에 타임아웃,
    // 런타임 기본(60s)이 적용됐다면 vitest 5s 타임아웃에 걸려 실패했을 것 → per-service 적용을 증명.
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
    await expect(rt.ensureTopology(spec)).rejects.toThrow(/준비 대기 시간초과/);
  });

  it("teardown: 토폴로지 컨테이너 + 네트워크 제거", async () => {
    const f = fakeDocker();
    const rt = new DockerTopologyRuntime({ docker: f.docker, fetchImpl: okFetch });
    await rt.ensureTopology(SPEC);
    const beforeTeardown = f.removed.length; // ensure 중 멱등 rm(각 컨테이너 run 전) 이후부터 teardown 제거분만 확인
    await rt.teardown(SPEC);
    expect(f.removed.slice(beforeTeardown)).toEqual([
      "assay-bu-1.0.0-bu-postgres",
      "assay-bu-1.0.0-bu-redis",
      "assay-bu-1.0.0-agent-server",
    ]);
    expect(f.rmNets).toEqual(["assay-bu-1.0.0"]);
  });
});
