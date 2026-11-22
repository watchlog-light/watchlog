<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, CircleAlert, Copy, Info, ShieldCheck } from '@lucide/vue';
import type { EgressPolicy } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useCopy } from '@/composables/useCopy';
import { useLoader } from '@/composables/useLoader';

// The suggested egress policy on a Kubernetes workload's page (ADR-190): two flavours as
// tabs, the detected one first (ADR-191), the YAML to copy, the window it was built from, and
// "WatchLog never applies it". On a Docker container or Compose service page it explains why
// there is none: Docker has no standard egress policy object.
const props = defineProps<{
  clusterId: string;
  kind: 'kubernetes' | 'server';
  /** Kubernetes: the workload. */
  workload?: { namespace: string; kind: string; name: string };
}>();
const { t } = useI18n();

const page = useLoader(async () => {
  const w = props.workload!;
  const p = new URLSearchParams({
    cluster: props.clusterId,
    workload: `${w.namespace}/${w.kind}/${w.name}`,
  });
  return api<EgressPolicy>(`/egress/policy?${p.toString()}`);
});
onMounted(() => {
  if (props.kind === 'kubernetes' && props.workload) void page.load();
});

const picked = ref<string | null>(null);
const policies = computed(() => page.data.value?.policies ?? []);
const current = computed(
  () => policies.value.find((p) => p.flavour === picked.value) ?? policies.value[0],
);
const { state: copyState, copy } = useCopy();

/** No running pod (409): the selector comes from the pods' labels. */
const noPods = computed(
  () => page.error.value instanceof ApiError && page.error.value.status === 409,
);

const day = (iso: string) => iso.slice(0, 10);
const windowText = computed(() => {
  const w = page.data.value?.window;
  if (!w) return '';
  return w.inCluster
    ? t('egress.policy.window', {
        inCluster: day(w.inCluster.from),
        external: day(w.external.from),
        to: day(w.to),
      })
    : t('egress.policy.windowNoFlows', { external: day(w.external.from), to: day(w.to) });
});
const note = computed(() => {
  const d = page.data.value;
  if (!d || !current.value) return '';
  const name = props.workload?.name ?? '';
  if (current.value.flavour === 'kubernetes') return t('egress.policy.note.kubernetes', { name });
  if (d.cilium === true) return t('egress.policy.note.cilium', { name });
  return d.cilium === false
    ? t('egress.policy.note.ciliumMissing')
    : t('egress.policy.note.ciliumUnknown');
});

function pick(flavour: string) {
  picked.value = flavour;
}
/** Arrow keys move between the tabs (WAI-ARIA tabs). */
function onKey(e: KeyboardEvent, i: number) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const list = policies.value;
  const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
  if (next) {
    pick(next.flavour);
    (document.getElementById(`policy-tab-${next.flavour}`) as HTMLElement | null)?.focus();
  }
}
</script>

<template>
  <section
    v-if="kind === 'server'"
    aria-labelledby="policy-docker-title"
    class="rounded-card border border-border bg-surface-1 px-4 py-3"
    data-testid="egress-policy-docker"
  >
    <h2 id="policy-docker-title" class="flex items-center gap-2 text-14 font-semibold text-text">
      <Info class="size-4 shrink-0 text-info-text" aria-hidden="true" />
      {{ $t('egress.policy.docker.title') }}
    </h2>
    <p class="mt-1.5 text-13 leading-relaxed text-text-muted">
      {{ $t('egress.policy.docker.body') }}
    </p>
  </section>

  <section
    v-else
    aria-labelledby="policy-title"
    class="flex flex-col gap-3.5 rounded-card border border-border bg-surface-1 p-4"
    data-testid="egress-policy"
  >
    <div class="flex flex-col gap-1.5">
      <h2 id="policy-title" class="flex items-center gap-2 text-14 font-semibold text-text">
        <ShieldCheck class="size-4.5 shrink-0 text-info-text" aria-hidden="true" />
        {{ $t('egress.policy.title') }}
      </h2>
      <p class="text-13 leading-relaxed text-text-muted" data-testid="policy-never">
        {{ $t('egress.policy.subtitle', { name: workload?.name ?? '' }) }}
      </p>
    </div>

    <div
      v-if="!page.data.value && !page.error.value"
      class="flex flex-col gap-2"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="policy-loading"
    >
      <Skeleton class="w-2/5 text-13" />
      <Skeleton class="h-32 w-full" />
    </div>
    <p
      v-else-if="noPods"
      class="text-13 text-text-muted"
      role="status"
      data-testid="policy-no-pods"
    >
      {{ $t('egress.policy.noPods') }}
    </p>
    <div
      v-else-if="!page.data.value"
      class="flex flex-wrap items-center gap-3 text-13 text-text-muted"
      role="status"
      data-testid="policy-error"
    >
      <CircleAlert class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ $t('egress.policy.error') }}</span>
      <button type="button" class="text-link hover:underline max-lg:min-h-11" @click="page.load">
        {{ $t('common.retry') }}
      </button>
    </div>
    <template v-else-if="current">
      <div
        role="tablist"
        :aria-label="$t('egress.policy.flavour')"
        class="flex flex-wrap gap-0.5 self-start rounded-control border border-border bg-bg p-0.5"
      >
        <button
          v-for="(p, i) in policies"
          :id="`policy-tab-${p.flavour}`"
          :key="p.flavour"
          type="button"
          role="tab"
          :aria-selected="p.flavour === current.flavour"
          :aria-controls="`policy-panel`"
          :tabindex="p.flavour === current.flavour ? 0 : -1"
          :class="[
            'rounded-control px-3.5 py-2 text-13 max-lg:min-h-11',
            p.flavour === current.flavour
              ? 'bg-surface-2 font-semibold text-text'
              : 'text-text-muted hover:text-text',
          ]"
          :data-testid="`policy-tab-${p.flavour}`"
          @click="pick(p.flavour)"
          @keydown="onKey($event, i)"
        >
          {{ $t(`egress.policy.tab.${p.flavour}`) }}
        </button>
      </div>
      <div
        id="policy-panel"
        role="tabpanel"
        :aria-labelledby="`policy-tab-${current.flavour}`"
        class="flex flex-col gap-3"
      >
        <p
          class="rounded-control border border-info/35 bg-info/10 px-3.5 py-3 text-13 leading-relaxed text-text"
          data-testid="policy-note"
        >
          {{ note }}
        </p>
        <p class="text-12 text-text-subtle" data-testid="policy-window">{{ windowText }}</p>
        <pre
          class="max-h-[28rem] overflow-auto rounded-control border border-border bg-bg p-4 font-mono text-12 leading-relaxed text-text"
          data-testid="policy-yaml"
        ><code>{{ current.yaml }}</code></pre>
        <div class="flex flex-wrap items-center justify-between gap-2.5">
          <span class="text-12 text-text-muted">{{ $t('egress.policy.dockerLine') }}</span>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface-2 px-4 py-2.5 text-13 font-semibold text-text hover:bg-surface-3 max-lg:min-h-11"
            data-testid="policy-copy"
            @click="copy(current.yaml)"
          >
            <Check v-if="copyState === 'copied'" class="size-3.5 text-ok-text" aria-hidden="true" />
            <Copy v-else class="size-3.5" aria-hidden="true" />
            <span aria-live="polite">{{
              copyState === 'copied'
                ? $t('common.copied')
                : copyState === 'failed'
                  ? $t('common.copyFailed')
                  : $t('egress.policy.copy')
            }}</span>
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
