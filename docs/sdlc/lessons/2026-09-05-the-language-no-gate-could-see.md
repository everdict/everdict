# The file that decides what the exam is was fixed five times, and no gate could read it

Date: 2026-09-05
Found by: reviewing the seven commits on `main` — specifically by asking *which gate covers this*, and
running the grep that answers it:

    $ grep -rn "\.py\b" package.json .github/workflows/ci.yml scripts/ci-local.mjs
    (nothing)

## What was believed

That this repository's quality bar applies to this repository. It is stated in CLAUDE.md as five commands
and enforced as twenty-seven bespoke gates, a push stamp, a commit ledger and a review that must run before a push
carrying product code. Nothing says "except Python", because nobody had needed to think about Python.

The belief was true for TypeScript, and TypeScript is 99% of the tree. `examples/bundles/**` is 64 `.py`
files, and one of them is `sbench_stage.py`: the mint that decides WHAT THE EXAM IS. Its own docstring says
what a mistake there costs — *"a digest minted from a broken answer key is an exam that scores a correct
answer zero. Nothing downstream can tell that apart from an agent that got it wrong."*

## What made it invisible

It was never hidden. It was *outside* — outside the layer spine, outside every scanner's corpus, outside
`pnpm test`, outside the type checker. A file that no gate reads produces no signal of any kind, including
no signal that it is unread. `scanner-watches` asks whether a scanner's vocabulary died; nothing asks
whether a LANGUAGE has a scanner.

And the evidence was in plain sight for two days, in the shape of the git log:

    52bd0e77  a question the grader could not ask was being spent as the agent's wrong answer
    145789dc  an empty context matched an empty context, and refused ten cases on it
    67db140f  the identity is asked first, or a swap of two equal contexts refuses a correct key
    f7eaccda  the free-text channel that skipped the exclusion
    26ecdfc6  "a human should read these" over 220 cases is 220 findings nobody reads

Five fixes to one 249-line file in two days, each finding the previous one's defect, every one found by a
person running the script by hand against the real 912-instruction dataset — because there was no other way
to run it. That cadence is what a file with no tests looks like from the outside, and it read as diligence.

There was a step in `ci.yml` (added by `e3340474`) that ran one Python self-test through a shell loop over a
glob matching a single file. It existed only in the workflow, so `pnpm ci:local` could not run it: gate
drift, of exactly the kind skill `ci` warns about, present from that step's first commit.

## What would have caught it earlier

`python3 -m py_compile` over the tracked `.py` files. One second, no dependencies, and it would have run
from the day the first script landed. The expensive version — a linter, a type checker, an installed test
runner — is the version whose cost is why nothing existed at all.

## What was done about it

Eval case: none — the agent under test was never asked anything here; the harness had no eyes on a language.

A gate: `pnpm python` (`scripts/check-python.mjs`), in `ci:local` and `ci.yml`, replacing the shell loop.
It compiles every tracked `.py` and runs every `test_*.py` plus every declared self-test, and **a test that
cannot run is a failure, not a skip** — the rule `scripts/trust/trust-suite.mjs` already applies to a
skipped scenario.

That constraint changed the design rather than the CI configuration: the staging DECISION was lifted into
`sbench_pairing.py`, standard-library-only, so it can be driven with dicts instead of three workbooks and
openpyxl. `test_sbench_stage.py` is eleven counterexamples over the five fixes above, and four of them go
red on the code as it shipped this morning.

Writing the gate found something nobody went looking for: **five test suites that have never run, ever**.
`clients/python/tests/` (117 lines over the published client) and
`examples/servers/spica-playwright-server/tests/` (360 lines) need `pytest`, `httpx` and an editable
install, and there is no `pytest` anywhere in this repository's tooling. They are not skipped — they were
never wired. They are DECLARED in the gate's `NEEDS` map with what each is missing, so the gap is counted on
every run and cannot grow silently, and the decision to install them is recorded as
`intent/2026-09-05-python-suites-that-have-never-run/` rather than made by a check that ran because a push
happened.

No eval case. The agent under test was never asked anything here; the harness simply had no eyes on a
language. Replaying it as a prompt would measure the wrong thing.

## The question this leaves open

`.sh`, `.sql` and `Dockerfile` have the same amount of coverage that `.py` had this morning. `recalc.sh`
sits in the same directory as the file this lesson is about.
