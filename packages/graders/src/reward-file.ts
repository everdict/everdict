import {
  BUILTIN_GRADER_OWNED_METRICS,
  BadRequestError,
  type GradeContext,
  type Grader,
  type Score,
  shq,
} from "@everdict/contracts";

// ── THE REWARD IS A PUBLISHED FILE, NEVER AN EXIT CODE ───────────────────────────────────────────────
//
// A Terminal-Bench-format task grades itself by copying its `tests/` directory into the container after
// the agent is done, running the verifier command, and having that command WRITE the reward to
// `/logs/verifier/reward.txt` (a single number) or `/logs/verifier/reward.json` (`{key: number}`).
//
// The process exit status is not part of that contract, and in the real corpus it actively contradicts it.
// Verbatim, the tail of a Terminal-Bench task's `tests/test.sh`:
//
//     if [ "$AGENT_NORMALIZED" = "$EXPECTED_NORMALIZED" ]; then
//         echo 1 > /logs/verifier/reward.txt
//     else
//         echo 0 > /logs/verifier/reward.txt
//     fi
//     echo "=== SCRIPT FINISHED ==="
//     exit 0                      # ← a right answer and a wrong answer leave the same exit code
//
// Terminal-Bench 2.0 tasks have the same shape (the `if … fi` is the last statement, so `$?` belongs to the
// `echo`). Reading these tasks with the exit-code grader (`tests-pass`) scores EVERY case as passing — not a
// weak measurement but a fabricated one. That is protocol law L3: the outcome was re-derived from rendered
// output (process status) instead of read at its source (the bytes the verifier authored).
// See `terminal-bench.ts` for the mapper that produces this grader's spec.
export interface RewardFileConfig {
  // The verifier command, run inside the case compute after the agent (the task format's verifier phase).
  cmd?: string;
  // The task's `tests/` payload, materialized into `testsDir` before the command runs. The format copies the
  // directory in at verify time (the agent must not see it beforehand), so the dataset carries the bytes and
  // the case stays self-contained — a run never re-clones the benchmark repo to find out how it is graded.
  files?: Record<string, string>;
  testsDir?: string; // where `files` land (the format's `/tests`)
  rewardDir?: string; // where the verifier publishes its reward (the format's `/logs/verifier`)
  cwd?: string; // verifier working directory; absent ⇒ the compute's own base (the image's WORKDIR)
  timeoutSec?: number; // `[verifier].timeout_sec`
  env?: Record<string, string>; // `[verifier].env` — resolved by the caller (secrets never live in a spec)
  // The reward at which the task counts as solved. Terminal-Bench's convention is `reward == 1`; a
  // continuous-reward task can lower it. Named rather than hardcoded, because "what counts as passing" is
  // exactly the decision that must not be invented by the reader of a number.
  passThreshold?: number;
  id?: string;
}

// The metric the primary reward lands on. `tests_pass` is a RESERVED ground-truth name (verdict-policy.ts)
// and this grader owns it INTRINSICALLY, like TestsPassGrader: a benchmark task's own verifier is the
// closest thing to ground truth the case has. Secondary keys of a multi-dimensional reward are namespaced
// (`reward:<key>`) so a task-authored key can never land on a constitutional name — the reward file's keys
// come from the benchmark's shell script, which is exactly the producer-controlled surface the reserved-name
// rule exists to keep out of the ladder.
// Read from the contracts table rather than spelled here. A literal is what let this grader's ownership and
// the settle's copy of it drift apart — the class claimed the name and the table never granted it.
const PRIMARY_METRIC = BUILTIN_GRADER_OWNED_METRICS["reward-file"][0];
const SECONDARY_PREFIX = "reward:";
// The 1-D convention: a multi-key reward dict names its headline value `reward` (the same key the format's
// `[[steps]].min_reward` float form gates on).
const PRIMARY_KEY = "reward";

const DEFAULTS = {
  cmd: "bash /tests/test.sh",
  testsDir: "/tests",
  rewardDir: "/logs/verifier",
  timeoutSec: 600,
  passThreshold: 1,
} as const;

// A number the reward file actually stated. `undefined` means "this file did not state one" — never 0,
// because a reward nobody published and a reward of zero are different facts about the agent.
function parseNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function parseRewardJson(raw: string): Record<string, number> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rewards: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    rewards[key] = value;
  }
  return Object.keys(rewards).length > 0 ? rewards : undefined;
}

// The verifier's published reward, as a THIRD value where it is missing. A verifier that ran but published
// nothing (crashed mid-script, wrote an unparseable file) has not measured the agent — and scoring that as 0
// would put a number the benchmark never produced into the mean, the leaderboard and the regression diff.
type RewardRead =
  | { kind: "rewards"; rewards: Record<string, number>; source: string }
  | { kind: "absent"; detail: string };

// ── A TASK FILE STAYS INSIDE THE TESTS DIRECTORY (arch-review 56, Wave B) ───────────────────────────
//
// `tests` is third-party content — an imported task is somebody else's repository — and its keys were written
// straight into `${testsDir}/${name}`. `LocalDriver.writeFile` is `join(root, path)` with no containment
// check, so `../../x` writes outside the sandbox: on the self-hosted and CLI lanes, the operator's own
// filesystem; inside a job container, the agent's workspace or the container's system paths.
//
// Refused rather than sanitised. A key that climbs is not a path this system should guess the intent of, and
// silently rewriting it would make the tests that ran differ from the tests the task declared.
export function containedTestsPath(name: string): string {
  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === ".." || s.includes("\0")) || name.startsWith("/"))
    throw new BadRequestError(
      "BAD_REQUEST",
      { name },
      `the task file '${name}' escapes the tests directory — a traversal path is refused, never rewritten.`,
    );
  return segments.join("/");
}

export class RewardFileGrader implements Grader {
  readonly id: string;
  // Its metric name is fixed in this file, not taken from config or from the reward file's keys, so the
  // ladder's ground-truth reading of it is a property of the implementation (arch-review 17 P0-2).
  readonly ownsMetrics = [PRIMARY_METRIC] as const;
  readonly needsCompute = true; // runs the verifier in the case environment — before compute is released

  constructor(private readonly cfg: RewardFileConfig = {}) {
    this.id = cfg.id ?? "reward-file";
  }

  async grade(ctx: GradeContext): Promise<Score[]> {
    const compute = ctx.compute;
    if (!compute)
      throw new BadRequestError(
        "BAD_REQUEST",
        { grader: this.id },
        "The reward-file grader requires compute (an environment).",
      );

    const testsDir = this.cfg.testsDir ?? DEFAULTS.testsDir;
    const rewardDir = this.cfg.rewardDir ?? DEFAULTS.rewardDir;
    const exec = { ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}), ...(this.cfg.env ? { env: this.cfg.env } : {}) };

    // ── THE REWARD NAMESPACE IS THE VERIFIER'S, AND IT STARTS EMPTY (arch-review 56, Wave B) ────────
    //
    // This was `mkdir -p` alone, and the verifier runs on the SAME compute the agent just used — so an agent
    // that wrote `/logs/verifier/reward.json` during its own turn had authored the number this grader reads,
    // and JSON wins over the `.txt` a real `test.sh` publishes. A verifier that then crashed or timed out
    // left the agent's file standing as the verdict. "The verifier published a reward" and "a reward file
    // exists" are different facts, and only the emptied directory makes them the same one.
    //
    // Emptied, not merely created: creating an existing directory is a no-op, which is exactly the case that
    // matters. `tests/` is emptied for the same reason — a stale copy from an earlier attempt is not this
    // verifier's.
    await compute.exec(`rm -rf ${shq(rewardDir)} ${shq(testsDir)}`, exec);
    await compute.exec(`mkdir -p ${shq(rewardDir)} ${shq(testsDir)}`, exec);
    for (const [name, content] of Object.entries(this.cfg.files ?? {})) {
      await compute.writeFile(`${testsDir}/${containedTestsPath(name)}`, content);
    }
    if (this.cfg.files) await compute.exec(`chmod -R a+rx ${shq(testsDir)}`, exec);

    const run = await compute.exec(this.cfg.cmd ?? DEFAULTS.cmd, {
      ...exec,
      timeoutSec: this.cfg.timeoutSec ?? DEFAULTS.timeoutSec,
    });
    const log = `${run.stdout}${run.stderr}`.slice(0, 2000);

    const read = await this.readReward(ctx, rewardDir);
    if (read.kind === "absent") {
      // A GRADER FAILURE, not a zero. `retryable: false` because re-running the same verifier over a
      // disposed environment cannot recover it — the run has to be repeated, which is a different decision.
      return [
        {
          graderId: this.id,
          metric: PRIMARY_METRIC,
          status: "unmeasured",
          reason: "missing_evidence",
          retryable: false,
          detail: `${read.detail}\nverifier exit ${run.exitCode}\n${log}`,
        },
      ];
    }

    const threshold = this.cfg.passThreshold ?? DEFAULTS.passThreshold;
    const keys = Object.keys(read.rewards);
    const primary = keys.length === 1 ? read.rewards[keys[0] as string] : read.rewards[PRIMARY_KEY];
    const detail = `${read.source}: ${JSON.stringify(read.rewards)}\nverifier exit ${run.exitCode}\n${log}`;

    const secondary: Score[] = keys
      .filter((key) => keys.length > 1)
      .map((key) => ({
        graderId: this.id,
        metric: `${SECONDARY_PREFIX}${key}`,
        value: read.rewards[key] as number,
        detail,
      }));

    if (primary === undefined) {
      // A multi-dimensional reward with no `reward` key states several numbers and no verdict. Inventing one
      // (a mean, the first key, "all above threshold") would be this file's own defect in a new place, so the
      // dimensions are reported and the pass/fail is declared UNMEASURED rather than derived.
      return [
        ...secondary,
        {
          graderId: this.id,
          metric: PRIMARY_METRIC,
          status: "unmeasured",
          reason: "unsupported",
          retryable: false,
          detail: `A multi-key reward with no "${PRIMARY_KEY}" key defines no single pass/fail. ${detail}`,
        },
      ];
    }

    return [
      { graderId: this.id, metric: PRIMARY_METRIC, value: primary, pass: primary >= threshold, detail },
      ...secondary,
    ];
  }

  // reward.json wins over reward.txt (the format reads the richer file first). A read is done with `cat` rather
  // than `readFile` on purpose: a missing file must come back as a VALUE this function can classify, not as
  // an exception some outer handler turns into its own meaning (protocol law L2).
  private async readReward(ctx: GradeContext, rewardDir: string): Promise<RewardRead> {
    const compute = ctx.compute;
    if (!compute) throw new BadRequestError("BAD_REQUEST", { grader: this.id }, "compute disappeared mid-grade.");
    const jsonPath = `${rewardDir}/reward.json`;
    const textPath = `${rewardDir}/reward.txt`;

    const json = await compute.exec(`cat ${shq(jsonPath)}`, { timeoutSec: 30 });
    if (json.exitCode === 0) {
      const rewards = parseRewardJson(json.stdout);
      if (rewards) return { kind: "rewards", rewards, source: jsonPath };
      return { kind: "absent", detail: `${jsonPath} is not a {key: number} object: ${json.stdout.slice(0, 200)}` };
    }

    const text = await compute.exec(`cat ${shq(textPath)}`, { timeoutSec: 30 });
    if (text.exitCode !== 0)
      return { kind: "absent", detail: `the verifier published no reward at ${jsonPath} or ${textPath}` };
    const value = parseNumber(text.stdout);
    if (value === undefined)
      return { kind: "absent", detail: `${textPath} does not hold a number: ${text.stdout.slice(0, 200)}` };
    return { kind: "rewards", rewards: { [PRIMARY_KEY]: value }, source: textPath };
  }
}
