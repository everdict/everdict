# Standard task-format image provenance

Everdict **references** container images (`case.image`), it never builds them — so running a Terminal-Bench or
Harbor task set *managed* needs each task's image **prebuilt and pushed** to a registry your runtime can pull
(your [workspace image registry](../../docs/architecture/workspace-image-registry.md)). `build_task_images.py`
walks a task set, builds + tags + (optionally) pushes each task image, and emits an import manifest.

```sh
# Harbor: build every task image, push, and write a manifest ready for the import endpoint.
python3 build_task_images.py --format harbor \
  --tasks-dir ./harbor-tasks \
  --image-template ghcr.io/acme/harbor/{id}:v1 \
  --push --manifest tasks.json

# Terminal-Bench is analogous:
python3 build_task_images.py --format terminal-bench --tasks-dir ./tasks \
  --image-template ghcr.io/acme/tb/{id}:v1 --push --manifest tasks.json
```

Then register the task set as a dataset (the images are referenced, not rebuilt):

```sh
curl -X POST "$EVERDICT/datasets/harbor" -H "authorization: Bearer $EVERDICT_API_KEY" \
  -H 'content-type: application/json' -d @tasks.json
# or: MCP import_harbor / import_terminal_bench, or the SDK.
```

**Requirements:** Docker on PATH (+ registry auth for `--push`); Python 3.11+ (stdlib `tomllib`). Terminal-Bench's
`task.yaml` uses YAML — `pyyaml` is used if installed, else a minimal `instruction:` read.

> This is an **example** — it is not run in CI (no Docker/registry there). It is validated with
> `python3 -m py_compile`. See `docs/architecture/standard-task-formats.md`.
