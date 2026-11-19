// SPDX-License-Identifier: AGPL-3.0-only
// The field where a new password is set (ADR-175, amended in 0.9.9): the checklist that
// ticks as the user types (long enough; not in the leaked-password list), what it says when
// the list can't be reached, where an error sits, show/hide, no suggestion of ours, and what a
// screen reader and a keyboard get. The leaked list is a mock: the page sends 5 characters of
// the password's SHA-1 and finds the rest in the answer itself.
import { createHash } from 'node:crypto';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import PasswordField from '@/components/ui/PasswordField.vue';
import { forgetRanges, inRange, leakCheck, sha1Hex } from '@/lib/password';
import { mockFetch, problem, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();
/** A range as Have I Been Pwned answers: padding lines with count 0, and real ones. */
const rangeWith = (...suffixes: string[]) =>
  [
    '0018A45C4D1DEF81644B54AB7F969B88D65:0',
    ...suffixes.map((s) => `${s}:3861`),
    'FFFFA45C4D1DEF81644B54AB7F969B88D65:0',
  ].join('\r\n');
const rangeRoute = (password: string, leaked: boolean): Routes => ({
  [`GET /api/v1/auth/password-range/${sha1(password).slice(0, 5)}`]: {
    status: 200,
    body: { range: rangeWith(...(leaked ? [sha1(password).slice(5)] : [])) },
  },
});

const wrappers: { unmount: () => void }[] = [];
beforeEach(() => forgetRanges());
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function mountField(props: Record<string, unknown> = {}) {
  const plugins = await createPlugins('/');
  const value = ref('');
  const field = ref<InstanceType<typeof PasswordField> | null>(null);
  const Host = defineComponent({
    setup: () => () =>
      h(PasswordField, {
        ref: field,
        modelValue: value.value,
        'onUpdate:modelValue': (v: string) => (value.value = v),
        label: 'Password',
        minLength: 10,
        debounceMs: 0,
        ...props,
      }),
  });
  const w = mount(Host, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  wrappers.push(w);
  await flushPromises();
  const rule = (key: string) => w.get(`[data-rule="${key}"]`);
  /** Types, and lets the (immediate) leaked check finish. */
  async function type(text: string) {
    await w.get('[data-testid="password-input"]').setValue(text);
    await vi.waitFor(() => {
      const leak = w.find('[data-rule="leak"]');
      if (leak.exists()) expect(leak.attributes('data-state')).not.toBe('checking');
    });
    await flushPromises();
  }
  return { w, value, field, rule, type };
}

describe('the pieces', () => {
  it('hashes as Have I Been Pwned does, and finds a hash ending only with a count above zero', async () => {
    expect(await sha1Hex('password')).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
    const range = 'AAA:0\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\nBBB:2';
    expect(inRange(range, '1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(true);
    expect(inRange(range, 'AAA')).toBe(false); // padding
    expect(inRange(range, 'CCC')).toBe(false);
  });

  it('asks for 5 characters, never more; one ask per prefix; "unavailable" when it fails', async () => {
    const asked: string[] = [];
    const fetchRange = async (prefix: string) => {
      asked.push(prefix);
      return rangeWith(sha1('correct horse battery').slice(5));
    };
    expect(await leakCheck('correct horse battery', fetchRange)).toBe('leaked');
    expect(await leakCheck('correct horse battery', fetchRange)).toBe('leaked');
    expect(asked).toEqual([sha1('correct horse battery').slice(0, 5)]);
    expect(await leakCheck('nobody has used this one 7781', fetchRange)).toBe('ok');
    const down = async () => {
      throw new Error('503');
    };
    expect(await leakCheck('another one entirely 99', down)).toBe('unavailable');
  });
});

describe('the password field', () => {
  it('empty: two rules to do, no error, new-password for password managers', async () => {
    mockFetch({});
    const { w, rule } = await mountField({ leakCheck: true });
    const input = w.get('[data-testid="password-input"]');
    expect(input.attributes('type')).toBe('password');
    expect(input.attributes('autocomplete')).toBe('new-password');
    expect(rule('length').text()).toContain('At least 10 characters');
    expect(rule('length').attributes('data-state')).toBe('todo');
    expect(rule('leak').text()).toContain('Not found in known leaked passwords');
    expect(rule('leak').attributes('data-state')).toBe('todo');
    expect(w.find('[data-testid="password-error"]').exists()).toBe(false);
    // No composition rules, and the old bar's "Weak." is gone.
    expect(w.text()).not.toMatch(/Weak|symbol|capital|uppercase|digit/i);
  });

  it('too short: the length rule stays to do and the list is not asked', async () => {
    const { fetchMock } = mockFetch({});
    const { rule, type, field, w } = await mountField({ leakCheck: true });
    await type('short');
    expect(rule('length').attributes('data-state')).toBe('todo');
    expect(rule('leak').attributes('data-state')).toBe('todo');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(field.value!.problem()).toBe('tooShort');
    expect(w.find('[data-testid="password-error"]').exists()).toBe(false);
  });

  it('ok: a long password that is not in the list ticks both, and says nothing else', async () => {
    const { calls } = mockFetch(rangeRoute('nobody has used this one 7781', false));
    const { rule, type, field, w } = await mountField({ leakCheck: true });
    await type('nobody has used this one 7781');
    expect(rule('length').attributes('data-state')).toBe('ok');
    expect(rule('leak').attributes('data-state')).toBe('ok');
    expect(rule('leak').text()).toContain('Not found in known leaked passwords');
    expect(field.value!.problem()).toBeNull();
    expect(w.find('[data-testid="password-error"]').exists()).toBe(false);
    // Only 5 characters of the hash left the page, and the password never did.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(
      `/api/v1/auth/password-range/${sha1('nobody has used this one 7781').slice(0, 5)}`,
    );
    expect(JSON.stringify(calls)).not.toContain('nobody');
    expect(JSON.stringify(calls)).not.toContain(sha1('nobody has used this one 7781').slice(5));
  });

  it('leaked: however long, it is said under the field, in words that say what to do', async () => {
    mockFetch(rangeRoute('correct horse battery staple', true));
    const { rule, type, field, w } = await mountField({ leakCheck: true });
    await type('correct horse battery staple');
    expect(rule('length').attributes('data-state')).toBe('ok');
    expect(rule('leak').attributes('data-state')).toBe('bad');
    expect(rule('leak').text()).toContain('Found in a list of leaked passwords');
    const error = w.get('[data-testid="password-error"]');
    expect(error.text()).toBe(
      'This password is in a list of leaked passwords, so attackers try it first. Pick a different one, or let your browser or password manager suggest one.',
    );
    expect(error.attributes('role')).toBe('alert');
    // Directly under the field: the next element after the input's box, before the rules.
    const order = [...w.get('[data-testid="password-field"]').element.children].map(
      (el) => el.getAttribute('data-testid') ?? el.tagName,
    );
    expect(order.indexOf('password-error')).toBe(2);
    expect(order.indexOf('password-rules')).toBe(3);
    const input = w.get('[data-testid="password-input"]');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toContain(error.attributes('id'));
    expect(field.value!.problem()).toBe('leaked');
    // Typing another one clears it.
    mockFetch(rangeRoute('nobody has used this one 7781', false));
    await type('nobody has used this one 7781');
    expect(w.find('[data-testid="password-error"]').exists()).toBe(false);
    expect(rule('leak').attributes('data-state')).toBe('ok');
  });

  it('the list can’t be reached: nothing alarming, and the form may go on', async () => {
    mockFetch({
      [`GET /api/v1/auth/password-range/${sha1('nobody has used this one 7781').slice(0, 5)}`]:
        problem(503, "The leaked-password list can't be reached right now."),
    });
    const { rule, type, field, w } = await mountField({ leakCheck: true });
    await type('nobody has used this one 7781');
    expect(rule('leak').attributes('data-state')).toBe('unknown');
    expect(rule('leak').text()).toContain(
      "Couldn't check right now; we'll check when you continue",
    );
    expect(rule('leak').classes()).not.toContain('text-critical');
    expect(w.find('[data-testid="password-error"]').exists()).toBe(false);
    expect(w.find('[role="alert"]').exists()).toBe(false);
    expect(field.value!.problem()).toBeNull();
  });

  it('waits for a pause in typing before it asks, and only the last word counts', async () => {
    vi.useFakeTimers();
    const { calls } = mockFetch({
      ...rangeRoute('first long password', true),
      ...rangeRoute('second long password', false),
    });
    const { w, rule } = await mountField({ leakCheck: true, debounceMs: 400 });
    const input = w.get('[data-testid="password-input"]');
    await input.setValue('first long password');
    expect(rule('leak').attributes('data-state')).toBe('checking');
    expect(rule('leak').text()).toContain('Checking the list of leaked passwords');
    await vi.advanceTimersByTimeAsync(300);
    await input.setValue('second long password');
    await vi.advanceTimersByTimeAsync(399);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // The hashing is the browser's own work, not on this clock: wait for the request itself.
    vi.useRealTimers();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.path).toBe(
      `/api/v1/auth/password-range/${sha1('second long password').slice(0, 5)}`,
    );
    await vi.waitFor(() => expect(rule('leak').attributes('data-state')).toBe('ok'));
    // Nothing more comes: the first word was never asked about.
    await flushPromises();
    expect(calls).toHaveLength(1);
  });

  it('Community: the length is the only rule and nothing is asked of any list', async () => {
    const { fetchMock } = mockFetch({});
    const { w, type, field } = await mountField();
    await type('a perfectly long password');
    expect(w.findAll('[data-rule]').map((r) => r.attributes('data-rule'))).toEqual(['length']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(field.value!.problem()).toBeNull();
  });

  it('the form’s own word for the field replaces the field’s, and sits in the same place', async () => {
    mockFetch({});
    const { w } = await mountField({ error: 'This is too short: use at least 10 characters.' });
    const error = w.get('[data-testid="password-error"]');
    expect(error.text()).toBe('This is too short: use at least 10 characters.');
    expect(w.get('[data-testid="password-input"]').classes()).toContain('border-critical');
  });

  it('show and hide: a real button with a name and a state, by keyboard too', async () => {
    mockFetch({});
    const { w } = await mountField();
    const input = w.get('[data-testid="password-input"]');
    const toggle = w.get('[data-testid="password-toggle"]');
    expect(toggle.element.tagName).toBe('BUTTON');
    expect(toggle.attributes('type')).toBe('button');
    expect(toggle.attributes('aria-label')).toBe('Show password');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(toggle.attributes('aria-controls')).toBe(input.attributes('id'));
    await input.setValue('a secret to look at');
    await toggle.trigger('click');
    expect(input.attributes('type')).toBe('text');
    expect(toggle.attributes('aria-label')).toBe('Hide password');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    // What was typed is kept, and the focus is not moved (a second press hides it again).
    expect(document.activeElement).not.toBe(input.element);
    expect((input.element as HTMLInputElement).value).toBe('a secret to look at');
    await toggle.trigger('click');
    expect(input.attributes('type')).toBe('password');
    // In the tab order, after the field (no tabindex tricks).
    expect(toggle.attributes('tabindex')).toBeUndefined();
  });

  it('has no suggestion of its own: the browser or password manager offers one (0.9.10)', async () => {
    mockFetch({});
    const { w } = await mountField({ leakCheck: true });
    const input = w.get('[data-testid="password-input"]');
    // The browser's own suggestion is offered for a new password.
    expect(input.attributes('autocomplete')).toBe('new-password');
    expect(w.find('[data-testid="password-suggest"]').exists()).toBe(false);
    expect(w.text()).not.toMatch(/suggest/i);
  });

  it('for a screen reader: a label, the rules described, each rule’s state in words, changes announced', async () => {
    mockFetch(rangeRoute('correct horse battery staple', true));
    const { w, type } = await mountField({ leakCheck: true });
    const input = w.get('[data-testid="password-input"]');
    const label = w.get('label');
    expect(label.text()).toBe('Password');
    expect(label.attributes('for')).toBe(input.attributes('id'));
    const rules = w.get('[data-testid="password-rules"]');
    expect(rules.element.tagName).toBe('UL');
    expect(input.attributes('aria-describedby')).toBe(rules.attributes('id'));
    // The state is said in words, not only by an icon's colour.
    expect(w.get('[data-rule="length"]').text()).toBe('Still to do: At least 10 characters');
    expect(w.findAll('[data-rule] svg').every((i) => i.attributes('aria-hidden') === 'true')).toBe(
      true,
    );
    const live = w.get('[data-testid="password-announce"]');
    expect(live.attributes('aria-live')).toBe('polite');
    expect(live.text()).toBe('');
    await type('correct horse battery staple');
    expect(live.text()).toBe(
      'Done: At least 10 characters. Not met: Found in a list of leaked passwords',
    );
  });
});
