import { type CliIdentitySpec, CliIdentitySpecSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { assertCliIdentityHandsSomethingOver, chooseCliIdentity } from "./cli-identity.js";

const spec = (over: Partial<CliIdentitySpec> = {}): CliIdentitySpec => ({
  type: "cli-identity",
  cli: "claude-code",
  env: {},
  home: [],
  ...over,
});

describe("cli identity — an identity that hands nothing over is a label", () => {
  // It would register, resolve, boot, and leave the CLI logged out. The session reports success; the delegate
  // discovers it has no account at its first call, which is far from the author who could have fixed it.
  it("refuses a spec carrying neither env nor home", () => {
    expect(() => assertCliIdentityHandsSomethingOver(spec())).toThrow(/must hand something over/);
  });

  it("accepts one that carries only the environment — a headless token is the whole identity for Claude Code", () => {
    expect(() =>
      assertCliIdentityHandsSomethingOver(spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: { secretRef: "MY_TOKEN" } } })),
    ).not.toThrow();
  });

  // Codex's credential IS a file, which is why there is no dedicated `credential` field to be empty here.
  it("accepts one that carries only files", () => {
    expect(() =>
      assertCliIdentityHandsSomethingOver(
        spec({ cli: "codex", home: [{ path: ".codex/auth.json", secretRef: "MY_CODEX_AUTH" }] }),
      ),
    ).not.toThrow();
  });
});

describe("cli identity — one is a choice, two is a refusal", () => {
  const mine = (id: string) => ({ id, version: "1.0.0" });

  it("runs as the submitter's own when exactly one matches the CLI, with nothing named per call", () => {
    expect(chooseCliIdentity({ mine: [mine("my-claude")], cli: "claude-code" })).toEqual({
      kind: "mine",
      identity: mine("my-claude"),
    });
  });

  // The whole point of registering one is not naming it again — and a caller who DOES name one has already
  // answered the question this function exists to ask.
  it("lets an explicit reference win over the implicit lookup", () => {
    expect(chooseCliIdentity({ explicit: mine("team-ci"), mine: [mine("my-claude")], cli: "claude-code" })).toEqual({
      kind: "explicit",
      identity: mine("team-ci"),
    });
  });

  // Choosing between two of someone's own accounts is a guess about who did the work, and a guess that is
  // usually right is the worst kind — nobody checks until the wrong account is the one on the invoice.
  it("refuses two candidates and names them, instead of picking", () => {
    expect(() => chooseCliIdentity({ mine: [mine("personal"), mine("work")], cli: "claude-code" })).toThrow(
      /personal, work/,
    );
  });

  // "You registered none" is a real answer and not an error: the session runs without one and says so.
  it("answers `none` rather than inventing one", () => {
    expect(chooseCliIdentity({ mine: [], cli: "codex" })).toEqual({ kind: "none" });
  });

  // An explicit reference is an answer even when the submitter has none of their own — otherwise "run as the
  // team's CI identity" would only work for people who also had a personal one.
  it("honours an explicit reference when the submitter owns none", () => {
    expect(chooseCliIdentity({ explicit: mine("team-ci"), mine: [], cli: "claude-code" })).toEqual({
      kind: "explicit",
      identity: mine("team-ci"),
    });
  });
});

// ── A PATH THAT CLIMBS OUT IS A REFUSAL, NOT A SANITISED WRITE ───────────────────────────────────────
// These files carry a credential and land under $HOME. A caller who wrote `..` meant somewhere else, and
// quietly writing to a different place than the spec says is worse than saying no — the spec would then
// describe a file that is not where it claims, which is the version of this that nobody can audit.
describe("cli identity — where a file may land", () => {
  const withPath = (path: string) => ({
    type: "cli-identity" as const,
    cli: "claude-code" as const,
    env: {},
    home: [{ path, content: "x" }],
  });

  it("accepts the paths a CLI actually reads", () => {
    for (const path of [".claude/settings.json", ".codex/config.toml", ".config/x/y.json"])
      expect(CliIdentitySpecSchema.safeParse(withPath(path)).success).toBe(true);
  });

  it("refuses a path that climbs out of $HOME", () => {
    expect(CliIdentitySpecSchema.safeParse(withPath("../root/.ssh/authorized_keys")).success).toBe(false);
    expect(CliIdentitySpecSchema.safeParse(withPath(".claude/../../etc/passwd")).success).toBe(false);
  });

  it("refuses an absolute path — the container's $HOME is the only base it may have", () => {
    expect(CliIdentitySpecSchema.safeParse(withPath("/etc/passwd")).success).toBe(false);
  });
});
