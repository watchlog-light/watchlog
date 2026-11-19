// SPDX-License-Identifier: AGPL-3.0-only
// The dialog that asks before something is deleted or someone loses access (ADR-219): what
// it says, Cancel focused, Escape and Cancel change nothing, the danger button runs the
// action once and shows progress, and a failure stays in the dialog.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { ApiError } from '@/api/client';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { cancel, confirm, confirmTwice, dialogOf, dialogText, errorOf } from './confirm';
import { createPlugins } from './helpers';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A real Escape press: one a handler can refuse. */
const escape = () =>
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

async function mountDialog(action: () => Promise<unknown>) {
  const plugins = await createPlugins('/');
  const open = ref(true);
  const Host = defineComponent({
    setup: () => () =>
      h(ConfirmDialog, {
        open: open.value,
        'onUpdate:open': (v: boolean) => (open.value = v),
        title: 'Revoke this invite?',
        subject: 'dev@example.com',
        lines: [
          'The invite link stops working at once.',
          'You can invite this address again later.',
        ],
        confirmLabel: 'Revoke invite',
        action,
        testid: 'revoke',
      }),
  });
  const w = mount(Host, {
    attachTo: document.body,
    global: { plugins: [plugins.router, plugins.i18n, plugins.pinia] },
  });
  await flushPromises();
  return { w, open };
}

describe('ConfirmDialog', () => {
  it('says what will happen and to whom, with Cancel focused and a danger button', async () => {
    const action = vi.fn(async () => {});
    const { w } = await mountDialog(action);
    const text = dialogText('revoke');
    for (const piece of [
      'Revoke this invite?',
      'dev@example.com',
      'The invite link stops working at once.',
      'You can invite this address again later.',
      'Cancel',
      'Revoke invite',
    ]) {
      expect(text).toContain(piece);
    }
    const cancelButton = document.querySelector('[data-testid="revoke-cancel"]')!;
    expect(document.activeElement).toBe(cancelButton);
    const danger = document.querySelector('[data-testid="revoke-confirm"]')!;
    expect(danger.className).toContain('bg-critical');
    expect(action).not.toHaveBeenCalled();
    w.unmount();
  });

  it('Cancel and Escape close it and run nothing', async () => {
    const action = vi.fn(async () => {});
    const first = await mountDialog(action);
    await cancel('revoke');
    expect(first.open.value).toBe(false);
    expect(dialogOf('revoke')).toBeNull();
    first.w.unmount();

    const second = await mountDialog(action);
    document.activeElement!.dispatchEvent(escape());
    await flushPromises();
    expect(second.open.value).toBe(false);
    expect(action).not.toHaveBeenCalled();
    second.w.unmount();
  });

  it('runs the action once however often the button is pressed, shows progress, then closes', async () => {
    let done!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    const { w, open } = await mountDialog(action);
    await confirmTwice('revoke');
    const danger = document.querySelector<HTMLButtonElement>('[data-testid="revoke-confirm"]')!;
    expect(action).toHaveBeenCalledTimes(1);
    expect(danger.disabled).toBe(true);
    expect(danger.getAttribute('aria-busy')).toBe('true');
    // Cancel is off and Escape does nothing while it is on its way.
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="revoke-cancel"]')!.disabled,
    ).toBe(true);
    document.activeElement!.dispatchEvent(escape());
    await flushPromises();
    expect(open.value).toBe(true);
    done();
    await flushPromises();
    expect(open.value).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('a failure stays in the dialog, in the server’s words, and can be tried again', async () => {
    const action = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiError(409, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This invite was already accepted.',
        }),
      )
      .mockRejectedValueOnce(new ApiError(0))
      .mockResolvedValueOnce();
    const { w, open } = await mountDialog(action);
    await confirm('revoke');
    expect(open.value).toBe(true);
    expect(errorOf('revoke')).toBe('This invite was already accepted.');
    // No answer at all: our own words.
    await confirm('revoke');
    expect(errorOf('revoke')).toBe(
      "That didn't work, so nothing was changed. Check your connection and try again.",
    );
    await confirm('revoke');
    expect(open.value).toBe(false);
    expect(action).toHaveBeenCalledTimes(3);
    w.unmount();
  });
});
