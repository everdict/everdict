# `evals/` — regression tests for the configuration that steers the agent

`pnpm docs-check` and `pnpm convention-harness` ask whether `CLAUDE.md`, the rules and the skills are still
SHAPED right: paths resolve, symbols exist, globs match live code, descriptions survive. Neither can ask the
question that matters after a skill is edited — **does the agent still do the work to the same standard?**

A skill edit that stops it triggering, a rule whose wording drifted from what it meant, a `CLAUDE.md` line
deleted as redundant: every one of those leaves every existing gate green, and the only witness is the next
session that quietly does the wrong thing. `evals/` is that witness, written down.

## Running it

```sh
pnpm agent-evals                      # the whole suite (pinned model)
pnpm agent-evals --only <id>          # one case
pnpm agent-evals --list               # ids and their subjects
pnpm agent-evals --model opus         # the other question: does a model swap still pass?
pnpm agent-evals --drill <id>         # the removal drill — see below
```

Each case is one `claude -p` run with `cwd` at the repository root, which is the point: `CLAUDE.md`, the
rules and the skills are discovered exactly as a real session discovers them. Transcripts land in
`evals/.results/<id>.json` (gitignored) and are named in every failure line.

**The model is pinned by default**, and that is a deliberate trade. Pinning makes the *configuration* the only
variable, and it keeps a run affordable — the ambient default here is opus-1M, where a trivial call costs
$0.22, and a suite that costs that per case is a suite that gets switched off. `--model <alias>` asks the
article's other question: when a new model is swapped in, does the agent still do the work?

## A case

```json
{
  "id": "biome-write-is-not-evidence",
  "why": "the incident this comes from, in one line",
  "subject": [".claude/rules/ci.md"],
  "neutralize": ["biome check --write", "unsafe"],
  "allowedTools": "Read,Grep,Glob",
  "prompt": "what a person would actually say",
  "expect": { "mustMatch": ["pnpm lint", "unsafe"], "mustNotMatch": [] }
}
```

- **`why`** names the incident. Cases come from failures that actually happened here and are already written
  down. An invented case tests an invented convention.
- **`subject`** is every file that carries the lesson — often more than one, because the good ones are
  recorded in a rule *and* a skill *and* `CLAUDE.md`.
- **`neutralize`** are the sentences the drill removes. Every one of them must appear in some subject: the
  suite refuses to load a case whose neutralization matches nothing, because a declaration whose target was
  reworded still reads as a claim about what the case measures.
- **`expect`** asserts on ARTIFACTS the agent must name — a command, a file it must read first, a refusal —
  never on phrasing. The first version of `ci-local-before-push` asserted the literal `ci:local` and went red
  against an answer that had *run the gate* and written "CI-local"; the behaviour was right and the assertion
  was wrong. Assertions are regexes, matched case-insensitively.

## The removal drill

```sh
pnpm agent-evals --drill ci-local-before-push
```

Deletes every line in the case's subjects containing one of its `neutralize` strings, re-runs that case, and
**requires it to go RED**, restoring the files in a `finally`. It removes the sentence, not the file: blanking
a whole `CLAUDE.md` proves only that an empty `CLAUDE.md` steers nothing.

This is the part that makes the rest worth anything. Without it the suite proves that seven agent calls
returned text. `scripts/trust/protocol-mutations.mjs` is the same idea one layer down, over the product's
protocols — and where that gate costs ninety minutes of real builds and real suites, this one costs a single
agent call, which is why it can stay.

A killed drill leaves neutralized files behind (a `finally` does not run when the process is killed). It
records what it touched in `.git/everdict-eval-drill-stale` and refuses to start again until they are
restored — `git checkout -- <the files it names>`.

## Where it is enforced — the push gate, not CI

Not in `pnpm ci:local`, for the reason `protocol-mutations` left CI: a gate that makes every iteration wait
gets switched off, and then nothing runs. Not in GitHub Actions either, and that one is worth stating plainly
— **the suite never needed an API key.** Five local runs used the machine's existing login, which is the same
principle this repository already states for the execution layer: *"for LocalDriver the harness uses the
machine's existing login (no API key)."* A GitHub runner is a bare machine with no login, so running it there
would require an `ANTHROPIC_API_KEY` secret — a cost of the delivery choice, not of the thing delivered.

So it is enforced where enforcement already lives. `scripts/hooks/pre-push-gate.mjs` denies a push whose
commits are not in the CI-parity ledger; it now also denies a push that **changes** `CLAUDE.md`, `.claude/**`
or `evals/**` unless `.git/everdict-evals-ok` stamps the current HEAD. A green `pnpm agent-evals` writes that
stamp. A push that leaves the configuration alone never meets the arm.

The stamp attests a COMMIT, so a run over dirty configuration declines to write one and says so: the suite
overlays the working tree's `CLAUDE.md`/`.claude` into its worktree precisely so an edit can be tested before
it is committed, and that is the same reason such a run cannot then vouch for HEAD. `--only` never stamps —
it answers about one case, and the gate asks about the configuration.

Unlike the CI ledger, the eval stamp is **tip-only**. That one is per-commit because a bisect lands on an
intermediate commit; nobody bisects a skill's wording.

## Owed: the model-swap question

*"When a new model is swapped in, does the agent still do the work to the same standard?"* — the article's
other question, and the reason a scheduled run exists at all, since a model change moves the answer with no
commit to trigger on. **There is no unattended answer to it here**, because that needs CI credentials and this
repository chose not to hold them. `pnpm agent-evals --model <alias>` asks it by hand. Removing this section
is the definition of done for that debt.

## What the runs cost, and what they bought

Calibration is not overhead; it is the work. Every one of these was found by running the suite, not by reading
it — and four of the six were defects in the suite itself, which is the ordinary case.

| Run | Result | What it found |
|---|---|---|
| 1 | 0/1 | The assertion required the literal `ci:local` and went red against an answer that had **run the gate** and written "CI-local". The behaviour was right; the assertion was a word. |
| 2 | 4/7 | The eval sessions **wrote to the repository under test** — `packages/graders/src/step-budget.ts` created, two files edited. `--allowedTools` ADDS to what is permitted, and the session inherited `.claude/settings.json`. Hence the throwaway worktree, the deny list, and the after-check that observes the deny actually refusing. |
| 3 | 5/7 | Two lessons lived only in `.claude/rules/ci.md`, which is injected while you EDIT — so a question asked before touching anything never reaches them. The unsafe-fix trap and the `trust-fast` skip rule moved into `CLAUDE.md`. |
| 4 | 6/7 | `authz-optional-reflex` tested a call this repository cannot make (see `RETIRED.md`). |
| 5 | **7/7** | A prompt a correct **generic** answer satisfies cannot test a **specific** lesson: "is lint green?" is answerable with "run `pnpm lint`" by anyone. Narrowed to "`--write` exited 0 but `pnpm lint` still fails — how?", where the lesson is necessary. |

Then the drills, which found three more — a `process.exit()` inside a `try` that skipped its `finally` and
leaked a worktree per run; a load-time check matching whole files where the drill matches lines; and a line
satisfying two `neutralize` needles that credited only the first. One case was retired rather than tuned.

A full run is about 90 seconds of wall clock and **roughly $1.50–1.70** at the pinned model. That number is
why the path filter exists.
