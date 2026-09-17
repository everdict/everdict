---
description: Register the account your delegates run as, then hand an issue to one and supervise it.
argument-hint: "[issue identifier, or nothing to just register]"
---

Set this member up to delegate work to a sandboxed coding agent, and then do it. What they named:
`$ARGUMENTS`.

A delegate is a Claude Code (or Codex) running in a container with the repository cloned in and a brief
beside it. It runs as **an account you register once** — yours, not the workspace's — and it reports back
against criteria it was given. Everything below is one-time except the last section.

## 1. Is there already an identity?

```
list_capabilities { type: "cli-identity" }
```

A `cli-identity` whose `createdBy` is this member and whose `spec.cli` matches the CLI they will delegate to
is all they need — skip to §4. Two of them for one CLI is a refusal by design (nobody should guess which of
someone's accounts does the work), so if there are two, ask which one and delete the other with
`delete_capability`.

## 2. Get a headless token

⚠️ **This is the one step you cannot do for them.** `claude setup-token` needs a terminal — it opens a
browser round-trip — so ask the user to run it themselves. In Claude Code they can type it directly:

```
! claude setup-token
```

It prints a token starting `sk-ant-oat…`. Tell them to paste it back.

**Why a headless token rather than their live login.** The file at `~/.claude/.credentials.json` is the
session their own terminal is using; copying it into a container means one revocation, one expiry and one
rate limit shared between the two, and no way to tell afterwards which one did what. A `setup-token` token
is a second credential on the same subscription, and revoking it costs the member nothing.

**Codex** has no equivalent command: its credential IS a file (`~/.codex/auth.json`). Register that file's
contents as the secret and put it in the identity's `home` instead of `env` (§3).

## 3. Register it

⚠️ **The token goes into the SecretStore and nowhere else.** Never write it into a file you author, never
echo it back, never put it in the capability spec — the spec holds the secret's NAME.

```
set_secret { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "<what they pasted>", scope: "user" }

save_capability {
  id: "my-claude",
  name: "My Claude Code login",
  visibility: "private",
  spec: {
    type: "cli-identity",
    cli: "claude-code",
    env: { CLAUDE_CODE_OAUTH_TOKEN: { secretRef: "CLAUDE_CODE_OAUTH_TOKEN", scope: "user" } },
    home: []
  }
}
```

`visibility: "private"` is the point, not a default: a workspace-visible identity is something a caller
NAMES on purpose, never something that gets picked for somebody else's work.

**Settings files, if they want them.** `home` reproduces files under the container's `$HOME`. Worth
carrying: `~/.claude/settings.json` (model preference, permissions, hooks). ⚠️ NOT `~/.claude.json` — it is
hundreds of kilobytes of this machine's project history, conversation state and MCP OAuth tokens for
unrelated servers, and none of it means anything in a fresh container. Read the file before offering it and
say what is in it.

## 4. Check the lane is even available

If `create_sandbox` is not among your tools, delegation is off on this deployment and nothing above helps.
Tell the user to ask their operator to set `EVERDICT_SANDBOX_DRIVER` (and the per-agent cap
`EVERDICT_SANDBOX_MAX_PER_AGENT`, which defaults to 1). An absent tool reads exactly like an unbuilt
feature, which is why this check is written down.

A delegate also needs a **delegation profile** — WHO does the work (image, which agent, model, standing
instructions). `list_capabilities { type: "delegation" }`; if there is none, the member's operator or a
teammate registers one with `save_capability`.

## 5. Delegate the issue

Prefer naming the issue over typing a brief. The brief is then ASSEMBLED from the record — the description,
the commits already linked to it, the issues it points at, and what this workspace has learned — and the
parts a hand-typed brief drops first are exactly the ones nobody notices missing.

```
create_sandbox {
  profile: { id: "<the delegation profile>" },
  issue: "<identifier>",
  extra_checks: ["<anything you will check that the repo's own gates will not>"],
  repo: { git: "<the repository>", ref: "<branch>" },
  ttlSec: 3600
}
```

Then confirm what it was actually told, because a brief nobody read is the commonest way a delegation goes
wrong quietly:

```
sandbox_exec { id, command: "cat work/BRIEF.md" }
```

## 6. Supervise it

Hand over the work and watch:

- `submit_sandbox_task { id, task }` — starts a turn, or queues for the next boundary if it is busy. The
  answer says which (`delivered: "started" | "queued"`).
- `submit_sandbox_task { id, task, delivery: "message" }` — something it should know that does not deserve
  a derailment. Queues; starts nothing.
- `interrupt_sandbox_task { id, reason }` — it is solving the wrong problem. Stops the TURN and keeps the
  container, the working directory and the conversation; the delegate takes the next instruction
  immediately. This is not `close_sandbox`, which destroys all of it.
- `read_sandbox_task_trace { id, taskRunId }` — live while the turn runs.
- `get_sandbox { id }` — `live.delegate` says what it IS: `running` · `interrupted` · `completed` (with its
  report) · `errored` · `orphaned`.

## 7. Read the report, and record what it taught

A finished delegate writes `REPORT.json`; it arrives on `get_sandbox` as `live.delegate.report`. Read the
per-criterion answers, not just the summary — a report that skipped two of five criteria reads exactly like
one that met three.

⚠️ **The delegate does not record anything in Everdict, and that is deliberate.** It has no tool surface and
no credential here; a delegate that could close its own issue or settle its own campaign would be grading
its own exam. So the recording is YOURS: take its `learned` into a `create_knowledge_entry` naming the issue
and the repository, and decide yourself what its answers mean for the issue's status.

Close the session when you are done reviewing (`close_sandbox`) — a completed delegate stays alive and
addressable until you do, which is what lets you say "that is nearly right, now do this" without a new
container and a fresh clone.
