"""Launch arguments and extension identity — the parts that decide whether the extension loads at all."""

from __future__ import annotations

import sys
from pathlib import Path

# Executed as a script by `pnpm python`, not collected by a runner that would have arranged the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from spica_playwright_server.infrastructure.browser_launcher import (
    OFFSCREEN_POSITION,
    LaunchSpec,
    chromium_args,
)
from spica_playwright_server.infrastructure.extension import unpacked_extension_id



def spec(**overrides) -> LaunchSpec:
    base = {
        "user_data_dir": Path("/tmp/profile-1"),
        "extension_path": Path("/ext"),
        "visible": False,
        "cdp_port": None,
    }
    base.update(overrides)
    return LaunchSpec(**base)  # type: ignore[arg-type]


def test_the_extension_is_both_loaded_and_the_only_one_allowed() -> None:
    args = chromium_args(spec())
    # Chrome refuses unpacked extensions unless they are also the only ones permitted, so shipping just
    # --load-extension silently produces a browser without the extension.
    assert "--load-extension=/ext" in args
    assert "--disable-extensions-except=/ext" in args


def test_the_debugging_port_appears_only_when_one_was_allocated() -> None:
    assert not any(arg.startswith("--remote-debugging-port") for arg in chromium_args(spec()))
    assert "--remote-debugging-port=9311" in chromium_args(spec(cdp_port=9311))


def test_windows_are_moved_off_screen_unless_the_operator_asked_to_see_them() -> None:
    assert OFFSCREEN_POSITION in chromium_args(spec())
    assert OFFSCREEN_POSITION not in chromium_args(spec(visible=True))


def test_the_derived_extension_id_is_a_stable_32_char_id_in_chromes_alphabet() -> None:
    derived = unpacked_extension_id(Path("/ext"))
    assert len(derived) == 32
    assert set(derived) <= set("abcdefghijklmnop")
    assert derived == unpacked_extension_id(Path("/ext"))  # stable for the same path
    # Path-derived, so a different mount point is a different id — which is exactly why the service
    # worker's own URL is preferred over this fallback.
    assert derived != unpacked_extension_id(Path("/srv/ext"))



if __name__ == "__main__":
    # Collect and run every test in this module. A failure exits non-zero, which is what `pnpm python`
    # reads; names are printed so a red run says WHICH claim broke.
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
