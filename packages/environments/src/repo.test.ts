import { NO_IMAGE } from "@everdict/contracts";
import type { ComputeHandle, ExecOpts } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { RepoEnvironment } from "./repo.js";

// A fake that records exec calls (cmd + opts) — verifies git commands / auth env injection.
function recorder() {
  const calls: { cmd: string; opts?: ExecOpts }[] = [];
  const compute: ComputeHandle = {
    image: NO_IMAGE,
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

  it("private git (gitToken): scopes http.extraheader to the remote and the token never lands in argv", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment({ gitToken: "gho_secret_tok" }).seed(compute, {
      kind: "repo",
      source: { git: "https://github.com/acme/private.git", ref: "main", connectionId: "conn-1" },
    });
    const clone = calls.find((c) => c.cmd.includes("git clone"));
    // the token is never exposed on the command line (argv) (ps/log safe).
    expect(clone?.cmd).not.toContain("gho_secret_tok");
    // auth goes via env (GIT_CONFIG_* → http.<url>.extraheader).
    expect(clone?.opts?.env?.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer gho_secret_tok");
    // ⚠️ SCOPED, and this assertion used to read `http.extraheader` with no URL — the spelling git applies to
    // EVERY host the process talks to. A clone whose tree carries a `.gitmodules` pointing elsewhere, or a
    // host answering with a cross-host 30x, therefore received a live installation token for somebody else's
    // repositories. The first version of the change that scoped `gitAuthEnv` left this sibling asserting the
    // broadcast form — the one-lane-only law in the shape it takes when the other lane is a test — and the
    // commit gate is what said so. The trailing `.git` is normalised away, so the same repository written
    // either way produces one scope.
    expect(clone?.opts?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/acme/private.extraheader");
    expect(clone?.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("a files seed makes a git init baseline commit", async () => {
    const { calls, compute } = recorder();
    await new RepoEnvironment().seed(compute, { kind: "repo", source: { files: { "a.txt": "hi" } } });
    expect(calls.some((c) => c.cmd.includes("git init"))).toBe(true);
    expect(calls.every((c) => c.opts?.env === undefined)).toBe(true); // no auth env on the files path
  });
});
