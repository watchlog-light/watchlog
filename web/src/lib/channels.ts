// SPDX-License-Identifier: AGPL-3.0-only
// The state of an alert channel, one rule for its row and for its card's header, so the two
// can't disagree ("1 connected" above a row that says "Failing").
import type { AlertChannel } from '@watchlog/api-types';
import type { Tone } from '@/lib/kube';

export type ChannelState = 'notConnected' | 'failing' | 'working' | 'untested';

/**
 * - notConnected: a Telegram bot with no chat yet;
 * - failing: the last delivery or test failed (the backend clears the error on the next one
 *   that works);
 * - working: the last delivery or test worked;
 * - untested: nothing was sent yet.
 */
export function channelState(ch: AlertChannel): ChannelState {
  if (ch.type === 'telegram' && !ch.config.connected) return 'notConnected';
  if (ch.lastError) return 'failing';
  if (ch.verifiedAt || ch.lastSentAt) return 'working';
  return 'untested';
}

export const STATE_TONE: Record<ChannelState, Tone> = {
  notConnected: 'warning',
  failing: 'critical',
  working: 'ok',
  untested: 'neutral',
};

type Translate = (key: string, named: Record<string, unknown>) => string;

/**
 * The card header's pill when a channel in it is failing, else null (the card then says what
 * it always said: "2 channels", "1 connected", "Ready").
 */
export function failingPill(
  channels: AlertChannel[],
  t: Translate,
): { tone: Tone; label: string } | null {
  const failing = channels.filter((c) => channelState(c) === 'failing').length;
  if (!failing) return null;
  return {
    tone: 'critical',
    label:
      failing === channels.length
        ? t('channels.failingCount', { n: failing })
        : t('channels.failingOf', { n: failing, total: channels.length }),
  };
}
