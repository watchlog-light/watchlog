// SPDX-License-Identifier: AGPL-3.0-only
// Account emails (ADR-220): the verification code, a sign-up with an address that has an
// account, too many wrong two-factor codes, a password reset and an invite. Transactional:
// no unsubscribe; the footer says why they came. Names from users are plain text here; the
// template escapes them.
import type { EmailSpec } from '../../lib/mail.js';
import { at, day, hhmm, when } from './format.js';

/** "482 913" from "482913". */
export const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export function verifyEmail(p: { code: string; link: string }): EmailSpec {
  const code = spacedCode(p.code);
  return {
    kind: 'account',
    subject: `${code} is your WatchLog code`,
    preheader: 'Enter it to confirm your email address. Valid for 15 minutes.',
    title: 'Confirm your email address',
    intro: ['Enter this code in WatchLog, or press the button to confirm in one step.'],
    code: { value: code, note: 'Valid for 15 minutes' },
    button: { label: 'Confirm my email', url: p.link },
    note: [
      'The button works for 24 hours. You can use WatchLog meanwhile; after 7 days an unconfirmed account can only sign in to confirm.',
      'If you didn’t create a WatchLog account, ignore this email and nothing happens.',
    ],
    footer: { why: 'You got this because this address was used to sign up for WatchLog Cloud.' },
  };
}

/** Sent instead of a second account when someone signs up with an address that has one. */
export function existingAccountEmail(p: { site: string }): EmailSpec {
  return {
    kind: 'account',
    subject: 'Someone tried to sign up with your WatchLog address',
    preheader: 'Nothing changed. Sign in, or choose a new password if you forgot it.',
    title: 'This address already has an account',
    intro: [
      'Someone, maybe you, tried to create a WatchLog account with this address. It already has one, so nothing was created and nothing changed.',
    ],
    button: { label: 'Sign in', url: at(p.site, '/signin')! },
    note: [
      'Forgot your password? Choose “Forgot your password?” on the sign-in page.',
      'If it wasn’t you, ignore this email.',
    ],
    footer: {
      why: 'You got this because someone tried to sign up for WatchLog Cloud with this address.',
    },
  };
}

export function mfaLockedEmail(p: { site: string; until: Date }): EmailSpec {
  return {
    kind: 'warning',
    subject: 'Too many wrong two-factor codes on your WatchLog account',
    preheader: `Two-factor sign-in is paused until ${hhmm(p.until)}.`,
    badge: 'Security',
    title: 'Two-factor sign-in is paused',
    intro: [
      `Someone entered your password and then too many wrong two-factor codes. Two-factor sign-in for your account is paused until ${when(p.until)}.`,
      'If it was you, wait and try again. If it wasn’t, someone knows your password: change it and sign out your other sessions.',
    ],
    button: { label: 'Review your security', url: at(p.site, '/settings?tab=security')! },
    note: ['Settings › Security lists every signed-in session and lets you change your password.'],
    footer: {
      why: 'You got this because of failed sign-ins to your WatchLog account. Security emails can’t be turned off.',
    },
  };
}

export function resetEmail(p: {
  link: string;
  /** Who asked, when an Owner or Admin sent it (Community); else the account's owner asked. */
  by?: string | null;
  /** "Chrome on macOS", when the request said. */
  device?: string | null;
  asked?: Date;
}): EmailSpec {
  const from = [p.device ? `from ${p.device}` : null, p.asked ? `on ${when(p.asked)}` : null]
    .filter(Boolean)
    .join(' ');
  return {
    kind: 'account',
    subject: 'Reset your WatchLog password',
    preheader: 'The link works once and for 1 hour.',
    title: 'Reset your password',
    intro: [
      p.by
        ? `${p.by} sent you a link to choose a new password for your WatchLog account. It works once, for 1 hour.`
        : 'Someone asked to reset the password for this account. Choose a new one with the button below. The link works once, for 1 hour.',
    ],
    button: { label: 'Choose a new password', url: p.link },
    note: [
      `Didn’t ask for this? Ignore this email: your password stays as it is until a new one is set.${from ? ` Asked ${from}.` : ''}`,
    ],
    footer: { why: 'You got this because a password reset was requested for this address.' },
  };
}

const ROLE: Record<string, { name: string; can: string }> = {
  admin: {
    name: 'an Admin',
    can: 'you can manage clusters, servers, alert rules, channels and silences',
  },
  viewer: {
    name: 'a Viewer',
    can: 'you can see every cluster, server and alert, and change nothing',
  },
};

export function inviteEmail(p: {
  inviter: string;
  inviterEmail?: string | null;
  /** Cloud: the organization. Community has one, never named: the installation's address. */
  org: string | null;
  site?: string | null;
  role: string;
  link: string;
  expires: Date;
}): EmailSpec {
  const role = ROLE[p.role] ?? ROLE.viewer!;
  const roleName = role.name.replace(/^an? /, '');
  const who =
    p.inviterEmail && p.inviterEmail !== p.inviter ? `${p.inviter} (${p.inviterEmail})` : p.inviter;
  const host = (() => {
    try {
      return p.site ? new URL(p.site).host : null;
    } catch {
      return null;
    }
  })();
  const place = p.org ?? (host ? `WatchLog at ${host}` : 'WatchLog');
  const subject = p.org
    ? `${p.inviter} invited you to ${p.org} on WatchLog`
    : `${p.inviter} invited you to ${place}`;
  return {
    kind: 'info',
    subject,
    preheader: `Join as ${role.name}. The invitation is valid until ${day(p.expires)}.`,
    header: p.org ?? host,
    title: `${p.inviter} invited you to ${place}`,
    intro: [
      p.org
        ? `${who} invited you to the organization ${p.org} on WatchLog as ${role.name}: ${role.can}.`
        : `${who} invited you to ${place} as ${role.name}: ${role.can}.`,
    ],
    facts: [
      ...(p.org
        ? [{ label: 'Organization', value: p.org }]
        : host
          ? [{ label: 'Address', value: host }]
          : []),
      { label: 'Your role', value: roleName },
      { label: 'Valid until', value: day(p.expires) },
    ],
    button: { label: 'Accept the invitation', url: p.link },
    note: [
      `The link works once. Don’t know ${p.inviter}${p.org ? ` or ${p.org}` : ''}? Ignore this email and nothing happens.`,
    ],
    footer: {
      why: p.org
        ? `You got this because an Owner or Admin of ${p.org} invited this address.`
        : `You got this because an Owner or Admin of ${place} invited this address.`,
    },
  };
}
