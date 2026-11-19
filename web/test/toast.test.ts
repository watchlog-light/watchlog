// SPDX-License-Identifier: AGPL-3.0-only
// The toast and its one optional button (ADR-219: "Silence ended" with Undo): the button
// runs its action once and takes the toast away; a toast with a button stays longer.
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToastHost from '@/components/ui/ToastHost.vue';
import { TOAST_ACTION_MS, TOAST_MS, useToastStore } from '@/stores/toast';
import { createPlugins } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('toasts', () => {
  it('a plain toast has no button and goes after 6 seconds', async () => {
    vi.useFakeTimers();
    const plugins = await createPlugins('/');
    const w = mount(ToastHost, { global: { plugins: [plugins.i18n, plugins.pinia] } });
    const store = useToastStore();
    store.show('Saved.');
    await w.vm.$nextTick();
    expect(w.get('[data-testid="toast"]').text()).toContain('Saved.');
    expect(w.find('[data-testid="toast-action"]').exists()).toBe(false);
    vi.advanceTimersByTime(TOAST_MS);
    await w.vm.$nextTick();
    expect(w.find('[data-testid="toast"]').exists()).toBe(false);
    w.unmount();
  });

  it('a toast with Undo: the button runs it once and the toast goes; it stays 10 seconds', async () => {
    vi.useFakeTimers();
    const plugins = await createPlugins('/');
    const w = mount(ToastHost, { global: { plugins: [plugins.i18n, plugins.pinia] } });
    const store = useToastStore();
    const undo = vi.fn();
    store.show('Silence ended.', 'info', { label: 'Undo', run: undo });
    await w.vm.$nextTick();
    // Still there after a plain toast would have gone.
    vi.advanceTimersByTime(TOAST_MS + 1000);
    await w.vm.$nextTick();
    const button = w.get('[data-testid="toast-action"]');
    expect(button.text()).toBe('Undo');
    expect(button.element.tagName).toBe('BUTTON');
    await button.trigger('click');
    await flushPromises();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="toast"]').exists()).toBe(false);

    store.show('Silence ended.', 'info', { label: 'Undo', run: undo });
    vi.advanceTimersByTime(TOAST_ACTION_MS);
    await w.vm.$nextTick();
    expect(w.find('[data-testid="toast"]').exists()).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
