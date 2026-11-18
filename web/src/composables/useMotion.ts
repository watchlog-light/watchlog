// SPDX-License-Identifier: AGPL-3.0-only
// Whether a decorative animation may run right now (ADR-216): `off` when the viewer asked
// for reduced motion (everything still, the same information), `paused` while the tab is
// hidden or the element is scrolled out of view (so an idle tab spends nothing on it), `on`
// otherwise. Components put it in a `data-motion` attribute and their CSS does the rest.
import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue';

export type Motion = 'on' | 'paused' | 'off';

const REDUCED = '(prefers-reduced-motion: reduce)';

/** The viewer asked for reduced motion (false where the browser can't say). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED).matches
    : false;
}

export function useMotion(el: Ref<Element | null>): ComputedRef<Motion> {
  const reduced = ref(prefersReducedMotion());
  const hidden = ref(typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const offscreen = ref(false);
  let media: MediaQueryList | undefined;
  let observer: IntersectionObserver | undefined;

  const onMedia = (e: MediaQueryListEvent) => (reduced.value = e.matches);
  const onVisibility = () => (hidden.value = document.visibilityState === 'hidden');

  onMounted(() => {
    if (typeof window.matchMedia === 'function') {
      media = window.matchMedia(REDUCED);
      reduced.value = media.matches;
      media.addEventListener?.('change', onMedia);
    }
    document.addEventListener('visibilitychange', onVisibility);
    if (el.value && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        const last = entries.at(-1);
        if (last) offscreen.value = !last.isIntersecting;
      });
      observer.observe(el.value);
    }
  });
  onBeforeUnmount(() => {
    media?.removeEventListener?.('change', onMedia);
    document.removeEventListener('visibilitychange', onVisibility);
    observer?.disconnect();
  });

  return computed(() =>
    reduced.value ? 'off' : hidden.value || offscreen.value ? 'paused' : 'on',
  );
}
