// SPDX-License-Identifier: AGPL-3.0-only
// Types of index.js (plain JavaScript, so the backend's image runs it as it is).
export type Facts = Record<string, string | number | null>;

/** The headline templates, by code (causes.headline.<code> in the dashboard). */
export declare const HEADLINES: Record<string, string>;
export declare function formatBytes(v: number): string;
export declare function formatSeconds(v: number): string;
export declare function formatCores(v: number): string;
export declare function formatEvery(s: number): string;
/** Facts as the sentences show them: `p95Ms` → `p95`, `limitBytes` → `limit`, … */
export declare function causeValues(facts: Facts): Record<string, unknown>;
/** The count that picks a sentence's form: `facts.n` when it is a number. */
export declare function pluralOf(facts: Facts): number | undefined;
/** A template with its values, as vue-i18n renders the subset the headlines use. */
export declare function renderTemplate(
  template: string,
  values?: Record<string, unknown>,
  plural?: number,
): string;
/** A headline in English; null for a code without a template here (`app_finding`). */
export declare function headlineText(sentence: { code: string; facts: Facts }): string | null;
