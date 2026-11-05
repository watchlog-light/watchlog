// SPDX-License-Identifier: AGPL-3.0-only
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppI18n } from '@/i18n';
import { routes } from '@/router';

export async function createPlugins(path = '/') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  return { pinia, router, i18n: createAppI18n() };
}

/** Opens the Combobox with this data-testid and clicks the option whose text starts with `label`. */
export async function chooseOption(
  root: { get(selector: string): { trigger(event: string, opts?: object): Promise<void> } },
  testid: string,
  label: string,
): Promise<void> {
  const { flushPromises } = await import('@vue/test-utils');
  const input = root.get(`[data-testid="${testid}"] [role="combobox"]`);
  await input.trigger('focus');
  await input.trigger('keydown', { key: 'ArrowDown' });
  await flushPromises();
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    o.textContent?.trim().startsWith(label),
  );
  if (!option) throw new Error(`no option "${label}" in ${testid}: ${listedOptions().join(' | ')}`);
  option.click();
  await flushPromises();
}

/** The options currently listed by an open Combobox. */
export function listedOptions(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (o) => o.textContent?.trim() ?? '',
  );
}
