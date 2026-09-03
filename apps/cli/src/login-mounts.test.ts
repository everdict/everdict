import { afterEach, describe, expect, it } from "vitest";
import { LOGIN_MOUNTS, loginMountsFor } from "./login-mounts.js";

// A machine login is lent to a container the workspace supplied the code for, so every arm of this decision
// is a security decision as much as a convenience one.
const flags = (...f: string[]) => new Set(f);
const anyPath = () => true;
const noPath = () => false;

const saved = { ...process.env };
afterEach(() => {
  process.env.CODEX_HOME = saved.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
});

describe("which machine logins a containerized job may see", () => {
  it("lends NOTHING without the flag — the mount is opt-in, never a default", () => {
    const { mounts, notes } = loginMountsFor(flags(), { dockerOk: true, exists: anyPath });
    expect(mounts, "a default-on mount hands somebody else's evaluation the owner's login").toEqual([]);
    expect(notes).toEqual([]);
  });

  it("lends the login the flag names, and says where the harness points its CLI", () => {
    process.env.CLAUDE_CONFIG_DIR = "/home/me/.claude";
    const { mounts, notes } = loginMountsFor(flags("mount-claude-login"), { dockerOk: true, exists: anyPath });
    expect(mounts).toEqual([{ source: "/home/me/.claude", target: "/claude" }]);
    expect(notes[0]).toContain("CLAUDE_CONFIG_DIR=/claude");
  });

  it("lends BOTH when both are asked for — the arms are independent", () => {
    process.env.CODEX_HOME = "/home/me/.codex";
    process.env.CLAUDE_CONFIG_DIR = "/home/me/.claude";
    const { mounts } = loginMountsFor(flags("mount-codex-login", "mount-claude-login"), {
      dockerOk: true,
      exists: anyPath,
    });
    expect(mounts.map((m) => m.target)).toEqual(["/codex", "/claude"]);
  });

  it("REFUSES without docker, and says so — there is no container to mount into", () => {
    const { mounts, notes } = loginMountsFor(flags("mount-claude-login"), { dockerOk: false, exists: anyPath });
    expect(mounts).toEqual([]);
    expect(notes[0]).toContain("no docker");
  });

  // Mounting a path that is not there makes Docker CREATE an empty directory, and the CLI inside then reports
  // itself logged out — which reads downstream as an agent that could not do the task rather than a runner
  // that was never authenticated.
  it("REFUSES a login directory that is not there, rather than mounting an empty one", () => {
    process.env.CLAUDE_CONFIG_DIR = "/home/me/.claude";
    const { mounts, notes } = loginMountsFor(flags("mount-claude-login"), { dockerOk: true, exists: noPath });
    expect(mounts).toEqual([]);
    expect(notes[0]).toContain("not found");
    expect(notes[0]).toContain("/home/me/.claude");
  });

  // The codex arm shipped and the Claude Code arm did not exist, which is the sibling-lane shape rule
  // `protocol` names. This is the assertion that keeps the next agent CLI from being a third omission.
  it("every declared login has a flag, a target and the env var a harness sets", () => {
    expect(LOGIN_MOUNTS.length).toBeGreaterThanOrEqual(2);
    for (const m of LOGIN_MOUNTS) {
      expect(m.flag, "the flag is what makes it opt-in").toMatch(/^mount-.+-login$/);
      expect(m.target.startsWith("/"), m.label).toBe(true);
      expect(m.env, "a mount a harness cannot point its CLI at is a mount nothing uses").toMatch(/^[A-Z_]+$/);
    }
    expect(new Set(LOGIN_MOUNTS.map((m) => m.target)).size, "two logins at one path would shadow").toBe(
      LOGIN_MOUNTS.length,
    );
  });
});
