// SPDX-License-Identifier: AGPL-3.0-only
// Every email WatchLog's backend sends, with sample data (ADR-220), for looking at them:
//   pnpm --filter @watchlog/backend emails:preview            write and send to Mailpit
//   pnpm --filter @watchlog/backend emails:preview --no-send  only write the files
//   --out <dir>    where the files go (default: backend/tmp/emails, git-ignored)
// Each email is written as <name>.html and <name>.txt, with an index.html. Sending goes to
// a Mailpit on this machine only (WATCHLOG_PREVIEW_SMTP_URL, default smtp://127.0.0.1:1025):
// any other server is refused, and every recipient is preview+<name>@example.com, an address
// that can't be anyone's. Development only: nothing here is in the image.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { escapeHtml } from '@watchlog/email';
import { message, render } from '../src/lib/mail.js';
import { samples } from '../src/modules/emails/samples.js';

const args = process.argv.slice(2);
const send = !args.includes('--no-send');
const outAt = args.indexOf('--out');
const out = resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1]! : 'tmp/emails');
const smtpUrl = process.env.WATCHLOG_PREVIEW_SMTP_URL ?? 'smtp://127.0.0.1:1025';

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (send && !LOCAL.has(new URL(smtpUrl).hostname)) {
  console.error(
    `Refusing to send through ${new URL(smtpUrl).hostname}: only a Mailpit on this machine.`,
  );
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const list = samples();
const rows: string[] = [];
const transport = send ? nodemailer.createTransport(smtpUrl) : null;
for (const s of list) {
  const email = render(s.spec, s.edition);
  writeFileSync(join(out, `${s.name}.html`), email.html);
  writeFileSync(join(out, `${s.name}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
  rows.push(
    `<tr><td><a href="${s.name}.html">${escapeHtml(s.name)}</a> · <a href="${s.name}.txt">text</a></td><td>${escapeHtml(email.subject)}</td><td>${escapeHtml(s.from)}</td><td>${s.edition}</td><td>${Buffer.byteLength(email.html)}</td></tr>`,
  );
  if (transport) {
    await transport.sendMail(
      message(
        {
          to: `preview+${s.name}@example.com`,
          email,
          ...(s.unsubscribeUrl ? { unsubscribeUrl: s.unsubscribeUrl } : {}),
        },
        'WatchLog preview <preview@example.com>',
      ),
    );
  }
}
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>WatchLog emails</title><style>body{font:14px system-ui;margin:24px}td{padding:4px 10px;border-bottom:1px solid #ddd}</style><h1>Every email (${list.length})</h1><table><tr><th>Email</th><th>Subject</th><th>Sent by</th><th>Edition</th><th>HTML bytes</th></tr>${rows.join('')}</table>`,
);
transport?.close();
console.log(
  `${list.length} emails written to ${out}${send ? `, and sent to Mailpit at ${smtpUrl}` : ''}.`,
);
