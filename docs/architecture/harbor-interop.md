# Harbor interop — a domain-fit audit before the port

> Status: **audit complete, port not started.** SSOT for how Everdict ingests and RUNS the Harbor
> ecosystem (harborframework.com — the framework from the Terminal-Bench authors). Supersedes the Harbor
> half of `standard-task-formats.md`, which described the mapper but not the execution contract.
>
> This document answers one question first, because the answer decides the whole port: **can Everdict's
> domain express and execute a Harbor task end-to-end, for the real corpus and not a hello-world?** Where
> it can, the port is native. Where it cannot, this document either names the concept to borrow or
> **states the limit** — an unstated limit is how a benchmark silently measures something else.

## 0. What Harbor is, and what it is not

Harbor is an **agent-evaluation harness**: it starts a container, installs an agent into it, hands the
agent an instruction, then runs a verifier that writes a reward. It is the official harness for
Terminal-Bench 2.0. It is *not* a control plane — a "job" is a directory of trial directories on disk,
there is no tenancy, no authority ledger, no regression story, no verdict policy.

That is the complementarity: **Harbor owns the task format and the agent adapters; Everdict owns the
verdict.** The port therefore takes Harbor's *inputs* (tasks, agents) and refuses its *outputs* (its
result files as our evidence).

Correction to earlier docs: Harbor is from the **Laude Institute / Terminal-Bench** authors, not
Anthropic. `packages/datasets/src/harbor.ts` and `standard-task-formats.md` both said "Anthropic's
Harbor"; both are wrong and are fixed by this port.

### Measured scale (2026-08-18, `registry.json` @ `f03db62`)

| | count |
| --- | --- |
| datasets in `registry.json` | **80** |
| tasks addressed by those datasets | **51,625** |
| distinct (git repo, commit) pins behind them | 64 |
| benchmark adapter directories in `adapters/` | **84** (55 map to a registry dataset, 29 are adapter-only) |
| agent adapters (`AgentName` enum / registered in `agents/factory.py`) | **42 / 40** (~30 are plain CLI) |
| execution providers (`EnvironmentType` enum) | **20** — docker · apple-container · singularity · daytona · e2b · modal · runloop · novita · blaxel · islo · cwsandbox · tensorlake · gke · ack · openshift · ec2 · langsmith · wandb · use-computer · cua-cloud (Harbor's own `CLAUDE.md` still lists only 9 — the code is the source of truth) |

A registry entry pins every task to a **git URL + commit + path** — so a Harbor dataset is already an
immutable, content-addressed task list. That is the same discipline as our dataset versions and is the
reason a native import is even reasonable.

## 1. Concept mapping

| Harbor | Everdict | fit |
| --- | --- | --- |
| task directory (`task.toml` + `instruction.md` + `environment/` + `tests/`) | `EvalCase` | ✅ shape matches |
| `instruction.md` | `EvalCase.task` | ✅ |
| `[environment].docker_image` | `EvalCase.image` | ✅ |
| `environment/Dockerfile` (no image) | — | ⚠️ **§3.1 — the one hard gap** |
| `[agent].timeout_sec` | `EvalCase.timeoutSec` | ✅ |
| `[metadata]` difficulty/category/tags | `EvalCase.tags` | ✅ |
| `tests/` + reward file | a compute-bound `Grader` | ✅ but **not `tests-pass`** — §2 |
| `[verifier].env` | grader config env / `{secretRef}` | ✅ with §3.3 caveats |
| dataset `metrics` (mean/sum/min/max) | `summarizeScorecard` | ✅ (ours is richer) |
| Trial | one `CaseResult` (+ `trial` index for pass@k) | ✅ |
| Job | `Scorecard` | ✅ (ours adds the ledger) |
| `BaseInstalledAgent` (install + run) | `CommandHarnessSpec` (`setup[]` + `command`) | ✅ §4 |
| ATIF trajectory | `TraceEvent[]` | ◐ lossy both ways — §3.6 |
| provider (daytona/modal/…) | `Backend` / `RuntimeSpec` | ✅ conceptually; no adapters ported |

The execution ORDER is already identical, which is the strongest fit signal:

```
Harbor trial : environment.start → agent.setup → agent.run → verifier.verify → environment.stop
Everdict     : driver.provision → env.seed → harness.install → harness.run → snapshot
                                                                → grade(needsCompute) → release → grade(observation)
```
`packages/application-execution/src/run-case.ts` — a Harbor verifier is exactly a `needsCompute` grader.

## 2. 🚨 The defect this audit found first

Our existing adapters map a Harbor / Terminal-Bench task to the **`tests-pass` grader, which decides by
exit code**:

```ts
graders: [{ id: "tests-pass", config: { cmd: task.verifierCommand } }]   // harbor.ts, terminal-bench.ts
```

Harbor's verifier contract is **not** the exit code. `test.sh` writes the reward to a FILE
(`/logs/verifier/reward.txt`, or `reward.json` for a multi-key reward) and the exit code is meaningless.
Verbatim, from `harbor-datasets/datasets/gaia/00d579ea-…/tests/test.sh`:

```bash
if [ "$AGENT_NORMALIZED" = "$EXPECTED_NORMALIZED" ]; then
    echo 1 > /logs/verifier/reward.txt
else
    echo 0 > /logs/verifier/reward.txt
fi
echo "=== SCRIPT FINISHED ==="
exit 0            # ← correct AND incorrect answers both exit 0
```

Terminal-Bench 2.0 tasks have the same shape (`if pytest…; then echo 1 > reward.txt; else echo 0 > …; fi`
as the final statement, so `$?` is the `echo`'s). **Every case would score PASS.** A scorecard built this
way is not a weak measurement, it is a fabricated one — and nothing in the current tests catches it,
because the fixtures assert the mapping, never the semantics.

This is protocol law L3 (`.claude/rules/protocol.md`): the outcome was **re-derived from the wrong
surface** — process exit status instead of the reward the verifier actually published. The port replaces
it with a grader that reads the published bytes (§5, P0).

The same file is also evidence for a second point: Harbor's GAIA verifier compares with
`tr '[:upper:]' '[:lower:]'` + trim, which is **not** the official GAIA `question_scorer`
(number/list normalization, no article stripping). Harbor's dataset is an *adaptation*, not the official
scorer, and must be imported with `scoring: { kind: "proxy" }` — never as `official`
(`packages/datasets/src/scoring-semantics.ts` already models this; see also `judges.ts`, which carries
our verified GAIA/GSM8K ports).

## 3. Fit audit against the real corpus

Census of **63,283 `task.toml` files** (all of `laude-institute/harbor-datasets` @ HEAD, 97 dataset
directories) plus **89** from `laude-institute/terminal-bench-2` @ HEAD. Percentages are of the 63,283.

| feature | tasks | Everdict verdict |
| --- | ---: | --- |
| `environment/Dockerfile` only (no prebuilt image) | 60,661 (95.9%) | ⚠️ **gap — §3.1** |
| `[environment].docker_image` prebuilt | 2,622 (4.1%) | ✅ runs today |
| Terminal-Bench 2.0 tasks with prebuilt image | **89 / 89 (100%)** | ✅ **the e2e target** |
| `[verifier].env` non-empty | 17,696 (28.0%) | ◐ **§3.3** |
| — of which `OPENAI_API_KEY` | 16,087 (25.4%) | ◐ LLM-judge inside the verifier |
| legacy `allow_internet` | 4,988 (7.9%) | ◐ **§3.2** |
| `[environment].env` (host var passthrough) | 1,345 (2.1%) | ✅ maps to grader/harness env |
| `artifacts = [...]` | 1,251 (2.0%) | ◐ **§3.4** (all in one dataset, `lab`) |
| `[[environment.mcp_servers]]` | 800 (1.3%) | ◐ **§3.5** (all in `gaia2-cli`) |
| `[environment.healthcheck]` | 174 (0.3%) | ◐ borrow, cheap |
| `gpus > 0` | 58 (0.1%) | ✅ `ServiceResources.gpu` exists |
| **multi-step (`[[steps]]`)** | **0** | 🚫 **limit — §3.7** |
| separate verifier environment | 0 | 🚫 limit |
| `os = "windows"` | 0 | ✅ we support it anyway |
| TPU | 0 | 🚫 limit |

The headline: **the long tail Harbor's schema supports is essentially unused by the shipped corpus.**
Multi-step, separate verifier environments, TPU and Windows are zero across 63k tasks. The features that
actually matter are image provenance (96%), verifier secrets (28%), network policy (8%).

### 3.1 Image provenance — the one hard gap

Everdict **references images, never builds them** (`case.image` is the portability contract, rule
`datasets`). Harbor **builds `environment/Dockerfile` at run time**. 95.9% of the corpus is
Dockerfile-only, so a naive native port can run 4% of Harbor.

This is a real architectural difference, not an oversight on either side. Harbor can build because a
trial is a local process on a developer's Docker daemon; Everdict cannot because a case is dispatched to
a Nomad/K8s runtime that pulls, and because a verdict that references an image built from a Dockerfile
"sometime, somewhere" is not reproducible — `apt-get update` alone makes two builds different worlds.

**Decision: do not relax the contract. Add a build-and-push ON-RAMP outside the run path.**
`everdict harbor build <dataset>` builds each task's `environment/` locally (or in CI), pushes to the
workspace image registry (`docs/architecture/workspace-image-registry.md`, `everdict image push` already
exists), and emits the dataset with `image` pinned **by digest**. The build happens once, at import; the
run still only pulls. The digest is what makes the imported dataset reproducible in a way Harbor's own
run is not — a genuine improvement, not a workaround.

Consequence to state plainly: **importing a Dockerfile-only Harbor dataset requires a build step the user
must run and pay for** (storage + build time). TB 2.0 / TB-pro / ds1000 / browsecomp-plus / medagentbench
/ officeqa (≈2.6k tasks) skip it entirely.

### 3.2 Network policy — borrow the vocabulary, admit the enforcement gap

Harbor has a three-layer network model: baseline (`[environment].network_mode`), phase override
(`[agent]` / `[verifier]`), run-time merge (`--allow-agent-host`), with `public | no-network | allowlist`
and hostname/CIDR/wildcard entries. Everdict has **no network policy vocabulary on a case at all**.

For an eval runtime this is not cosmetic: `no-network` is what makes an offline reasoning benchmark
measure reasoning instead of retrieval, and 7.9% of the corpus declares it (as legacy `allow_internet`).
Importing those tasks while ignoring the field silently changes what the benchmark measures.

**Decision: borrow it, minimally and honestly.** Add `EvalCase.network` (`{ mode, allowedHosts[] }`),
carry it to the driver, enforce what each driver can (`DockerDriver`: `--network none` for `no-network`;
allowlist needs a proxy/firewall sidecar we do not have). Where a driver **cannot** enforce the declared
mode, the case **refuses** rather than running unprotected — an unenforceable isolation claim is the same
class of lie as the exit-code reward. Phase-level overrides are NOT ported (0 tasks use them).

### 3.3 Verifier secrets — the 28% that decides feasibility

28% of tasks need env in the verifier, and 25% specifically want `OPENAI_API_KEY`: the verifier itself
calls an LLM judge. Everdict already has the better model here (`JudgeSpec` as a versioned, registered,
separately-billed entity), but the imported task's judge is **hidden inside `test.sh`** — un-versioned,
un-metered, and it spends the workspace key from inside the case sandbox.

**Decision:** the import maps `[verifier].env` keys to `{ secretRef }` against workspace secrets, and the
grader refuses to run with an unresolved key (never "run with a missing key and score 0" — that is a
grader failure masquerading as an agent failure; see `grader-failure.trust.test.ts`). The dataset records
`scoring: { kind: "proxy", judgeInsideVerifier: true }` so a reader knows the number came from an opaque
in-task judge. Re-authoring those verifiers as first-class Everdict judges is a per-benchmark project,
explicitly out of scope for the port.

### 3.4 Artifacts (2.0%) — map onto what we have

Harbor collects declared container paths into the trial dir with a `manifest.json`. Everdict has
`ArtifactStore` + `offloadSnapshot` + the recording pipeline. Port as: `artifacts` entries → post-run
collection into the case's artifact refs. Low priority (one dataset), no domain change needed.

### 3.5 MCP servers in the environment (1.3%)

`[[environment.mcp_servers]]` declares MCP endpoints the AGENT should see. Everdict's agent-runtime
bridges MCP already, but a `CommandHarness` (an external CLI) has no channel to receive them — the CLI's
own config file would need writing, per agent. **Limit: not ported in P0**; `gaia2-cli` (800 tasks)
imports with a `capability: mcp` tag and refuses to run until an agent-specific writer exists.

### 3.6 ATIF ↔ TraceEvent — a two-way lossy bridge

ATIF (Agent Trajectory Interchange Format, Harbor RFC-0001) is a real interchange spec: `Step` with
`tool_calls[]` / `observation.results[]` / per-step `metrics` / `final_metrics` (tokens, cost, steps) /
multimodal `ContentPart` / `subagent_trajectory_ref`. Our `TraceEvent` covers tool calls, LLM calls and
cost. ATIF is *stronger* on subagent references and multimodal content; `TraceEvent` is stronger on
wall-clock (`at`/`t` on one axis) and on the seal/provenance fields the verdict rests on.

**Decision: bridge, do not adopt.** `atifToTraceEvents` (import a Harbor trajectory so Harbor-run
evidence can be *ingested* and judged — the existing `POST /scorecards/ingest` path) and
`traceEventsToAtif` (export, so an Everdict run is citable in the ATIF ecosystem). Neither replaces our
trace model, and the seal (`traceSealed`) is never set from an imported trajectory: a trajectory we did
not collect is a self-report.

### 3.7 Stated limits (things we deliberately will NOT do)

1. **Multi-step tasks** (`[[steps]]`, `min_reward` gates, `mean`/`final` reward strategies). Zero tasks in
   63k use them. Import **refuses** a multi-step task with a clear error rather than flattening it — a
   flattened multi-step task grades the wrong thing.
2. **Separate verifier environment / `[verifier.collect]`.** Zero usage. Refuse at import.
3. **TPU (`[environment.tpu]`), Windows containers via Harbor.** Zero usage; our own Windows lane is
   unaffected.
4. **Harbor's cloud providers** (daytona/modal/e2b/runloop/novita). These are Harbor's `Backend` layer and
   duplicate ours; we route to our own runtimes. A user who wants Daytona registers a `RuntimeSpec`.
5. **Harbor's own result files as evidence.** A `TrialResult` Harbor produced is ingested as a
   *self-reported* observation (`attestation: "self_reported"`), never as a managed run.
6. **Phase-level network overrides**, `[environment].skills_dir`, `user:` per phase. Zero-to-negligible
   usage; import warns and drops, and the drop is recorded on the dataset's import report — never silent.

## 4. Agents — the port is mechanical for the CLI ones

A Harbor `BaseInstalledAgent` is: system packages → an install command → a run command with the
instruction quoted in, plus env for the model connection. That is exactly `CommandHarnessSpec`. Aider,
verbatim from `src/harbor/agents/installed/aider.py`:

```
install : curl -LsSf https://aider.chat/install.sh | sh
run     : aider --yes --chat-history-file=/logs/agent/aider.chat.history.md \
            --model={model} --message={instruction} 2>&1 | tee /logs/agent/aider.txt
```
→
```jsonc
{ "kind": "command", "id": "harbor-aider", "version": "1.0.0",
  "setup": ["curl -LsSf https://aider.chat/install.sh | sh"],
  "command": "aider --yes --model={{model}} --message={{task}}",
  "env": { "AIDER_API_KEY": { "secretRef": "…" } } }
```

**Portable now (~30):** claude-code, codex, aider, goose, opencode, cursor-cli, gemini-cli, copilot-cli,
qwen-coder, kimi-cli, grok-build, hermes, cline-cli, rovodev-cli, trae-agent, mini-swe-agent, swe-agent,
openhands, fx, pi, mimo, mcode, vibe, openclaw, cortex-code, antigravity-cli, devin, kimi-code, nemo-agent.

**Not portable as a spec (needs a file payload in the container):** `openhands-sdk`, `langgraph`,
`deerflow`, `antigravity-sdk`, `acp`, `eve` (each uploads a Python/JS runner module), `terminus*`
(Harbor's own tmux agent), `computer-1`. These need a `CommandHarnessSpec.files` channel (write N files
into the sandbox before `setup`) — a small, generally useful addition, deferred to P3.

Two things worth **borrowing** from Harbor's agent layer regardless of the port:

- **The API-error taxonomy.** `ApiRateLimitError` / `ApiUsageLimitError` / `ContextWindowExceededError` /
  `AgentSafetyRefusalError` / `ApiOverloadedError`, matched from agent stderr by regex and wired to
  `--retry-include`. Ours (`classifyFailure`) classifies stage×fault but does not separate "the model
  refused" from "the provider was overloaded" — and Harbor's comment on `AgentSafetyRefusalError` names
  exactly the right reason: a genuine refusal is a real `reward 0`, not a flaky infra error, and merging
  them corrupts both the retry policy and the score.
- **`SUPPORTS_*` capability flags** on the agent (`SUPPORTS_ATIF`, `SUPPORTS_RESUME`, `SUPPORTS_WINDOWS`,
  `SUPPORTS_HANDOFF`). Declared capability beats probing, and it is the same idea as our runner capability
  probes — applied to the harness instead of the runtime.

## 5. The port, in phases

**P0 — the verifier protocol (correctness first).** `HarborVerifierGrader` in `packages/graders`:
materialize `tests/` into the container, `mkdir -p /logs/verifier`, run the verifier command under
`[verifier].timeout_sec`, then read `reward.json` (multi-key → one `Score` per key) or `reward.txt`
(single float → metric `reward`), and treat **a missing/empty reward file as a GRADER FAILURE**, not a
zero. Re-point `harbor.ts` and `terminal-bench.ts` at it. Counterexample first: a fixture whose verifier
exits 0 and writes `0` must score FAIL, and must have scored PASS on the pre-fix code.

**P1 — registry ingestion.** `registry.json` → dataset catalog (80 entries, browsable via
`GET /benchmarks`); a dataset import that clones the pinned commit, parses `task.toml` +
`instruction.md`, and emits `EvalCase[]` — refusing (not flattening) the §3.7 features and reporting
every dropped field.

**P2 — the e2e proof.** Terminal-Bench 2.0 sample (10 tasks, all prebuilt ghcr images, all with
`solution/solve.sh`): run them under `DockerDriver` with a real agent, and **run the oracle** —
`solve.sh` must score 1 and a no-op must score 0. A scorer that cannot tell those apart is the only
scorer failure that matters, and it is the one this port started from.

**P3 — agents (~30) + `CommandHarnessSpec.files` + the ATIF bridge + `EvalCase.network`.**

**P4 — the build-and-push on-ramp** (§3.1), which unlocks the other 96% of the corpus.

## 6. What Everdict should take from Harbor, independent of the port

1. **A task is a directory, and the reward is a published file.** The file-based reward is *better* than
   an exit code precisely because it is a value the verifier had to author. Our `script-grader` already
   has this shape (JSON on stdout); the Harbor contract is the same idea with a durable artifact.
2. **`solution/solve.sh` shipped with the task.** An oracle per task is the only cheap, continuous check
   that a scorer still discriminates. We have oracle-loop notes but no per-case oracle field —
   `EvalCase.oracle` deserves to exist.
3. **The adapter as a first-class, reviewed artifact** (84 of them, each with a README, and one shared
   parity CSV — **296 rows over 83 benchmarks** — recording the port's numbers against the original
   paper's, with per-run values, std and run count, split into "harbor adapter x original" and "harbor
   adapter x terminal-bench adapter"). Our benchmark catalog has the adapters but not the *parity
   evidence*; `adapters/parity_summary.csv` is the artifact to imitate. Note the discipline in the split:
   agreement between two ports is not agreement with the original.
4. The API-error taxonomy and the agent capability flags (§4).
