import type { ComputeHandle, ExecOpts } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { RepoEnvironment } from "./repo.js";

// exec 호출(cmd + opts)을 기록하는 fake — git 명령/인증 env 주입을 검증.
function recorder() {
  const calls: { cmd: string; opts?: ExecOpts }[] = [];
  const compute: ComputeHandle = {
    async exec(cmd, opts) {
      calls.push({ cmd, ...(opts ? { opts } : {}) });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { calls, compute };
}

describe("RepoEnvironment", () => {
  it("public git: clone 에 인증 env 가 없다", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment().seed(compute, {
      kind: "repo",
      source: { git: "https://github.com/octo/public.git", ref: "main" },
    });
    const clone = calls.find((c) => c.cmd.includes("git clone"));
    expect(clone?.cmd).toContain("https://github.com/octo/public.git");
    expect(clone?.opts?.env).toBeUndefined(); // 인증 헤더 없음
  });

  it("private git(gitToken): http.extraheader 를 env 로 주입하고 토큰은 argv 에 안 들어간다", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment({ gitToken: "gho_secret_tok" }).seed(compute, {
      kind: "repo",
      source: { git: "https://github.com/acme/private.git", ref: "main", connectionId: "conn-1" },
    });
    const clone = calls.find((c) => c.cmd.includes("git clone"));
    // 토큰은 명령줄(argv)에 절대 노출되지 않는다(ps/로그 안전).
    expect(clone?.cmd).not.toContain("gho_secret_tok");
    // 인증은 env(GIT_CONFIG_* → http.extraheader)로.
    expect(clone?.opts?.env?.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer gho_secret_tok");
    expect(clone?.opts?.env?.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(clone?.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("files 시드는 git init 베이스라인 커밋", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment().seed(compute, { kind: "repo", source: { files: { "a.txt": "hi" } } });
    expect(calls.some((c) => c.cmd.includes("git init"))).toBe(true);
    expect(calls.every((c) => c.opts?.env === undefined)).toBe(true); // files 경로엔 인증 env 없음
  });
});
