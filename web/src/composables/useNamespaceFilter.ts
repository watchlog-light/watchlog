// SPDX-License-Identifier: AGPL-3.0-only
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/**
 * The top bar's namespace filter (SPEC §4.3), kept in the URL as `?ns=a,b` so it
 * applies on every Kubernetes page, survives a reload and can be shared.
 */
export function useNamespaceFilter() {
  const route = useRoute();
  const router = useRouter();
  const selected = computed<string[]>(() =>
    typeof route.query.ns === 'string' && route.query.ns
      ? [...new Set(route.query.ns.split(',').filter(Boolean))].sort()
      : [],
  );
  /** `namespaces=a,b` for the API, or an empty string. */
  const query = computed(() =>
    selected.value.length ? `namespaces=${encodeURIComponent(selected.value.join(','))}` : '',
  );

  function set(list: string[]) {
    const ns = [...new Set(list)].sort().join(',') || undefined;
    if (ns === route.query.ns) return;
    void router.replace({ query: { ...route.query, ns } });
  }

  return { selected, query, set };
}

/** Appends a query string to an API path (`?` or `&`). */
export function withQuery(path: string, ...parts: string[]): string {
  const q = parts.filter(Boolean).join('&');
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
}
