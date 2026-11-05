// SPDX-License-Identifier: AGPL-3.0-only
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { parseStatuses, searchTerms, type ContainerStatus } from '@/lib/filter';

export const FILTER_DEBOUNCE_MS = 150;

/**
 * Page-level search and status filter kept in the URL (`?q=&status=`) so it survives a
 * reload and can be shared. `input` follows the text box; `terms` follows it after a
 * short debounce.
 */
export function useListFilter() {
  const route = useRoute();
  const router = useRouter();
  const input = ref(typeof route.query.q === 'string' ? route.query.q : '');
  const query = ref(input.value);
  const statuses = ref<ContainerStatus[]>(parseStatuses(route.query.status));
  let timer: ReturnType<typeof setTimeout> | undefined;

  function syncUrl() {
    const next = {
      ...route.query,
      q: query.value.trim() || undefined,
      status: statuses.value.length > 0 ? statuses.value.join(',') : undefined,
    };
    if (next.q === route.query.q && next.status === route.query.status) return;
    void router.replace({ query: next });
  }

  function apply() {
    clearTimeout(timer);
    query.value = input.value;
    syncUrl();
  }

  watch(input, () => {
    clearTimeout(timer);
    timer = setTimeout(apply, FILTER_DEBOUNCE_MS);
  });

  // Back/forward navigation changes the URL without touching the inputs.
  watch(
    () => [route.query.q, route.query.status],
    ([q, status]) => {
      const text = typeof q === 'string' ? q : '';
      if (text !== query.value.trim()) input.value = query.value = text;
      const parsed = parseStatuses(status);
      if (parsed.join(',') !== statuses.value.join(',')) statuses.value = parsed;
    },
  );

  function toggleStatus(status: ContainerStatus) {
    statuses.value = statuses.value.includes(status)
      ? statuses.value.filter((s) => s !== status)
      : [...statuses.value, status];
    syncUrl();
  }

  function clearText() {
    input.value = '';
    apply();
  }

  function clearAll() {
    clearTimeout(timer);
    input.value = query.value = '';
    statuses.value = [];
    void router.replace({
      query: {
        ...route.query,
        q: undefined,
        status: undefined,
        host: undefined,
        project: undefined,
      },
    });
  }

  // Host and Compose project come from the top-bar selects (DockerScopeFilter).
  const scope = computed(() => ({
    host: typeof route.query.host === 'string' ? route.query.host : '',
    project: typeof route.query.project === 'string' ? route.query.project : '',
  }));

  onBeforeUnmount(() => clearTimeout(timer));

  const terms = computed(() => searchTerms(query.value));
  const active = computed(
    () =>
      terms.value.length > 0 ||
      statuses.value.length > 0 ||
      !!scope.value.host ||
      !!scope.value.project,
  );
  return { input, query, terms, statuses, scope, active, toggleStatus, clearText, clearAll };
}
