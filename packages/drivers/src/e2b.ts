import {
  type ComputeHandle,
  type ComputeSpec,
  type Driver,
  type ExecOpts,
  type ExecResult,
  UpstreamError,
} from "@assay/core";

// E2B SDK의 필요한 표면만 구조적으로 선언 → SDK 미설치 상태에서도 타입체크 통과,
// 런타임에 `e2b`가 있고 키가 있으면 동작. (셀프호스팅은 domain 지정)
interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface E2BSandbox {
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<E2BCommandResult>;
  };
  files: { write(path: string, data: string): Promise<unknown>; read(path: string): Promise<string> };
  kill(): Promise<unknown>;
}
interface E2BModule {
  Sandbox: { create(opts: { apiKey?: string; domain?: string; template?: string }): Promise<E2BSandbox> };
}

class E2BComputeHandle implements ComputeHandle {
  constructor(private readonly sbx: E2BSandbox) {}

  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    try {
      const r = await this.sbx.commands.run(cmd, {
        cwd: opts?.cwd,
        envs: opts?.env,
        timeoutMs: (opts?.timeoutSec ?? 600) * 1000,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as Partial<E2BCommandResult> & { message?: string };
      if (typeof e.exitCode === "number")
        return { exitCode: e.exitCode, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      throw new UpstreamError("COMPUTE_EXEC_FAILED", { cmd }, e.message);
    }
  }

  async writeFile(path: string, data: string): Promise<void> {
    await this.sbx.files.write(path, data);
  }
  async readFile(path: string): Promise<string> {
    return this.sbx.files.read(path);
  }
  async dispose(): Promise<void> {
    await this.sbx.kill();
  }
}

export interface E2BDriverOptions {
  apiKey?: string;
  domain?: string; // 셀프호스팅 E2B 엔드포인트
  template?: string;
}

export class E2BLinuxDriver implements Driver {
  readonly id = "e2b-linux";
  constructor(private readonly opts: E2BDriverOptions = {}) {}

  async provision(spec: ComputeSpec): Promise<ComputeHandle> {
    const apiKey = this.opts.apiKey ?? process.env.E2B_API_KEY;
    const domain = this.opts.domain ?? process.env.E2B_DOMAIN;
    if (!apiKey) throw new UpstreamError("UPSTREAM_MISCONFIGURED", undefined, "E2B_API_KEY 미설정");

    const specifier: string = "e2b";
    let mod: unknown;
    try {
      mod = await import(specifier);
    } catch {
      throw new UpstreamError("UPSTREAM_MISCONFIGURED", undefined, "e2b SDK 미설치 — `pnpm add e2b`");
    }
    const { Sandbox } = mod as E2BModule;
    const sbx = await Sandbox.create({ apiKey, domain, template: spec.image ?? this.opts.template });
    return new E2BComputeHandle(sbx);
  }
}
