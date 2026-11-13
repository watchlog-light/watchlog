// SPDX-License-Identifier: AGPL-3.0-only
import type { OnboardingStatus } from '@watchlog/api-types';
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { api, API_BASE } from '@/api/client';

/** How often the JSON fallback asks when the event stream can't be used. */
export const POLL_MS = 5000;

/**
 * The live connection checklist of a cluster (ADR-176): Server-Sent Events from
 * GET /clusters/:id/onboarding-status, or the same route as JSON every 5 seconds when the
 * stream fails (a proxy that buffers, a browser without EventSource). The stream ends
 * once no step is waiting; after its 10-minute limit it is opened again.
 */
export function useOnboardingStatus(clusterId: Ref<string | null | undefined>) {
  const status = ref<OnboardingStatus | null>(null);
  /** 'stream' while events arrive, 'poll' on the fallback. */
  const mode = ref<'stream' | 'poll' | 'idle'>('idle');
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function close() {
    source?.close();
    source = null;
    clearTimeout(timer);
  }

  async function poll(id: string) {
    mode.value = 'poll';
    try {
      status.value = await api<OnboardingStatus>(
        `/clusters/${encodeURIComponent(id)}/onboarding-status`,
      );
    } catch {
      // The next poll tries again.
    }
    if (!stopped && !status.value?.complete && id === clusterId.value) {
      timer = setTimeout(() => void poll(id), POLL_MS);
    }
  }

  function open(id: string) {
    close();
    if (typeof EventSource === 'undefined') return void poll(id);
    const es = new EventSource(`${API_BASE}/clusters/${encodeURIComponent(id)}/onboarding-status`, {
      withCredentials: true,
    });
    source = es;
    let received = false;
    es.addEventListener('status', (e) => {
      received = true;
      mode.value = 'stream';
      status.value = JSON.parse((e as MessageEvent<string>).data) as OnboardingStatus;
    });
    es.addEventListener('end', (e) => {
      const { reason } = JSON.parse((e as MessageEvent<string>).data) as { reason: string };
      close();
      if (reason === 'limit' && !stopped) open(id);
    });
    es.onerror = () => {
      // Before any event: the stream doesn't work here, poll instead. After: EventSource
      // reconnects by itself (retry: 5 s).
      if (!received) {
        close();
        void poll(id);
      }
    };
  }

  watch(
    clusterId,
    (id) => {
      close();
      status.value = null;
      if (id) open(id);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    stopped = true;
    close();
  });

  return { status, mode };
}
