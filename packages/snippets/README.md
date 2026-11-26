# @watchlog/snippets

The commands and code a user copies to send their own metrics to WatchLog (Your metrics →
Add a source, 1.0.3). One source for all of them, so the page, the docs and the tests can't
drift apart:

- the dashboard's Add a source page fills them with the installation's address, the token
  just made and the chosen server or workload;
- `scripts/docs-snippets.mjs` writes them into `docs/site/your-metrics.md` between its
  `<!-- snippet:… -->` markers (`pnpm docs:snippets`; a test fails when the docs are stale);
- `backend/test/own-push-snippets.test.ts` runs each push snippet against a real backend,
  where its runtime is installed.

Plain JavaScript with types beside it, like `@watchlog/cause-words`: nothing to build.
