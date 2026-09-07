"""Which chrome processes count as a browser — the one launch claim that needs a third-party module.

⚠️ SEPARATE FROM `test_launch.py` ON PURPOSE, and the separation is the accounting. `pnpm python` runs a test
file by executing it, and `spica_playwright_server.infrastructure.processes` imports `psutil` — a real
dependency this example server declares and this repository does not install. Left inside `test_launch.py`,
one missing module made all five of that file's claims unrunnable, which is exactly the state the whole
"suites nobody ran" intent is about: four tests that need nothing, not run, because a fifth needs something.

So the file is named for the dependency it carries, and `NEEDS` in `scripts/check-python.mjs` declares it with
that module by name. Wiring it means installing the example server's declared dependencies, which is a
decision about CI minutes and about somebody's machine — and a gate does not get to make it.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Executed as a script by `pnpm python`, not collected by a runner that would have arranged the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from spica_playwright_server.infrastructure.processes import _role_of  # noqa: E402

def test_only_a_profile_owning_process_counts_as_a_browser() -> None:
    main = ["chrome", "--user-data-dir=/tmp/profile-1", "--load-extension=/ext"]
    renderer = ["chrome", "--type=renderer", "--user-data-dir=/tmp/profile-1"]
    crashpad = ["chrome_crashpad_handler", "--monitor-self", "--database=/root/.config/chromium"]

    assert _role_of(main, "/tmp/profile-1") == "browser"
    assert _role_of(renderer, "/tmp/profile-1") == "renderer"
    # A crashpad handler owns no profile: counting it as a browser turns 3 sessions into 9 in the
    # process view, which is the one read an operator uses to trust the registry.
    assert _role_of(crashpad, None) == "helper"

if __name__ == "__main__":
    failures = 0
    for _name, _fn in sorted(dict(globals()).items()):
        if not _name.startswith("test_") or not callable(_fn):
            continue
        try:
            _fn()
            print(f"  ok   {_name}")
        except Exception as _err:  # noqa: BLE001 — a test runner reports, it does not re-raise
            failures += 1
            print(f"  FAIL {_name}: {type(_err).__name__}: {_err}")
    _ran = sum(1 for _n, _f in globals().items() if _n.startswith("test_") and callable(_f))
    print(f"{'FAIL' if failures else 'PASS'} {Path(__file__).name}: {_ran} test(s), {failures} failure(s)")
    sys.exit(1 if failures else 0)
