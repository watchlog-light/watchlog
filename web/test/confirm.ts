// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for dialogs that ask before something is deleted or someone loses access
// (ADR-219, components/ui/ConfirmDialog.vue). A dialog is in a portal on document.body.
import { flushPromises } from '@vue/test-utils';
import { useToastStore } from '@/stores/toast';

const part = (testid: string, what: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testid}-${what}"]`);

/** The open dialog with this test id, or null. */
export const dialogOf = (testid: string) => part(testid, 'dialog');
/** The text of the open dialog, title included. */
export const dialogText = (testid: string) =>
  (dialogOf(testid)?.closest('[role="dialog"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();

export async function cancel(testid: string): Promise<void> {
  part(testid, 'cancel')!.click();
  await flushPromises();
}
export async function confirm(testid: string): Promise<void> {
  part(testid, 'confirm')!.click();
  await flushPromises();
}
/** Two presses of the danger button before the first answer is back. */
export async function confirmTwice(testid: string): Promise<void> {
  part(testid, 'confirm')!.click();
  part(testid, 'confirm')!.click();
  await flushPromises();
}
export const errorOf = (testid: string) => part(testid, 'error')?.textContent?.trim() ?? null;
/** What the toasts say now. */
export const toasts = () => useToastStore().toasts.map((t) => t.message);
/** How often a request was made. */
export const count = (calls: { method: string; path: string }[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).length;
