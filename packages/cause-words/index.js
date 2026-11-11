// SPDX-License-Identifier: AGPL-3.0-only
// The words of probable cause that both the dashboard and the backend's notifications say
// (ADR-157): the headline templates, the formatting of the facts they hold (bytes, cores,
// durations), and a renderer for the part of vue-i18n's message format they use. Plain
// JavaScript with no dependencies, so the backend's image runs it as it is and the web
// bundles it; web/test/cause-words.test.ts checks that this renderer and vue-i18n give the
// same sentence for every headline.
import { HEADLINES } from './headlines.js';

export { HEADLINES };

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** "48 MiB", "1.5 GiB": binary units, one decimal under 100. */
export function formatBytes(v) {
  let i = 0;
  let n = Math.abs(v);
  while (n >= 1024 && i < BYTE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const digits = n >= 100 || i === 0 ? 0 : 1;
  const text = (Math.sign(v) * n).toFixed(digits).replace(/\.0$/, '');
  return `${text} ${BYTE_UNITS[i]}`;
}

/** "233 ms", "0.9 ms", "2.43 s": milliseconds below a second. */
export function formatSeconds(v) {
  if (v === 0) return '0 ms';
  return v < 1 ? `${+(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` : `${+v.toFixed(2)} s`;
}

/** Cores as a request or limit reads: "64", "1.5", "500m". */
export const formatCores = (v) => (v >= 1 ? String(+v.toFixed(2)) : `${Math.round(v * 1000)}m`);

/** "45 s", "2 min": how often something happens. */
export const formatEvery = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

const two = (n) => String(n).padStart(2, '0');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "08:50": a moment's clock time, the viewer's own, or UTC with `utc` ("08:50 UTC"); a
 * moment on another day than `now` gets its date ("Nov 10, 08:50"), so yesterday's restart
 * doesn't read as today's.
 */
export function formatClock(iso, utc = false, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  const parts = utc
    ? [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
    : [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
  const today = utc
    ? [n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()]
    : [n.getFullYear(), n.getMonth(), n.getDate()];
  const [y, mo, day, h, mi] = parts;
  const sameDay = y === today[0] && mo === today[1] && day === today[2];
  const date = sameDay ? '' : `${MONTHS[mo]} ${day}${y === today[0] ? '' : ` ${y}`}, `;
  return `${date}${two(h)}:${two(mi)}${utc ? ' UTC' : ''}`;
}

/**
 * Facts as the sentences show them: durations, bytes and cores in their units, a moment
 * (`at`) as its clock time (`time`; UTC with `opts.utc`, as notifications write times), with
 * its date when it isn't on `opts.now`'s day.
 */
export function causeValues(facts, opts = {}) {
  const out = { ...facts };
  if (typeof facts.at === 'string') out.time = formatClock(facts.at, !!opts.utc, opts.now);
  const num = (k) => typeof facts[k] === 'number' && Number.isFinite(facts[k]);
  if (num('p95Ms')) out.p95 = formatSeconds(facts.p95Ms / 1000);
  if (num('fromMs')) out.from = formatSeconds(facts.fromMs / 1000);
  if (num('limitBytes')) out.limit = formatBytes(facts.limitBytes);
  if (num('perMinuteBytes')) out.perMinute = formatBytes(facts.perMinuteBytes);
  if (num('requestBytes')) out.request = formatBytes(facts.requestBytes);
  if (num('requestCores')) out.request = formatCores(facts.requestCores);
  if (num('limitCores')) out.cpuLimit = formatCores(facts.limitCores);
  if (num('peakBytes')) out.peak = formatBytes(facts.peakBytes);
  if (num('everyS')) out.every = formatEvery(facts.everyS);
  return out;
}

/** The count that picks a sentence's form: its facts' `n`, when it is a number. */
export const pluralOf = (facts) => (typeof facts.n === 'number' ? facts.n : undefined);

const display = (v) =>
  v === null || v === undefined
    ? ''
    : Array.isArray(v) || (typeof v === 'object' && v.toString === Object.prototype.toString)
      ? JSON.stringify(v, null, 2)
      : String(v);

/**
 * A template with its values, as vue-i18n renders the subset the headlines use: `{name}`
 * placeholders, `{'text'}` literals, and forms split by `|`, picked as vue-i18n's default
 * rule does (two forms: singular for 1, plural otherwise; three: zero, one, more) by the
 * values' `count` or `n`, else by `plural`.
 */
export function renderTemplate(template, values = {}, plural) {
  const forms = template.split('|').map((f) => f.trim());
  let text = forms[0];
  if (forms.length > 1) {
    const pick =
      typeof values.count === 'number'
        ? values.count
        : typeof values.n === 'number'
          ? values.n
          : typeof plural === 'number'
            ? plural
            : -1;
    const choice = Math.abs(pick);
    const i = forms.length === 2 ? (choice === 1 ? 0 : 1) : Math.min(choice, 2);
    text = forms[i] ?? forms[forms.length - 1];
  }
  return text.replace(/\{\s*(?:'([^']*)'|(\w+))\s*\}/g, (_m, literal, name) => {
    if (literal !== undefined) return literal;
    const v = values[name];
    if ((name === 'n' || name === 'count') && !v && typeof plural === 'number') return plural;
    return display(v);
  });
}

/**
 * A headline in English: "web fails because api was scaled to 0: nothing answers its calls."
 * Null for a code without a template here (`app_finding`, whose words are the finding's own
 * and live with the dashboard's application pages).
 */
export function headlineText(sentence, opts = {}) {
  const template = HEADLINES[sentence.code];
  if (typeof template !== 'string') return null;
  return renderTemplate(template, causeValues(sentence.facts, opts), pluralOf(sentence.facts));
}
