// Live e2e (SLICE 65): docker as a selectable runtime backend — RuntimeSpec{kind:"docker"} → buildRuntimeBackend →
// DockerBackend → dispatch runs the case in that env image container (harness + scoring both inside the container). Real docker.
import { execFileSync } from "node:child_process";
import process from "node:process";
import { buildRuntimeBackend } from "../../packages/backends/dist/index.js";

const IMAGE = "everdict-dockerbe:demo";

// env image (git+sh; the RepoEnvironment inline seed needs git init). No agent — the case runs in this image.
const dockerfile =
  "FROM debian:stable-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*\n";
console.log("=== build env image (git, no agent) ===");
execFileSync("docker", ["build", "-t", IMAGE, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });

// A docker runtime a tenant registers → live backend.
const runtimeSpec = { kind: "docker", id: "local-docker", version: "1.0.0", tags: [] };
const backend = buildRuntimeBackend(runtimeSpec);
console.log(`\nbuildRuntimeBackend(kind=docker) → backend.id=${backend.id}`);

// Case: repo (inline) env + scripted harness (echo hello>out.txt) + command grader (verify). image=env image.
const job = {
  harness: { id: "scripted", version: "1.0.0" },
  tenant: "acme",
  evalCase: {
    id: "echo-case",
    env: { kind: "repo", source: { files: {} } },
    image: IMAGE, // ← the case runs in this image container
    task: "write out.txt",
    graders: [{ id: "command", config: { cmd: "grep -q hello out.txt", cwd: "work", metric: "resolved" } }],
    timeoutSec: 120,
    tags: [],
  },
};

console.log("=== DockerBackend.dispatch — run harness + scoring in the container ===");
const result = await backend.dispatch(job);
const r = result.scores.find((s) => s.metric === "resolved");
console.log(`harness: ${result.harness}`);
console.log(`snapshot.changedFiles: ${JSON.stringify(result.snapshot.changedFiles)}`);
console.log(`command grader (run inside the container): pass=${r?.pass} value=${r?.value}`);

execFileSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });

const ok = backend.id === "docker" && r?.pass === true && (result.snapshot.changedFiles ?? []).includes("out.txt");
console.log(
  ok
    ? "\n✅ SLICE 65: docker as a selectable runtime backend — RuntimeSpec{kind:docker} → DockerBackend → dispatch runs the case in the env image container (scripted harness writes out.txt, command grader verifies inside the container → pass). Control-plane run routed to the case.image container. SWE-bench prebuilt takes the same path."
    : "\n⚠️ does not match expectation",
);
process.exit(ok ? 0 : 1);
