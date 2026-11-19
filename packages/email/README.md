# @watchlog/email

The one template every WatchLog email is drawn with (ADR-220): account emails, invites, alerts,
the notices, the lifecycle emails, and the operator's own mail.

- `index.js`: `renderEmail(spec)` gives the subject (cleaned for the header), the HTML and a
  written plain-text part from the same parts: the coloured strip by kind, the header with the
  logo and the org or cluster, a title and one or two sentences, then the blocks a message needs
  (a code, a preformatted check output, a facts table, the "Likely cause" box, a second neutral
  box, a list, one button and its plain link, notes) and the footer that says why the reader got
  it and where to change it. Also `escapeHtml`, `headerText` and `safeUrl`.
- `index.d.ts`: the spec's types.

Built for real mail clients: tables and inline CSS, 600 px wide and readable at 320 px, system
fonts, no script, no web font, no external stylesheet and no remote image (the logo is drawn in
HTML), light by default with a dark variant (`prefers-color-scheme`, Outlook.com's
`[data-ogsc]`), a hidden preheader, `lang`, `role="presentation"` on layout tables, 4.5:1
contrast and a 44 px button. Every value is escaped here: callers pass plain text.

Plain JavaScript without dependencies, so the backend image runs it without a build step.
`backend/test/emails.test.ts` snapshots every email the backend sends (HTML and text) and checks
the rules above; `pnpm --filter @watchlog/backend emails:preview` writes them all to a folder and
sends them to a Mailpit on this machine.
