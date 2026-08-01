"""Launch arguments and extension identity — the parts that decide whether the extension loads at all."""

from __future__ import annotations

from pathlib import Path

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


def test_only_a_profile_owning_process_counts_as_a_browser() -> None:
    from spica_playwright_server.infrastructure.processes import _role_of

    main = ["chrome", "--user-data-dir=/tmp/profile-1", "--load-extension=/ext"]
    renderer = ["chrome", "--type=renderer", "--user-data-dir=/tmp/profile-1"]
    crashpad = ["chrome_crashpad_handler", "--monitor-self", "--database=/root/.config/chromium"]

    assert _role_of(main, "/tmp/profile-1") == "browser"
    assert _role_of(renderer, "/tmp/profile-1") == "renderer"
    # A crashpad handler owns no profile: counting it as a browser turns 3 sessions into 9 in the
    # process view, which is the one read an operator uses to trust the registry.
    assert _role_of(crashpad, None) == "helper"
