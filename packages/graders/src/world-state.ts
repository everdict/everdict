import type { GradeContext, Grader, Score } from "@everdict/contracts";

// ── WHAT THE WORLD LOOKS LIKE AFTER THE AGENT ACTED ON IT ────────────────────────────────────────────
//
// docs/architecture/world-and-engagement-model.md, axis 1. A whole family of benchmarks decides a case by
// comparing the WORLD's final state against what the task asked for — not the agent's answer, and not its
// trace. That comparison needs three things this repo now has: a world the case acts on, that world's own
// published account (`EnvironmentSpec.observe` → an `EnvDelta{kind:"world-recording"}` on the platform's
// observation channel), and a grader that reads it.
//
// This is that grader, and everything it refuses is the point:
//   · it reads the PLATFORM's observation, never the agent's trace. A world's state reported by the thing
//     being measured is not evidence about the world;
//   · an observation that could not be made is `unmeasured`, never a 0. A world nobody could read is not a
//     world where nothing happened — the distinction the whole channel exists to keep;
//   · what it compares is a SUBSET claim: every field the case declares must appear, with that value, in the
//     world's account. A benchmark's expected state names the rows that must be true, not the whole database,
//     and demanding equality would fail every case for fields the task never mentioned.
export interface WorldStateConfig {
  // The expected state, as the JSON a case declares. Every leaf here must appear in the world's account with
  // the same value; anything else in the account is the world's business.
  expect?: unknown;
  // Where in the account to look, as a dot path — for a world that publishes `{ db: {...}, log: [...] }` and a
  // case that speaks about the database. Absent = the whole account.
  path?: string;
}

export function worldStateGrader(cfg: WorldStateConfig = {}): Grader {
  return {
    id: "world-state",
    async grade(ctx: GradeContext): Promise<Score> {
      const expected = cfg.expect ?? parseJson(ctx.case.expected);
      if (expected === undefined)
        return unmeasured("this case declares no expected world state, so there is nothing to compare");
      const observations = ctx.observations;
      if (observations.kind !== "sampled")
        return unmeasured(`the world published no account this run (${observations.reason})`);
      const recorded = [...observations.deltas].reverse().find((d) => d.kind === "world-recording");
      if (recorded === undefined)
        return unmeasured("the platform watched the world but it published no state to compare against");
      const account = parseJson(recorded.text);
      if (account === undefined)
        return unmeasured("the world's account is not JSON, so a state comparison cannot be made from it");
      const scoped = cfg.path === undefined ? account : at(account, cfg.path);
      if (scoped === undefined)
        return unmeasured(`the world's account has nothing at '${cfg.path}' — the comparison was never made`);
      const missing = subsetDefects(expected, scoped, "");
      return {
        graderId: "world-state",
        metric: "world_state",
        value: missing.length === 0 ? 1 : 0,
        pass: missing.length === 0,
        ...(missing.length > 0 ? { detail: `the world does not match: ${missing.slice(0, 5).join("; ")}` } : {}),
      };
    },
  };
}

function unmeasured(detail: string): Score {
  return {
    graderId: "world-state",
    metric: "world_state",
    status: "unmeasured",
    reason: "unsupported",
    retryable: false,
    detail,
  };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function at(value: unknown, path: string): unknown {
  let cursor = value;
  for (const key of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

// Every leaf the expectation names, found with that value in the account. Named `defects` rather than a
// boolean because a failed comparison that cannot say WHICH field differs sends the next reader to a diff
// they have to compute themselves.
export function subsetDefects(expected: unknown, actual: unknown, at: string): string[] {
  const where = at === "" ? "the state" : at;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${where} is not a list`];
    if (expected.length !== actual.length)
      return [`${where} has ${actual.length} entries, expected ${expected.length}`];
    return expected.flatMap((item, i) => subsetDefects(item, actual[i], `${where}[${i}]`));
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return [`${where} is not an object`];
    const target = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, want]) =>
      key in target
        ? subsetDefects(want, target[key], at === "" ? key : `${at}.${key}`)
        : [`${at === "" ? key : `${at}.${key}`} is missing`],
    );
  }
  return expected === actual ? [] : [`${where} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`];
}
