// SPDX-License-Identifier: AGPL-3.0-only
// A cause must say something its problem doesn't (ADR-159, the owner's v0.4 review: "nginx-e2e-
// bare-1 exited with code 255" over "Likely: nginx-e2e-bare-1 exited with code 255"). Every
// Needs-attention problem recorded on the kind and Docker e2e demos (test/fixtures/causes/
// attention/: the problems' titles and why-lines, and every read GET /causes made for each;
// 2026-11-11, after a reboot of the demo VM, with the problems listed before this round's fixes
// too: the reboot's crash loops on kind, the containers the host's reboot stopped on Docker) is
// explained again here, and its likely cause's headline, as the line under the problem renders
// it, must hold a fact the title and why-line don't; no cause may be the exit alone.
import { headlineText } from '@watchlog/cause-words';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { explain, type CausesAnswer } from '../src/modules/causes/engine.js';
import type { ClusterRef } from '../src/modules/causes/resolve.js';
import { parseSubject } from '../src/modules/causes/subject.js';
import { replay, type Recording } from './support/causes.js';

interface Attention {
  cluster: ClusterRef;
  now: number;
  problems: {
    title: string;
    why: string | null;
    subject: string;
    expected: { state: string; headline: string; rule: string | null };
  }[];
  reads: Recording['reads'];
}

const load = (name: 'kube' | 'docker') =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/causes/attention/${name}.json`, import.meta.url), 'utf8'),
  ) as Attention;

/** Words that carry no fact. */
const FILLER = new Set(
  'a an the it its is was are be been has have had of in on at to for by with and or but when ' +
    'which that this from as about every last than its own'.split(' '),
);

/** The words of a sentence that say something: lowercased, without the object's own name. */
export function factWords(text: string, name: string): Set<string> {
  const names = new Set(name.toLowerCase().split(/[^a-z0-9]+/));
  return new Set(
    text
      .toLowerCase()
      .replace(name.toLowerCase(), ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !FILLER.has(w) && !names.has(w)),
  );
}

/** Whether a cause's sentence says nothing its problem's title and why-line don't. */
export function restates(
  cause: string,
  problem: { title: string; why: string | null },
  name: string,
) {
  const known = factWords(`${problem.title} ${problem.why ?? ''}`, name);
  const words = factWords(cause, name);
  return [...words].every((w) => known.has(w));
}

describe('restates: the check itself', () => {
  const p = {
    title: 'nginx-e2e-bare-1 exited with code 255',
    why: 'docker-01 · stopped 26 hours ago',
  };
  it('flags a cause that repeats the problem', () => {
    expect(restates('nginx-e2e-bare-1 exited with code 255.', p, 'nginx-e2e-bare-1')).toBe(true);
  });
  it('passes a cause that adds a fact', () => {
    expect(
      restates(
        'nginx-e2e-bare-1 stopped when host docker-01 restarted at 07:03.',
        p,
        'nginx-e2e-bare-1',
      ),
    ).toBe(false);
    expect(
      restates(
        'fx-crashloop exits with code 2 about every 24 s.',
        { title: 'fx-crashloop keeps restarting', why: '29 restarts in 10 min' },
        'fx-crashloop',
      ),
    ).toBe(false);
  });
});

describe.each(['kube', 'docker'] as const)('Needs attention on %s, replayed', (platform) => {
  const rec = load(platform);
  it.each(rec.problems.map((p) => [p.title, p] as const))('%s', async (_t, p) => {
    const reader = replay({ ...rec, subject: p.subject, expected: null as never });
    const a: CausesAnswer = await explain(reader, rec.cluster, parseSubject(p.subject), {
      now: rec.now,
    });
    expect(reader.missed).toEqual([]);
    const name = String(a.headline.facts.name ?? a.object?.name ?? '');
    if (a.state === 'likely') {
      const text = headlineText(a.headline);
      expect(text, a.headline.code).toBeTruthy();
      expect(restates(text!, p, name), `"${text}" restates "${p.title} · ${p.why}"`).toBe(false);
    }
    // No cause, likely or possible, is the exit alone: its "where it starts" would be the
    // problem's own "exited with code N".
    for (const c of a.causes) {
      const only = c.chain.length === 1 ? c.chain[0]! : null;
      expect(only && /^exit/.test(only.code), `${c.code}: ${only?.code}`).toBeFalsy();
    }
    // And as recorded.
    expect({ state: a.state, headline: a.headline.code, rule: a.causes[0]?.rule ?? null }).toEqual(
      p.expected,
    );
  });
});
