// 라이브 e2e (SLICE 65): docker 를 선택 가능한 runtime 백엔드로 — RuntimeSpec{kind:"docker"} → buildRuntimeBackend →
// DockerBackend → dispatch 가 케이스를 그 env 이미지 컨테이너에서 실행(하니스+채점 모두 컨테이너 안). 실 docker.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { buildRuntimeBackend } from "../../packages/backends/dist/index.js";

const IMAGE = "everdict-dockerbe:demo";

// env 이미지(git+sh; RepoEnvironment 인라인 시드가 git init 필요). 에이전트 미포함 — 케이스가 이 이미지에서 돈다.
const dockerfile =
  "FROM debian:stable-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*\n";
console.log("=== env 이미지 빌드(git, 에이전트 미포함) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });

// 테넌트가 등록하는 docker 런타임 → 라이브 백엔드.
const runtimeSpec = { kind: "docker", id: "local-docker", version: "1.0.0", tags: [] };
const backend = buildRuntimeBackend(runtimeSpec);
console.log(`\nbuildRuntimeBackend(kind=docker) → backend.id=${backend.id}`);

// 케이스: repo(인라인) env + scripted 하니스(echo hello>out.txt) + command grader(검증). image=env 이미지.
const job = {
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
  evalCase: {
    id: "echo-case",
    env: { kind: "repo", source: { files: {} } },
    image: IMAGE, // ← 이 이미지 컨테이너에서 케이스가 실행됨
    task: "write out.txt",
    graders: [{ id: "command", config: { cmd: "grep -q hello out.txt", cwd: "work", metric: "resolved" } }],
    timeoutSec: 120,
    tags: [],
  },
};

console.log("=== DockerBackend.dispatch — 컨테이너에서 하니스+채점 실행 ===");
const result = await backend.dispatch(job);
const r = result.scores.find((s) => s.metric === "resolved");
console.log(`harness: ${result.harness}`);
console.log(`snapshot.changedFiles: ${JSON.stringify(result.snapshot.changedFiles)}`);
console.log(`command grader (컨테이너 내 실행): pass=${r?.pass} value=${r?.value}`);

execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });

const ok = backend.id === "docker" && r?.pass === true && (result.snapshot.changedFiles ?? []).includes("out.txt");
console.log(
  ok
    ? "\n✅ SLICE 65: docker 가 선택 가능한 runtime 백엔드 — RuntimeSpec{kind:docker} → DockerBackend → dispatch 가 케이스를 env 이미지 컨테이너에서 실행(scripted 하니스가 out.txt 작성, command grader 가 컨테이너 안에서 검증 → pass). 컨트롤플레인 run 이 case.image 컨테이너로 라우팅됨. SWE-bench prebuilt 도 동일 경로."
    : "\n⚠️ 기대와 불일치",
);
process.exit(ok ? 0 : 1);
