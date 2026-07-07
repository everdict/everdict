// live e2e (SLICE 60): a SaaS user adds a *new* test-running benchmark entirely on their own, with zero first-party code.
// A benchmark = pure data (EvalCase): env.source (code) + env.setup (dependency-provisioning commands) + graders=[generic command].
// No catalog adapter, no dedicated grader like swe-bench → full runCase loop + real pytest for scoring.
//   A) fix + setup → resolved
//   B) no fix + setup → unresolved (test fails)
//   C) fix + no setup → unresolved (dependency not provisioned → ImportError) = proves env.setup is a load-bearing data hook
import { Buffer } from "node:buffer";
import process from "node:process";
import { LocalDriver } from "../../packages/drivers/dist/index.js";
import { RepoEnvironment } from "../../packages/environments/dist/index.js";
import { makeGraders } from "../../packages/graders/dist/index.js";
import { ScriptedHarness } from "../../packages/harnesses/dist/index.js";
import { runCase } from "../../packages/runner/dist/index.js";

// case of a new benchmark the user imported (pure data; there is no line about this benchmark in our code).
const FILES = {
  // lib depends on the _deps module that setup creates → without env.setup (dependency provisioning) the import fails.
  "lib.py": "from _deps import OFFSET\n\ndef solve(x):\n    return x + OFFSET  # BUG: should be x*2\n",
  "make_deps.py": "open('_deps.py', 'w').write('OFFSET = 0\\n')\n",
  "test_lib.py": "from lib import solve\n\ndef test_solve():\n    assert solve(3) == 6\n",
};
const userCase = (withSetup) => ({
  id: "fix-solve",
  env: {
    kind: "repo",
    source: { files: FILES },
    ...(withSetup ? { setup: ["python3 make_deps.py"] } : {}), // dependency provisioning = data (user-provided)
  },
  task: "Fix solve() in lib.py so test_lib passes (should return x*2).",
  // scoring is data too — a generic command grader (no benchmark-specific code).
  graders: [{ id: "command", config: { cmd: "python3 -m pytest -q --no-header test_lib.py", metric: "resolved" } }],
  timeoutSec: 60,
  tags: [],
});

// agent harness: a ScriptedHarness that produces the fix (stands in for the agent). base64 avoids quoting issues.
const FIXED = "from _deps import OFFSET\n\ndef solve(x):\n    return x * 2 + OFFSET\n";
const fixPlan = () => [{ tool: "bash", cmd: `echo ${Buffer.from(FIXED).toString("base64")} | base64 -d > lib.py` }];
const noopPlan = () => [];

async function run(label, { fix, setup }) {
  const result = await runCase(userCase(setup), {
    driver: new LocalDriver(),
    environment: new RepoEnvironment(),
    harness: new ScriptedHarness("1.0.0", fix ? fixPlan : noopPlan),
    graders: makeGraders(userCase(setup).graders),
    runCtx: { apiKeyEnv: {}, timeoutSec: 300 },
  });
  const s = result.scores.find((x) => x.metric === "resolved");
  console.log(`[${label}] resolved=${s?.pass}  ${String(s?.detail).split("\n").slice(-2)[0]?.slice(0, 60) ?? ""}`);
  return s;
}

console.log("=== user-defined new benchmark (zero catalog/dedicated-grader code) — runCase + real pytest ===");
const a = await run("fix + setup ", { fix: true, setup: true });
const b = await run("no-fix+setup", { fix: false, setup: true });
const c = await run("fix + NO setup", { fix: true, setup: false });

const ok = a?.pass === true && b?.pass === false && c?.pass === false;
console.log(
  ok
    ? "\n✅ SLICE 60: the user defines a new test-running benchmark as pure data (env.source + env.setup + generic command grader) → scored with the full runCase loop + real pytest, no first-party code. fix → resolved, no fix → unresolved, and without setup the dependency is not provisioned → unresolved (= env.setup is a data hook). SWE-bench-style benchmarks are just a preset on top of this."
    : "\n⚠️ does not match expectation",
);
process.exit(ok ? 0 : 1);
