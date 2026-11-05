# WatchLog v2 — rules for Claude Code

- Source of truth: docs/SPEC.md. Read it and the last 3 entries of the session log (HISTORY.md in
  the private notes repository; the workspace CLAUDE.md says where) at session start.
- This is the open-source product repository; see "What belongs here" below before committing.
- Work only on the current phase (the phase checklists in the notes repository). Do not build P1/P2 items early.
- Non-goals in SPEC §2.5 are hard limits. If a task seems to need one, stop and ask.
- Measure before changing: inspect real data (API responses, metrics, DB rows) before
  changing query or ingest code. Never infer data shapes from code alone.
- Keep UI changes and backend/agent changes in separate commits so each can be reverted alone.
- Every controller returns a response on every path (no swallowed errors without a reply).
- Upgrades never need manual steps (ADR-107): a change that would need one ships an automatic
  migration. New Helm values are read nil-safe; deploy/test/helm/upgrade-test.sh must pass.
- Agent: respect the budgets in SPEC §6.1; add a benchmark when touching collectors.
- Security: the agent must never read Secrets, ConfigMap data or env values.
- All colours come from design tokens; no hex values in components.
- English for code, comments, commits and docs. UI strings via i18n (en).
- At session end: append to HISTORY.md, tick the phase checklist and update pending-review.md in
  the notes repository; record any decision in docs/DECISIONS.md here.
- Conventional commits (feat:, fix:, chore:, docs:, refactor:, test:).

## What belongs here

- The product: agent, backend, web, multi-tenancy, signup, onboarding, funnel, plan limits, the
  Cloud base compose (`deploy/cloud/`). Self-hosted users run the same code as Cloud, so anything
  the product needs lives here.
- The user docs (`docs/site/*.md`), the README screenshots (`docs/images/`) and the design tokens
  stay here and public. The marketing site that renders them is in a private repository and
  reads them at a pinned commit (ADR-114). Renaming or moving those files breaks the site's build,
  so mention it in the commit message.
- Not here: internal notes, the marketing site, Cloud-only code (billing, production
  configuration, Cloud operations) and the pre-launch history. They live in private repositories
  next to this one; the workspace CLAUDE.md maps them. Commit each change to the repository it
  belongs to; a change that spans repositories gets one commit per repository, with matching
  messages.
- This repository is public at launch. `pnpm check:private` (and CI) fails if it tracks private
  folders, marketing site code, local settings or databases, or if any file names the private
  repositories, the workspace's folders, a personal email address or an absolute home path.

## Repo quick reference

- Decisions: docs/DECISIONS.md (ADR-001…). Do not change an accepted ADR's decision; add a new ADR.
- Commands: `pnpm dev` (backend :4080 + web :4088, `WATCHLOG_WEB_PORT`), `pnpm infra:up` / `pnpm infra:down`,
  `pnpm lint`, `pnpm test`, `pnpm format:check`, `pnpm check:license`, `pnpm check:private`, `make agent`,
  `make agent-test`, `make agent-lint`, `make images` (build only, never push).
- Every source file starts with `SPDX-License-Identifier: AGPL-3.0-only` (ee/: `LicenseRef-WatchLog-Enterprise`).
- Colours: only in packages/design-tokens/tokens.css; Tailwind utilities map to them (theme.css).
  web/test/design-tokens-guard.test.ts fails on colour literals in web/src.
- gcr.io is blocked from the owner's network (HTTP 403): the agent image is FROM scratch (ADR-020); build
  backend locally with `BACKEND_RUNTIME_IMAGE=node:24-bookworm-slim`.
- CI runs on push to main except docs-only changes; the acceptance job is manual only (ADR-044).
- No image is pushed to any registry before the Phase 4 launch; kind tests use `kind load` (ADR-043).
- pnpm enforces a minimum release age; never add `minimumReleaseAgeExclude` entries without asking.
