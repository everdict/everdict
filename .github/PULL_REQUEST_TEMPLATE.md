## What & why

<!-- What does this PR change, and why? Conventional-Commit-scoped title, e.g. `fix(runner): …` -->

## Checklist

- [ ] `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass
      (`apps/web`: `pnpm -F @everdict/web lint && pnpm -F @everdict/web build`)
- [ ] `fix:` includes a regression test that fails on the pre-fix code
- [ ] Convention/invariant changes update the matching `.claude/` skill/rule in this PR
- [ ] Commits are signed off (DCO, `git commit -s`)
