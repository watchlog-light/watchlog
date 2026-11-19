// SPDX-License-Identifier: AGPL-3.0-only
/** The strip's colour and the badge's: green account and resolved, red critical, amber
 * warning and billing action, blue invites and information. */
export type EmailKind = 'account' | 'resolved' | 'critical' | 'warning' | 'billing' | 'info';

export interface EmailFact {
  label: string;
  value: string;
}

export interface EmailSpec {
  kind: EmailKind;
  /** The subject; cleaned for the header (no line breaks). */
  subject: string;
  /** The inbox's preview line, continuing the subject. */
  preheader: string;
  /** Right of the logo: the org, cluster or fleet. */
  header?: string | null;
  /** "Critical · firing", "Resolved", "Action needed". */
  badge?: string | null;
  title: string;
  /** One or two plain sentences (a paragraph each). */
  intro?: string[];
  /** A code to type: "482 913", with its note ("Valid for 15 minutes"). */
  code?: { value: string; note?: string | null } | null;
  /** Text kept as written, in a monospace box: a check's output (the operator's emails). */
  pre?: string | null;
  /** Where, since, rule, now; amount, card; organization, role. */
  facts?: EmailFact[];
  /** "Likely cause" (green box). */
  cause?: { label: string; text: string } | null;
  /** A second, neutral box: "What changed around it". */
  aside?: { label: string; text: string } | null;
  list?: { ordered?: boolean; items: string[] } | null;
  /** Paragraphs after the blocks, before the button. */
  after?: string[];
  /** The one primary button; its plain link follows it. */
  button?: { label: string; url: string } | null;
  /** Short notes under the button. */
  note?: string[];
  /** A person's signature (the lifecycle emails). */
  signature?: string | null;
  footer: {
    /** Why the reader got this email. */
    why: string;
    /** Where to change it. */
    manage?: string | null;
    /** Lifecycle emails only: the one-click unsubscribe link. */
    unsubscribeUrl?: string | null;
  };
  /** Names Cloud in the footer only in Cloud. */
  edition?: 'cloud' | 'community';
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const MAX_HTML_BYTES: number;
export function renderEmail(spec: EmailSpec): RenderedEmail;
export function escapeHtml(s: string): string;
export function headerText(s: string, max?: number): string;
export function safeUrl(u: string): string | null;
export function wrap(text: string, width?: number, indent?: string): string;
