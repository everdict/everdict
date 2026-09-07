# `releases/` — the authorization a tag needs before it leaves

Pushing `cli-v*`, `desktop-v*`, `api-v*`, `web-v*`, `agent-v*`, `job-runner-v*` or `v*` publishes binaries and
images to the public. It is the one act in this repository with no undo, and before this directory it was the
least gated thing in the tree: nothing was required first — no record of what was shipping, no statement of
what verified it, no moment where a person authorized rather than typed.

`scripts/hooks/pre-push-gate.mjs` refuses a push whose HEAD carries a release tag with no `releases/<tag>.md`
**committed**. Committed, not merely written: an authorization that lives only in a working tree did not
travel with the tag it authorizes.

## The shape

`releases/TEMPLATE.md`. It names the tag, the commit, and the gate results — things that are checkable —
rather than a judgement. A record that says "looks good" settles nothing, and a false one should be a false
statement about facts rather than an opinion someone can defend.

## Writing one

```sh
cp releases/TEMPLATE.md releases/api-v1.4.0.md
# fill it in, commit it, then tag and push
```

The tag is created after the authorization is committed, so the authorization is part of what the tag points
at. Doing it the other way round produces a tag whose authorization is a later commit, which is a record of
having asked afterwards.

## What this is not

Not a changelog — `git log` is the changelog. This records the *decision to ship*: what was verified, by
which run, and who accepted the risk of publishing it.
