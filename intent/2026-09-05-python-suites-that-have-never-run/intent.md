# Intent: five Python test suites have never been run, by anything, ever

Author: Claude (agent, at the maintainer's request during a review of main). Status: draft

## Problem

Writing `pnpm python` — the gate that gave this repository its first automated read of a `.py` file at all —
turned up 477 lines of tests that no process has ever executed:

    clients/python/tests/test_client.py                              117 lines   needs pytest
    examples/servers/spica-playwright-server/tests/test_api.py         92 lines   needs httpx
    examples/servers/spica-playwright-server/tests/test_launch.py      65 lines   needs an editable install
    examples/servers/spica-playwright-server/tests/test_registry.py    81 lines   needs pytest
    examples/servers/spica-playwright-server/tests/test_service.py    122 lines   needs pytest

There is no `pytest` anywhere in this repository's tooling — not in `ci.yml`, not in `ci-local.mjs`, not in
`package.json`, not in a dev-dependency file. These are not suites that skip; they were never wired.

The first one is the more expensive. `clients/python` is a **published client** (`pyproject.toml`, name
`everdict`, `dependencies = []`) — it is what a user's `pip install everdict` gets, and its only test has
never been observed to pass or fail. A green test nobody runs and a red test nobody runs are the same
artifact, and this repository has a name for that state.

The cost of NOT deciding is not zero and it is not "the tests are stale". It is that four of the five look
like coverage: a reader who opens `clients/python/` sees a `tests/` directory and concludes the client is
tested. `pnpm python` now prints them as declared-unrunnable on every run, which stops the accounting error;
it does not run them.

## Proposed outcome

Each of the five is in one of two states, and the state is visible:

- **run** — the dependency is installed in `ci.yml` and in `pnpm ci:local`, and the suite is green. `ci:local`
  and `ci.yml` must agree, because a step in one and not the other is the gate drift skill `ci` warns about
  and it is how the Python step that already existed came to be unrunnable locally.
- **removed** — the suite is deleted, and the commit says what is no longer covered. A deliberate deletion is
  a decision somebody can argue with; an unwired suite is not.

"Left declared" is not a third state. `NEEDS` was written to record a gap until it is decided, not to hold it.

## Affected users and systems

- `clients/python` — the published client, and whoever `pip install everdict`s it.
- `examples/servers/spica-playwright-server` — an example server. Its three suites may well be the ones to
  delete rather than wire; that is the design pass's call, not this file's.
- `.github/workflows/ci.yml` and `scripts/ci-local.mjs` — both, together, or neither.
- Every contributor's machine, if the local half installs anything.

## Constraints

- **Do not install packages into a maintainer's system Python.** That is why this is an intent and not a
  commit: the gate that found this deliberately does not `pip install`, because installing packages is a
  decision about somebody's machine and about CI minutes, and a check that ran because a push happened does
  not get to make it.
- `pnpm ci:local` must stay runnable on a clean checkout without a manual setup step, or the push gate stops
  meaning what it says.
- Whatever lands, `NEEDS` in `scripts/check-python.mjs` loses the entries in the SAME change — an entry whose
  reason has outlived its subject reads as permission, which is the rule every other allowlist here follows.

## Open questions

1. Is `clients/python` still the shape it was when its test was written? The suite has never run, so nobody
   knows whether it is green, and "wire it" and "fix it" may be the same task or different ones.
2. Is a Python venv in CI worth ~20 seconds per run for one client suite, or does the client belong on its
   own workflow with its own trigger (it changes rarely, and `paths:` would make it nearly free)?
3. Does `spica-playwright-server` want tests at all? It is an example. An example whose tests are wired is a
   maintenance surface; an example whose tests are deleted is smaller and honest. Either is defensible and
   the current state is not.
4. Is a Python **linter** the same decision or a different one? `pnpm python` compiles and runs; it does not
   lint, because the linter needs a dependency and the compile step does not. If a dependency is being
   installed anyway, that argument changes.
