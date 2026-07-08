#!/usr/bin/env python3
"""Prebuild + push task images for the standard-format on-ramp, and emit an import manifest.

Everdict REFERENCES images, it never builds them (case.image is the portability contract). Terminal-Bench and
Harbor tasks ship a Dockerfile that is built locally at run time; a MANAGED run needs those images prebuilt and
pushed to a registry the runtime can pull (your workspace image registry). This helper walks a task set, builds +
tags + (optionally) pushes each task image, and writes a JSON manifest ready for the import endpoint:

    POST /datasets/terminal-bench   (or /datasets/harbor)   — body: {dataset, tasks, imageTemplate?}
    # or MCP import_terminal_bench / import_harbor, or the SDK.

Layouts (per the format docs, docs/architecture/standard-task-formats.md):
  terminal-bench:  <tasks-dir>/<id>/task.yaml           + Dockerfile              + tests/
  harbor:          <tasks-dir>/<id>/instruction.md      + environment/Dockerfile  + tests/ + task.toml

Requires Docker on PATH (and registry auth for --push). Stdlib only. NOTE: this is an example — it is not run in
CI (no Docker/registry here); `python3 -m py_compile` validates it.

Usage:
  python3 build_task_images.py --format harbor --tasks-dir ./tasks \\
      --image-template ghcr.io/acme/harbor/{id}:v1 --push --manifest tasks.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib  # stdlib (3.11+)
from pathlib import Path


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), file=sys.stderr)
    subprocess.run(cmd, check=True)


def _harbor_task(task_dir: Path) -> tuple[str, dict]:
    """(dockerfile_path, task_row) for a Harbor task dir: instruction.md + task.toml + environment/Dockerfile."""
    instruction = (task_dir / "instruction.md").read_text(encoding="utf-8").strip()
    meta: dict = {}
    toml_path = task_dir / "task.toml"
    if toml_path.exists():
        with toml_path.open("rb") as f:
            meta = tomllib.load(f)
    m = meta.get("metadata", {})
    row = {"id": task_dir.name, "instruction": instruction}
    if isinstance(m.get("difficulty"), str):
        row["difficulty"] = m["difficulty"]
    if isinstance(m.get("tags"), list):
        row["tags"] = [str(t) for t in m["tags"]]
    agent = meta.get("agent", {})
    if isinstance(agent.get("timeout_sec"), (int, float)):
        row["timeoutSec"] = int(agent["timeout_sec"])
    return str(task_dir / "environment" / "Dockerfile"), row


def _terminal_bench_task(task_dir: Path) -> tuple[str, dict]:
    """(dockerfile_path, task_row) for a Terminal-Bench task dir: task.yaml + Dockerfile. Instruction via a light
    task.yaml read (pyyaml if present, else the `instruction:` line) — full YAML parsing is out of scope here."""
    instruction = ""
    yaml_path = task_dir / "task.yaml"
    text = yaml_path.read_text(encoding="utf-8") if yaml_path.exists() else ""
    try:
        import yaml  # optional

        instruction = str((yaml.safe_load(text) or {}).get("instruction", "")).strip()
    except ImportError:
        for line in text.splitlines():
            if line.startswith("instruction:"):
                instruction = line.split(":", 1)[1].strip().strip("\"'")
                break
    row = {"id": task_dir.name, "instruction": instruction}
    return str(task_dir / "Dockerfile"), row


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--format", choices=["terminal-bench", "harbor"], required=True)
    ap.add_argument("--tasks-dir", required=True, help="directory whose subdirectories are tasks")
    ap.add_argument("--image-template", required=True, help="e.g. ghcr.io/acme/tb/{id}:v1  ('{id}' is the task dir name)")
    ap.add_argument("--push", action="store_true", help="docker push each built image (needs registry auth)")
    ap.add_argument("--manifest", help="write the import manifest (JSON task array) here")
    args = ap.parse_args()

    if "{id}" not in args.image_template:
        ap.error("--image-template must contain '{id}'")

    parse = _harbor_task if args.format == "harbor" else _terminal_bench_task
    tasks_dir = Path(args.tasks_dir)
    rows: list[dict] = []
    for task_dir in sorted(p for p in tasks_dir.iterdir() if p.is_dir()):
        dockerfile, row = parse(task_dir)
        if not Path(dockerfile).exists():
            print(f"skip {task_dir.name}: no Dockerfile at {dockerfile}", file=sys.stderr)
            continue
        image = args.image_template.replace("{id}", task_dir.name)
        _run(["docker", "build", "-t", image, "-f", dockerfile, str(Path(dockerfile).parent)])
        if args.push:
            _run(["docker", "push", image])
        row["image"] = image
        rows.append(row)

    manifest = {"dataset": {"id": tasks_dir.name, "version": "1.0.0"}, "tasks": rows}
    out = json.dumps(manifest, indent=2)
    if args.manifest:
        Path(args.manifest).write_text(out + "\n", encoding="utf-8")
        print(f"wrote {len(rows)} task(s) → {args.manifest}", file=sys.stderr)
    else:
        print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
