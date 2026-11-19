// SPDX-License-Identifier: AGPL-3.0-only
// Cloudflare Turnstile (ADR-175) on sign-up, "Forgot your password?", resending the
// verification link and, since 0.9.9, sign-in. Cloudflare's script is loaded only by the
// pages that show the widget, and only when the backend gives a site key (GET /auth/config).
// The backend checks the token. The forms that create or mail something need one (400
// turnstile-failed without); sign-in works without one too, behind stricter limits, so a
// network that blocks Cloudflare is not locked out.
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('turnstile script failed'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function useTurnstile(
  siteKey: Ref<string | null | undefined>,
  el: Ref<HTMLElement | null>,
  /**
   * `quiet`: the widget shows only when Cloudflare wants the visitor to do something
   * ("interaction-only"); most visits it stays invisible and the token just arrives.
   */
  opts: { quiet?: boolean } = {},
) {
  const token = ref<string | null>(null);
  const failed = ref(false);
  let id: string | undefined;

  function remove() {
    if (id && window.turnstile) window.turnstile.remove(id);
    id = undefined;
  }

  watch(
    [siteKey, el],
    async ([key, node]) => {
      remove();
      token.value = null;
      failed.value = false;
      if (!key || !node) return;
      try {
        await loadScript();
      } catch {
        failed.value = true;
        return;
      }
      if (el.value !== node || !window.turnstile) return;
      id = window.turnstile.render(node, {
        sitekey: key,
        theme: 'dark',
        size: 'flexible',
        ...(opts.quiet ? { appearance: 'interaction-only' } : {}),
        callback: (t: string) => {
          token.value = t;
          failed.value = false;
        },
        'expired-callback': () => (token.value = null),
        'error-callback': () => {
          token.value = null;
          failed.value = true;
        },
      });
    },
    { immediate: true, flush: 'post' },
  );

  /** A token works once: after a submit the widget needs a new one. */
  function reset() {
    token.value = null;
    if (id && window.turnstile) window.turnstile.reset(id);
  }

  onBeforeUnmount(remove);
  return { token, failed, reset };
}
