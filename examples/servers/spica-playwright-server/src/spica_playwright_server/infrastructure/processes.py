"""OS-level process handling — the fallback for browsers that will not close, and the /debug view.

Closing the Playwright context is the normal path and usually enough. This module exists for the case it
is not: a hung renderer, a crashed supervisor, a context whose transport is already gone. Those leave a
Chrome tree holding a profile lock, and the slot never comes back without killing it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

import psutil

CHROME_NAMES = ("chrome", "chromium", "chromium-browser", "headless_shell")
# A Chrome tree is one browser process plus many --type= children (renderer, gpu, zygote, utility).
# Only the parent is worth targeting: killing its tree takes the rest with it.
CHILD_TYPE_FLAG = "--type="


def _cmdline(proc: psutil.Process) -> list[str]:
    try:
        return proc.cmdline() or []
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return []


def _is_chrome(proc: psutil.Process) -> bool:
    try:
        name = (proc.name() or "").lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False
    return any(candidate in name for candidate in CHROME_NAMES)


def find_browser_processes(user_data_dir: Path) -> list[psutil.Process]:
    """Every Chrome process launched against this profile, main process first."""
    marker = f"--user-data-dir={user_data_dir}"
    found: list[psutil.Process] = []
    for proc in psutil.process_iter(["pid", "name"]):
        if not _is_chrome(proc):
            continue
        argv = _cmdline(proc)
        if not any(arg == marker or arg.startswith(f"{marker}/") for arg in argv):
            continue
        found.append(proc)
    # The main process is the one without a --type= role.
    found.sort(key=lambda p: any(arg.startswith(CHILD_TYPE_FLAG) for arg in _cmdline(p)))
    return found


def kill_tree(proc: psutil.Process, timeout: float = 5.0) -> int:
    """Terminate a process and everything under it, escalating to SIGKILL for whatever survives.
    Returns how many processes were actually reaped."""
    try:
        targets = [*proc.children(recursive=True), proc]
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0
    for target in targets:
        try:
            target.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    gone, alive = psutil.wait_procs(targets, timeout=timeout)
    for target in alive:
        try:
            target.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    reaped, _ = psutil.wait_procs(alive, timeout=timeout)
    return len(gone) + len(reaped)


def kill_profile_browsers(user_data_dir: Path, timeout: float = 5.0) -> int:
    killed = 0
    for proc in find_browser_processes(user_data_dir):
        killed += kill_tree(proc, timeout=timeout)
    return killed


def _role_of(argv: list[str], profile: Optional[str]) -> str:
    """What a process actually is. Owning a profile is what makes a process THE browser — going by
    "has no --type= flag" instead counts every crashpad handler as another browser, which is the exact
    miscount this endpoint exists to prevent."""
    typed = next((arg.split("=", 1)[1] for arg in argv if arg.startswith(CHILD_TYPE_FLAG)), None)
    if typed:
        return typed
    return "browser" if profile else "helper"


def describe_processes(session_dirs: Optional[dict[str, Path]] = None) -> list[dict[str, object]]:
    """A snapshot of the container's browser processes for /debug/processes, each attributed to the
    session whose profile it holds — the read that answers 'what is still alive in here'."""
    by_dir = {str(path): session_id for session_id, path in (session_dirs or {}).items()}
    rows: list[dict[str, object]] = []
    for proc in psutil.process_iter(["pid", "ppid", "name", "create_time"]):
        if not _is_chrome(proc):
            continue
        argv = _cmdline(proc)
        profile = next((arg.split("=", 1)[1] for arg in argv if arg.startswith("--user-data-dir=")), None)
        role = _role_of(argv, profile)
        try:
            rss = proc.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            rss = 0
        rows.append(
            {
                "pid": proc.info.get("pid"),
                "ppid": proc.info.get("ppid"),
                "name": proc.info.get("name"),
                "role": role,
                "user_data_dir": profile,
                "session_id": by_dir.get(profile or ""),
                "rss_bytes": rss,
                "started_at": proc.info.get("create_time"),
            }
        )
    rows.sort(key=lambda row: (str(row.get("user_data_dir") or ""), row.get("role") != "browser"))
    return rows


def orphan_profiles(known: Iterable[Path], root: Path) -> list[Path]:
    """Profile directories under the root that no live session claims — what a restart leaves behind."""
    known_set = {str(path) for path in known}
    if not root.exists():
        return []
    return [child for child in sorted(root.iterdir()) if child.is_dir() and str(child) not in known_set]
