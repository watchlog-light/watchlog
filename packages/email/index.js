// SPDX-License-Identifier: AGPL-3.0-only
// The one template every WatchLog email is drawn with (ADR-220): account mail, invites,
// alerts, billing, lifecycle and the operator's own notices. Plain JavaScript without
// dependencies, so the backend's image runs it as it is and other services can carry a copy.
//
// Built for real mail clients:
//   - tables and inline CSS, 600 px wide and readable at 320 px, system fonts only;
//   - no script, no web font, no external stylesheet, no remote image: the logo is drawn in
//     HTML (self-hosted installs may have no internet, and nothing may track a reader);
//   - light by default, a dark variant through color-scheme and prefers-color-scheme (and
//     Outlook.com's [data-ogsc]); colours chosen so a client that inverts them stays readable;
//   - a hidden preheader, lang, role="presentation" on layout tables, 4.5:1 contrast,
//     a 44 px button;
//   - a plain-text part written from the same parts, not stripped from the HTML.
// Every value is escaped here: the callers pass plain text, never HTML.

/** Gmail clips a message whose HTML is larger than about 102 KB. */
export const MAX_HTML_BYTES = 100_000;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** The strip at the top and the badge, by kind. */
const KINDS = {
  account: { strip: '#22c55e', badgeBg: '#dcfce7', badgeFg: '#166534' },
  resolved: { strip: '#22c55e', badgeBg: '#dcfce7', badgeFg: '#166534' },
  critical: { strip: '#dc2626', badgeBg: '#fee2e2', badgeFg: '#991b1b' },
  warning: { strip: '#d97706', badgeBg: '#fef3c7', badgeFg: '#92400e' },
  billing: { strip: '#d97706', badgeBg: '#fef3c7', badgeFg: '#92400e' },
  info: { strip: '#2563eb', badgeBg: '#dbeafe', badgeFg: '#1e40af' },
};

const C = {
  page: '#f3f4f6',
  card: '#ffffff',
  border: '#e5e7eb',
  rule: '#f0f1f3',
  title: '#111827',
  body: '#374151',
  muted: '#4b5563',
  footer: '#f9fafb',
  link: '#15803d',
  button: '#15803d',
  codeBg: '#f3f4f6',
  causeBg: '#f0fdf4',
  causeBorder: '#bbf7d0',
  causeBar: '#16a34a',
};

/** HTML-escapes text for an element or an attribute. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A value for a mail header (a subject, a name): no line breaks or other control characters,
 * spaces collapsed, at most `max` characters. A name from a user or a monitored system can't
 * add a header or end the headers.
 */
export function headerText(s, max = 200) {
  const one = String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** One line of body text: control characters out (a name may hold any), spaces kept. */
function line(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ');
}

/** An http(s) address for a link, or null: never javascript:, data: or anything else. */
export function safeUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return null;
  try {
    const url = new URL(u.trim());
    // The address as given (no port or path rewritten), once it is known to be http(s).
    return url.protocol === 'https:' || url.protocol === 'http:' ? u.trim() : null;
  } catch {
    return null;
  }
}

const esc = (s) => escapeHtml(line(s));

// ------------------------------------------------------------------------------ HTML

function badge(kind, text) {
  const k = KINDS[kind];
  return `<tr><td style="padding:0 0 12px"><span class="wl-badge-${kind}" style="display:inline-block;font:700 12px/16px ${FONT};letter-spacing:0.06em;text-transform:uppercase;padding:4px 10px;border-radius:6px;background:${k.badgeBg};color:${k.badgeFg}">${esc(text)}</span></td></tr>`;
}

function para(text, size = 16, color = C.body, cls = 'wl-body', top = 12) {
  return `<tr><td class="${cls}" style="padding:${top}px 0 0;font:${size}px/1.6 ${FONT};color:${color}">${esc(text)}</td></tr>`;
}

function codeBlock(code) {
  return `<tr><td style="padding:20px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="wl-code" align="center" style="background:${C.codeBg};border:1px solid ${C.border};border-radius:10px;padding:18px">
<div class="wl-title" style="font:600 34px/1.2 ${MONO};letter-spacing:0.22em;color:${C.title}">${esc(code.value)}</div>${
    code.note
      ? `<div class="wl-muted" style="font:13px/1.5 ${FONT};color:${C.muted};padding-top:6px">${esc(code.note)}</div>`
      : ''
  }</td></tr></table></td></tr>`;
}

function preBlock(text) {
  return `<tr><td style="padding:16px 0 0"><div class="wl-code wl-title" style="background:${C.codeBg};border:1px solid ${C.border};border-radius:10px;padding:14px 16px;font:13px/1.5 ${MONO};color:${C.title};white-space:pre-wrap;word-break:break-word">${esc(text)}</div></td></tr>`;
}

function factsBlock(facts) {
  const rows = facts
    .map(
      (f, i) =>
        `<tr><th scope="row" class="wl-k wl-muted wl-line" style="width:120px;padding:11px 12px 11px 16px;text-align:left;vertical-align:top;font:400 14px/1.5 ${FONT};color:${C.muted};${i < facts.length - 1 ? `border-bottom:1px solid ${C.rule}` : ''}">${esc(f.label)}</th><td class="wl-v wl-title wl-line" style="padding:11px 16px 11px 0;vertical-align:top;font:500 14px/1.5 ${FONT};color:${C.title};word-break:break-word;${i < facts.length - 1 ? `border-bottom:1px solid ${C.rule}` : ''}">${esc(f.value)}</td></tr>`,
    )
    .join('');
  return `<tr><td style="padding:20px 0 0"><table width="100%" cellpadding="0" cellspacing="0" border="0" class="wl-box" style="border:1px solid ${C.border};border-radius:10px;border-collapse:separate">${rows}</table></td></tr>`;
}

function causeBlock(c, tone) {
  const green = tone === 'cause';
  const bg = green ? C.causeBg : C.footer;
  const border = green ? C.causeBorder : C.border;
  const bar = green ? C.causeBar : '#9ca3af';
  const label = green ? C.link : C.muted;
  const cls = green ? 'wl-cause' : 'wl-aside';
  return `<tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="${cls}" style="background:${bg};border:1px solid ${border};border-radius:10px;border-collapse:separate"><tr><td width="3" style="width:3px;padding:14px 0 14px 16px"><div class="${cls}-bar" style="width:3px;height:100%;min-height:40px;border-radius:2px;background:${bar}"></div></td><td style="padding:14px 16px 14px 14px">
<div class="${cls}-label" style="font:700 11px/1.4 ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${label}">${esc(c.label)}</div>
<div class="wl-title" style="padding-top:4px;font:15px/1.55 ${FONT};color:${C.title}">${esc(c.text)}</div></td></tr></table></td></tr>`;
}

function listBlock(list) {
  const tag = list.ordered ? 'ol' : 'ul';
  const items = list.items
    .map((it) => `<li style="margin:0 0 6px;padding-left:4px">${esc(it)}</li>`)
    .join('');
  return `<tr><td class="wl-body" style="padding:12px 0 0;font:16px/1.6 ${FONT};color:${C.body}"><${tag} style="margin:0;padding-left:22px">${items}</${tag}></td></tr>`;
}

function buttonBlock(b, url) {
  return `<tr><td style="padding:24px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="wl-btn" style="border-radius:9px;background:${C.button}"><a href="${escapeHtml(url)}" class="wl-btn-a" style="display:inline-block;padding:12px 24px;font:600 16px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:9px">${esc(b.label)}</a></td></tr></table></td></tr>`;
}

const DARK = `
.wl-page{background:#0b0d10!important}
.wl-card{background:#15181c!important;border-color:#2a2e34!important}
.wl-title{color:#e8eaed!important}
.wl-body{color:#c9cdd2!important}
.wl-muted{color:#a8aeb5!important}
.wl-line{border-color:#22262b!important}
.wl-box{border-color:#2a2e34!important}
.wl-code{background:#1d2126!important;border-color:#2a2e34!important}
.wl-foot{background:#111317!important;border-color:#2a2e34!important;color:#a8aeb5!important}
.wl-link,.wl-foot a{color:#4ade80!important}
.wl-cause{background:#0f2417!important;border-color:#1f4d2e!important}
.wl-cause-label{color:#4ade80!important}
.wl-aside{background:#1a1d21!important;border-color:#2a2e34!important}
.wl-aside-label{color:#a8aeb5!important}
.wl-badge-critical{background:#3b1212!important;color:#fca5a5!important}
.wl-badge-warning,.wl-badge-billing{background:#3a2a0b!important;color:#fcd34d!important}
.wl-badge-account,.wl-badge-resolved{background:#0f2a18!important;color:#86efac!important}
.wl-badge-info{background:#14213d!important;color:#93c5fd!important}`;

/** The dark rules for prefers-color-scheme and for Outlook.com's own dark mode. */
function darkCss() {
  const rules = DARK.trim().split('\n');
  const ogsc = rules.map((r) => r.replace(/(^|,)\./g, '$1[data-ogsc] .')).join('\n');
  return `@media (prefers-color-scheme:dark){\n${rules.join('\n')}\n}\n${ogsc}`;
}

function html(spec) {
  const k = KINDS[spec.kind] ?? KINDS.info;
  const brand = spec.edition === 'cloud' ? 'WatchLog Cloud' : 'WatchLog';
  const rows = [];
  if (spec.badge) rows.push(badge(spec.kind, spec.badge));
  rows.push(
    `<tr><td><h1 class="wl-title wl-h1" style="margin:0;font:700 24px/1.3 ${FONT};letter-spacing:-0.01em;color:${C.title}">${esc(spec.title)}</h1></td></tr>`,
  );
  (spec.intro ?? []).forEach((p) => rows.push(para(p)));
  if (spec.code) rows.push(codeBlock(spec.code));
  if (spec.pre) rows.push(preBlock(spec.pre));
  if (spec.facts?.length) rows.push(factsBlock(spec.facts));
  if (spec.cause) rows.push(causeBlock(spec.cause, 'cause'));
  if (spec.aside) rows.push(causeBlock(spec.aside, 'aside'));
  if (spec.list?.items?.length) rows.push(listBlock(spec.list));
  (spec.after ?? []).forEach((p) => rows.push(para(p)));
  const url = spec.button ? safeUrl(spec.button.url) : null;
  if (spec.button && url) rows.push(buttonBlock(spec.button, url));
  (spec.note ?? []).forEach((p, i) =>
    rows.push(para(p, 13, C.muted, 'wl-muted', i === 0 ? (url ? 16 : 20) : 8)),
  );
  if (spec.button && url) {
    rows.push(
      `<tr><td class="wl-muted" style="padding:8px 0 0;font:12px/1.6 ${FONT};color:${C.muted};word-break:break-all">Button not working? Copy this link: <a href="${escapeHtml(url)}" class="wl-link" style="color:${C.link}">${escapeHtml(url)}</a></td></tr>`,
    );
  }
  if (spec.signature) rows.push(para(spec.signature, 16, C.body, 'wl-body', 20));

  const footer = [esc(spec.footer.why)];
  if (spec.footer.manage) footer.push(esc(spec.footer.manage));
  const unsub = spec.footer.unsubscribeUrl ? safeUrl(spec.footer.unsubscribeUrl) : null;
  if (unsub) {
    footer.push(
      `<a href="${escapeHtml(unsub)}" style="color:${C.link}">Unsubscribe from these emails</a>`,
    );
  }
  footer.push(
    `${brand} · open-source monitoring for Kubernetes, Docker and Linux servers · <a href="https://watchlog.io" style="color:${C.link}">watchlog.io</a>`,
  );

  const header = spec.header
    ? `<td align="right" class="wl-muted" style="font:12px/30px ${FONT};color:${C.muted}">${esc(spec.header)}</td>`
    : '';
  // The preheader: the inbox's preview line. The padding after it keeps the body's first
  // words out of the preview.
  const pad = '&#847;&zwnj;&nbsp;'.repeat(40);
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(spec.subject)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse}
a{color:${C.link}}
@media (max-width:480px){
.wl-pad{padding-left:20px!important;padding-right:20px!important}
.wl-k{display:block!important;width:auto!important;padding:11px 16px 0!important;border-bottom:0!important}
.wl-v{display:block!important;padding:2px 16px 11px!important}
.wl-h1{font-size:21px!important}
}
${darkCss()}
</style>
</head>
<body class="wl-page" style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px" aria-hidden="true">${esc(spec.preheader)}${pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="wl-page" style="background:${C.page}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="wl-card" style="max-width:600px;background:${C.card};border:1px solid ${C.border};border-radius:12px;border-collapse:separate">
<tr><td style="height:4px;line-height:4px;font-size:0;background:${k.strip};border-radius:11px 11px 0 0">&nbsp;</td></tr>
<tr><td class="wl-pad" style="padding:28px 36px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="30" aria-hidden="true" style="width:30px;height:30px;background:#22c55e;border-radius:7px;text-align:center;vertical-align:middle;font:700 18px/30px ${FONT};color:#04140a">w</td>
<td class="wl-title" style="padding-left:10px;font:600 17px/30px ${FONT};color:${C.title}">WatchLog</td>
${header}
</tr></table>
</td></tr>
<tr><td class="wl-pad" style="padding:24px 36px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows.join('\n')}
</table>
</td></tr>
<tr><td class="wl-pad wl-foot" style="background:${C.footer};border-top:1px solid ${C.border};border-radius:0 0 11px 11px;padding:18px 36px;font:12px/1.7 ${FONT};color:${C.muted}">
${footer.map((f) => `<div>${f}</div>`).join('\n')}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

// ------------------------------------------------------------------------------ text

/** Wraps a paragraph at `width` columns; a word longer than that (a link) keeps its line. */
export function wrap(text, width = 72, indent = '') {
  const out = [];
  for (const raw of line(text).split('\n')) {
    let cur = '';
    for (const w of raw.split(/ +/).filter(Boolean)) {
      if (!cur) cur = w;
      else if (indent.length + cur.length + 1 + w.length <= width) cur += ` ${w}`;
      else {
        out.push(indent + cur);
        cur = w;
      }
    }
    out.push(indent + cur);
  }
  return out.join('\n');
}

function text(spec) {
  const brand = spec.edition === 'cloud' ? 'WatchLog Cloud' : 'WatchLog';
  const parts = [];
  if (spec.badge) parts.push(line(spec.badge).toUpperCase());
  parts.push(line(spec.title));
  const blocks = [parts.join('\n')];
  for (const p of spec.intro ?? []) blocks.push(wrap(p));
  if (spec.code) {
    blocks.push(
      [
        `    ${line(spec.code.value)}`,
        ...(spec.code.note ? [`    ${line(spec.code.note)}`] : []),
      ].join('\n'),
    );
  }
  if (spec.pre) blocks.push(line(spec.pre).replace(/\s+$/, ''));
  if (spec.facts?.length) {
    const w = Math.max(...spec.facts.map((f) => line(f.label).length)) + 2;
    blocks.push(
      spec.facts
        // A long value wraps under itself.
        .map((f) => `${line(f.label)}:`.padEnd(w) + wrap(f.value, 72, ' '.repeat(w)).trimStart())
        .join('\n'),
    );
  }
  if (spec.cause) blocks.push(wrap(`${line(spec.cause.label)}: ${line(spec.cause.text)}`));
  if (spec.aside) blocks.push(wrap(`${line(spec.aside.label)}: ${line(spec.aside.text)}`));
  if (spec.list?.items?.length) {
    blocks.push(
      spec.list.items
        .map((it, i) => {
          const mark = spec.list.ordered ? `${i + 1}. ` : '- ';
          return mark + wrap(it, 72, ' '.repeat(mark.length)).trimStart();
        })
        .join('\n'),
    );
  }
  for (const p of spec.after ?? []) blocks.push(wrap(p));
  const url = spec.button ? safeUrl(spec.button.url) : null;
  if (spec.button && url) blocks.push(`${line(spec.button.label)}:\n${url}`);
  for (const p of spec.note ?? []) blocks.push(wrap(p));
  if (spec.signature) blocks.push(line(spec.signature));
  const foot = [wrap(spec.footer.why)];
  if (spec.footer.manage) foot.push(wrap(spec.footer.manage));
  const unsub = spec.footer.unsubscribeUrl ? safeUrl(spec.footer.unsubscribeUrl) : null;
  if (unsub) foot.push(`Unsubscribe: ${unsub}`);
  foot.push(`${brand} · https://watchlog.io`);
  return `${blocks.join('\n\n')}\n\n-- \n${foot.join('\n')}\n`;
}

/**
 * Renders one email from its parts. `subject` is cleaned for the header; the HTML and the
 * plain text say the same things.
 */
export function renderEmail(spec) {
  const subject = headerText(spec.subject);
  const s = { ...spec, subject };
  return { subject, html: html(s), text: text(s) };
}
