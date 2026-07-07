import type { ComputeHandle, ExecOpts } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { RepoEnvironment } from "./repo.js";

// A fake that records exec calls (cmd + opts) — verifies git commands / auth env injection.
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
  it("public git: no auth env on the clone", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment().seed(compute, {
      kind: "repo",
      source: { git: "https://github.com/octo/public.git", ref: "main" },
    });
    const clone = calls.find((c) => c.cmd.includes("git clone"));
    expect(clone?.cmd).toContain("https://github.com/octo/public.git");
    expect(clone?.opts?.env).toBeUndefined(); // no auth header
  });

  it("private git (gitToken): injects http.extraheader via env and the token never lands in argv", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment({ gitToken: "gho_secret_tok" }).seed(compute, {
      kind: "repo",
      source: { git: "https://github.com/acme/private.git", ref: "main", connectionId: "conn-1" },
    });
    const clone = calls.find((c) => c.cmd.includes("git clone"));
    // the token is never exposed on the command line (argv) (ps/log safe).
    expect(clone?.cmd).not.toContain("gho_secret_tok");
    // auth goes via env (GIT_CONFIG_* → http.extraheader).
    expect(clone?.opts?.env?.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer gho_secret_tok");
    expect(clone?.opts?.env?.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(clone?.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("a files seed makes a git init baseline commit", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment().seed(compute, { kind: "repo", source: { files: { "a.txt": "hi" } } });
    expect(calls.some((c) => c.cmd.includes("git init"))).toBe(true);
    expect(calls.every((c) => c.opts?.env === undefined)).toBe(true); // no auth env on the files path
  });
});
