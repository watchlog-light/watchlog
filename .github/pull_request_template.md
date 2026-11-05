## What and why

<!-- What changes, and the problem it solves. Link the issue: Fixes #123 -->

## How it was tested

<!-- Tests added or run; for agent changes, the system the fixtures came from. -->

## Checklist

- [ ] Tests added or updated; `pnpm lint && pnpm test` and `make agent-lint agent-test` pass
- [ ] Conventional commit messages; UI and backend or agent changes in separate commits
- [ ] No colour literals or untranslated strings in `web/src`
- [ ] If the agent's access changed: `docs/security.md` updated
- [ ] Upgrades need no manual steps (`deploy/test/helm/upgrade-test.sh` passes for chart changes)
