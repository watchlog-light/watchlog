// SPDX-License-Identifier: AGPL-3.0-only
export declare const TOKEN_PLACEHOLDER: string;

export type PushLang = 'curl' | 'cron' | 'node' | 'python' | 'php' | 'go';
export declare const PUSH_LANGS: readonly PushLang[];
export declare const PUSH_LANG_NAMES: Readonly<Record<PushLang, string>>;
export declare const PUSH_EXAMPLE: Readonly<{ name: string; value: string }>;

/** What a push belongs to: a server's name, or a workload as "namespace/name". */
export type PushOwner = { server: string } | { workload: string } | null | undefined;

export interface PushOptions {
  /** The installation's ingest address, without a path. */
  endpoint: string;
  /** The token's value; the placeholder when empty. */
  token?: string;
  name: string;
  /** As typed; what isn't a number becomes 1. */
  value: string | number;
  owner?: PushOwner;
}

export declare function isTimestampName(name: string): boolean;
export declare function pushBody(o: Pick<PushOptions, 'name' | 'value' | 'owner'>): string;
export declare function pushSnippet(lang: PushLang, o: PushOptions): string;
/** The snippet as a whole program its runtime can run. */
export declare function pushProgram(lang: PushLang, o: PushOptions): string;
/** [file name, command, ...arguments before the file]. */
export declare const PUSH_RUNNERS: Readonly<Record<PushLang, readonly string[]>>;

export declare function remoteWriteSnippet(endpoint: string, token?: string): string;
export declare const METRICS_SAMPLE: string;
/** Without a port: the documentation's example with its defaults said. */
export declare function annotationSnippet(port?: number, path?: string): string;
export declare function kubectlPatchSnippet(o: {
  namespace: string;
  kind: string;
  name: string;
  port: number;
  path?: string;
}): string;

export type ExposeLang = 'node' | 'python' | 'go' | 'php' | 'java';
export declare const EXPOSE_LANGS: readonly ExposeLang[];
export declare const EXPOSE_LANG_NAMES: Readonly<Record<ExposeLang, string>>;
export declare function exposeSnippet(lang: ExposeLang): string;

/** [code fence language, code] of a docs marker's id; null when unknown. */
export declare function docSnippet(id: string): [string, string] | null;
/** A Markdown page with every `<!-- snippet:id -->…<!-- /snippet -->` filled from here. */
export declare function fillDocSnippets(markdown: string): string;
export declare function docSnippetIds(markdown: string): string[];

/** The first command of an install, as the install docs give it (1.3.0). */
export declare function installSnippet(kind: 'kubernetes' | 'server', version: string): string;
