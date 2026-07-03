# Assay GitHub Action — CI-fired evals

Reference implementation of the `assay run-eval` action (design:
[`docs/architecture/github-actions-trigger.md`](../../docs/architecture/github-actions-trigger.md)).
Zero-dependency node20 action — copy `run-eval/` into your repo (or reference it once published)
and wire the workflow below.

Two firing semantics, picked automatically from the GitHub event:

| event | what happens |
|---|---|
| `pull_request` | evaluate the topology with **this build's image swapped in** via submit-time ephemeral pins (registry untouched; recorded in `origin.pinOverrides`), then diff vs the dev-channel baseline and **fail the check on regression** |
| `push` (dev/main) | `POST /harnesses/:id/pins` re-pins the changed slot(s) to this build's digest → **new immutable instance version** (the dev channel advances), then evaluates it — this becomes the next baseline |

## Example workflow

```yaml
name: assay-eval
on:
  pull_request:
  push:
    branches: [dev, main]

permissions:
  contents: read
  id-token: write   # GitHub OIDC federation (keyless) — omit when using an API key secret

concurrency:
  group: assay-eval-${{ github.ref }}
  cancel-in-progress: true

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build & push image
        id: build
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}

      - name: Assay eval
        uses: ./.github/actions/assay-run-eval   # or assay-ai/run-eval@v1 once published
        with:
          api-url: https://assay.example.com
          workspace: acme
          api-key: ${{ secrets.ASSAY_API_KEY }}  # omit when the workspace has a repo link (OIDC)
          harness: my-topology
          dataset: pinch-bench
          images: '{"svc-x":"ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}"}'
          runtime: self:office-mac               # optional — run on a workspace self-hosted runner
```

Monorepo: build only the services whose paths changed (e.g. `dorny/paths-filter`), then pass all
built images in one `images` map — push mode re-pins them in **one** call, producing exactly one
new version.

## Auth

- **API key** (`ak_…`, works today): store as a repo secret; the key's workspace must match `workspace`.
- **GitHub OIDC (keyless)**: give the job `id-token: write`; the action exchanges the GitHub-signed
  token (aud `assay`) directly. Requires the workspace to trust this repository via a repo link
  (`WorkspaceSettings.ci.links`).

## Notes

- Pin by **digest** (`@sha256:…`) — the re-pin route rejects moving tags by default (`allowTags` opt-out).
- `origin` (repo/sha/ref/PR/run URL) is stamped on the scorecard by the control plane; the PR comment /
  check feedback is done here with the ambient `GITHUB_TOKEN` — Assay holds no GitHub credential.
- Private GHCR images need pull credentials on the topology runtime (Track B; interim: cluster pull secret).
