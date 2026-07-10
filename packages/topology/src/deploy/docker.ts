import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UpstreamError } from "@everdict/contracts";

const execFileAsync = promisify(execFile);

// Thin docker CLI abstraction used by DockerTopologyRuntime — same injectable pattern as kubectl.ts (Kubectl) / nomad exec.
// Unit tests inject a fake Docker (no daemon needed). The default impl is execFile("docker", …).
export interface DockerRunSpec {
  name: string; // container name (globally unique on the host)
  image: string;
  network: string;
  alias?: string; // --network-alias — services/stores reach each other by this name inside the network
  env?: Record<string, string>;
  volumes?: string[]; // -v mount specs (named volume / bind mount). e.g. "vol:/data", "/host:/container:ro"
  publish?: number; // publish this container port to an arbitrary host port (-p <port>) → discovered via hostPort
  cpus?: number; // --cpus (cores, fractional allowed). ServiceResources.cpu/1000.
  memoryMb?: number; // --memory (MB). ServiceResources.memoryMb.
  args?: string[]; // command/args after the image (e.g. minio "server /data", chrome flags)
}

// Assemble docker run args (pure) — deterministically testable.
export function dockerRunArgs(s: DockerRunSpec): string[] {
  const args = ["run", "-d", "--name", s.name, "--network", s.network];
  if (s.alias) args.push("--network-alias", s.alias);
  for (const [k, v] of Object.entries(s.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const v of s.volumes ?? []) args.push("-v", v); // named volume / bind mount
  if (s.publish !== undefined) args.push("-p", String(s.publish)); // host port unspecified → publish to an arbitrary port
  if (s.cpus !== undefined) args.push("--cpus", String(s.cpus)); // resource request (cores)
  if (s.memoryMb !== undefined) args.push("--memory", `${s.memoryMb}m`); // resource request (MB)
  args.push(s.image);
  if (s.args) args.push(...s.args);
  return args;
}

// Extract the host port from "docker port <c> 9222" output ("0.0.0.0:49153\n[::]:49153").
export function parseHostPort(out: string): number {
  const m = out.match(/:(\d+)\s*$/m);
  const port = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(port)) {
    throw new UpstreamError("UPSTREAM_ERROR", { out }, "Could not find a host port in the docker port output.");
  }
  return port;
}

export interface Docker {
  ensureNetwork(name: string): Promise<void>;
  run(spec: DockerRunSpec): Promise<string>; // container id
  hostPort(container: string, containerPort: number): Promise<number>; // discover the published host port
  exec(container: string, cmd: string[]): Promise<void>;
  rm(containers: string[]): Promise<void>; // best-effort force removal
  removeNetwork(name: string): Promise<void>;
}

// Default impl — execFile("docker", …). A stopped daemon / lack of permission makes execFile reject → the runtime maps it to UpstreamError.
export function dockerCli(bin = "docker"): Docker {
  const sh = (args: string[]) => execFileAsync(bin, args);
  return {
    async ensureNetwork(name) {
      try {
        await sh(["network", "inspect", name]);
      } catch {
        await sh(["network", "create", name]);
      }
    },
    async run(spec) {
      const { stdout } = await sh(dockerRunArgs(spec));
      return stdout.trim();
    },
    async hostPort(container, containerPort) {
      const { stdout } = await sh(["port", container, String(containerPort)]);
      return parseHostPort(stdout);
    },
    async exec(container, cmd) {
      await sh(["exec", container, ...cmd]);
    },
    async rm(containers) {
      if (containers.length > 0) await sh(["rm", "-f", ...containers]).catch(() => {});
    },
    async removeNetwork(name) {
      await sh(["network", "rm", name]).catch(() => {});
    },
  };
}
