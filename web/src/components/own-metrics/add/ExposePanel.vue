<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Expose /metrics (1.0.3): what a /metrics page is, with a sample; an address on a server (or
// a workload's port in a cluster) that can be tested before it is scraped; "Find endpoints
// for me" saying what it tried; and, when there is nothing to read, the ways forward. In a
// cluster the annotation is also given as one kubectl command and as YAML.
import type { OwnAddressTest, OwnFound, OwnMetricsSummary } from '@watchlog/api-types';
import { annotationSnippet, kubectlPatchSnippet, METRICS_SAMPLE } from '@watchlog/snippets';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi, type NewSource } from '@/api/own-metrics';
import FindEndpoints from '@/components/own-metrics/FindEndpoints.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { ownerOptions, workloadOf } from '@/lib/own-add';
import { useAuthStore } from '@/stores/auth';
import AddressTest from './AddressTest.vue';
import NoMetricsYet from './NoMetricsYet.vue';

const props = defineProps<{
  cluster: string;
  summary: OwnMetricsSummary;
  /** The search the page ran quietly on opening. */
  found: OwnFound | null;
}>();
const emit = defineEmits<{ changed: []; push: [] }>();
const { t } = useI18n();
const auth = useAuthStore();
const kube = computed(() => props.summary.kind === 'kubernetes');
const words = (err: unknown) =>
  (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.add.failed');

// What is read: an address on one server, or a workload's port and path.
const options = computed(() => ownerOptions(props.summary));
const where = ref<string | null>(null);
watch(
  options,
  (list) => {
    if (where.value && !list.some((o) => o.value === where.value)) where.value = null;
    if (!where.value && list.length === 1) where.value = list[0]!.value;
  },
  { immediate: true },
);
const address = ref('');
const port = ref('');
const path = ref('/metrics');
const portNumber = computed(() => Number(port.value.trim()));
const portOk = computed(
  () => Number.isInteger(portNumber.value) && portNumber.value >= 1 && portNumber.value <= 65535,
);
const workload = computed(() => workloadOf(where.value));
const body = computed<NewSource | null>(() => {
  if (kube.value) {
    const w = workload.value;
    if (!w || !portOk.value) return null;
    const p = path.value.trim() || '/metrics';
    return {
      namespace: w.namespace,
      workloadKind: w.kind,
      workload: w.name,
      port: portNumber.value,
      ...(p !== '/metrics' ? { path: p.startsWith('/') ? p : `/${p}` } : {}),
    };
  }
  return where.value && address.value.trim()
    ? { server: where.value, address: address.value.trim() }
    : null;
});
const shown = computed(() => {
  const w = workload.value;
  return kube.value
    ? w
      ? `${w.namespace}/${w.name} :${port.value.trim()}${path.value.trim() || '/metrics'}`
      : ''
    : address.value.trim();
});
const needed = computed(() =>
  t(kube.value ? 'ownMetrics.add.scrape.kube.needed' : 'ownMetrics.add.scrape.server.needed'),
);

// Test: asked, then read every second and a half until the collector answered.
const test = ref<OwnAddressTest | null>(null);
const testing = ref(false);
const error = ref('');
const added = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let run = 0;
onBeforeUnmount(() => {
  run++;
  clearTimeout(timer);
});
watch([where, address, port, path], () => {
  // Another address: the old answer isn't about it.
  run++;
  clearTimeout(timer);
  testing.value = false;
  test.value = null;
  added.value = false;
  error.value = '';
});
async function runTest() {
  error.value = '';
  added.value = false;
  test.value = null;
  if (!body.value) {
    error.value = needed.value;
    return;
  }
  const mine = ++run;
  testing.value = true;
  try {
    let r = await ownMetricsApi.test(props.cluster, body.value);
    const again = async () => {
      if (mine !== run) return;
      try {
        r = await ownMetricsApi.tested(props.cluster);
      } catch (err) {
        if (mine !== run) return;
        error.value = words(err);
        testing.value = false;
        return;
      }
      if (mine !== run) return;
      if (r.done) {
        test.value = r;
        testing.value = false;
      } else timer = setTimeout(() => void again(), 1500);
    };
    if (r.done) {
      test.value = r;
      testing.value = false;
    } else timer = setTimeout(() => void again(), 800);
  } catch (err) {
    if (mine !== run) return;
    error.value = words(err);
    testing.value = false;
  }
}

const adding = ref(false);
async function add() {
  error.value = '';
  if (!body.value) {
    error.value = needed.value;
    return;
  }
  adding.value = true;
  try {
    await ownMetricsApi.addSource(props.cluster, body.value);
    // The field is emptied for the next address; the note comes after that (emptying it
    // clears what was said about the last one).
    if (!kube.value) address.value = '';
    await nextTick();
    added.value = true;
    emit('changed');
  } catch (err) {
    error.value = words(err);
  } finally {
    adding.value = false;
  }
}

// The annotation, for the chosen workload when there is one.
const patch = computed(() => {
  const w = workload.value;
  if (!w) return '';
  const p = path.value.trim() || '/metrics';
  return kubectlPatchSnippet({ ...w, port: portOk.value ? portNumber.value : 8080, path: p });
});
const yaml = computed(() =>
  workload.value && portOk.value
    ? annotationSnippet(portNumber.value, path.value.trim() || '/metrics')
    : annotationSnippet(),
);
const prom = computed<boolean>({
  get: () => props.summary.settings.prometheusAnnotations,
  set: (v) => {
    void ownMetricsApi.settings(props.cluster, v).then(
      () => emit('changed'),
      (err: unknown) => (error.value = words(err)),
    );
  },
});

// Nothing to read here: the search finished empty.
const nothing = ref(false);
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="own-expose">
    <div>
      <h2 class="text-16 font-semibold text-text">{{ $t('ownMetrics.add.scrape.h') }}</h2>
      <p class="mt-2 text-14 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.add.scrape.what') }}
      </p>
      <pre
        class="mt-3 overflow-x-auto rounded-control border border-border bg-bg px-4 py-3 font-mono text-12 leading-relaxed text-text-muted"
        :aria-label="$t('ownMetrics.add.scrape.sample')"
        data-testid="own-expose-sample"
        >{{ METRICS_SAMPLE }}</pre>
    </div>

    <template v-if="auth.canManage">
      <!-- A fleet: an address on one server. -->
      <form
        v-if="!kube"
        class="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto]"
        data-testid="own-address-form"
        @submit.prevent="add"
      >
        <label class="flex min-w-0 flex-col gap-1.5 text-13 font-medium text-text">
          {{ $t('ownMetrics.add.scrape.server.server') }}
          <ComboBox
            v-model="where"
            :options="options"
            :label="$t('ownMetrics.add.scrape.server.server')"
            :placeholder="$t('ownMetrics.add.scrape.server.pick')"
            testid="own-address-server"
          />
        </label>
        <TextField
          v-model="address"
          technical
          autocomplete="off"
          :label="$t('ownMetrics.add.scrape.server.address')"
          placeholder="localhost:9400/metrics"
          data-testid="own-address-input"
        />
        <BaseButton
          variant="secondary"
          :loading="testing"
          data-testid="own-address-test"
          @click="runTest"
        >
          {{ $t('ownMetrics.add.scrape.server.test') }}
        </BaseButton>
        <BaseButton type="submit" :loading="adding" data-testid="own-address-add">
          {{ $t('ownMetrics.add.scrape.server.add') }}
        </BaseButton>
      </form>

      <!-- A cluster: a workload's port. -->
      <form
        v-else
        class="grid items-end gap-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_auto_auto]"
        data-testid="own-port-form"
        @submit.prevent="add"
      >
        <label class="flex min-w-0 flex-col gap-1.5 text-13 font-medium text-text">
          {{ $t('ownMetrics.add.scrape.kube.workload') }}
          <ComboBox
            v-model="where"
            :options="options"
            :label="$t('ownMetrics.add.scrape.kube.workload')"
            :placeholder="$t('ownMetrics.add.scrape.kube.pick')"
            testid="own-port-workload"
          />
        </label>
        <TextField
          v-model="port"
          technical
          inputmode="numeric"
          :label="$t('ownMetrics.add.scrape.kube.port')"
          placeholder="8080"
          :maxlength="5"
          data-testid="own-port-input"
        />
        <TextField
          v-model="path"
          technical
          :label="$t('ownMetrics.add.scrape.kube.path')"
          placeholder="/metrics"
          :maxlength="256"
          data-testid="own-path-input"
        />
        <BaseButton
          variant="secondary"
          :loading="testing"
          data-testid="own-address-test"
          @click="runTest"
        >
          {{ $t('ownMetrics.add.scrape.kube.test') }}
        </BaseButton>
        <BaseButton type="submit" :loading="adding" data-testid="own-address-add">
          {{ $t('ownMetrics.add.scrape.kube.add') }}
        </BaseButton>
      </form>

      <AddressTest
        :test="test"
        :running="testing"
        :address="shown"
        :summary="summary"
        :error="error"
      />
      <p v-if="added" class="text-13 text-ok-text" role="status" data-testid="own-address-added">
        {{ $t('ownMetrics.add.scrape.added') }}
      </p>
      <p v-if="kube" class="text-13 text-text-muted">
        {{ $t('ownMetrics.add.scrape.kube.noRestart') }}
      </p>

      <div class="border-t border-border pt-4">
        <FindEndpoints
          :cluster="cluster"
          :kube="kube"
          :initial="found"
          @changed="emit('changed')"
          @none="nothing = $event"
        />
      </div>
      <NoMetricsYet v-if="nothing" :kube="kube" @push="emit('push')" />
    </template>

    <!-- A cluster: the same thing kept with the workload. -->
    <details
      v-if="kube"
      class="group rounded-card border border-border bg-surface-2"
      data-testid="own-annotate"
    >
      <summary
        class="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-14 font-medium text-text hover:bg-surface-3 [&::-webkit-details-marker]:hidden"
      >
        <span
          class="inline-block text-text-muted transition-transform group-open:rotate-90"
          aria-hidden="true"
          >›</span
        >
        {{ $t('ownMetrics.add.scrape.kube.annotate') }}
      </summary>
      <div class="flex flex-col gap-3 border-t border-border px-4 pt-3 pb-4">
        <p class="text-13 leading-relaxed text-text-muted">
          {{ $t('ownMetrics.add.scrape.kube.annotateP') }}
        </p>
        <div v-if="patch" class="min-w-0" data-testid="own-annotate-patch">
          <CodeBlock :code="patch" :label="$t('ownMetrics.add.scrape.kube.patch')" />
        </div>
        <div class="min-w-0" data-testid="own-annotate-yaml">
          <CodeBlock :code="yaml" :label="$t('ownMetrics.add.scrape.kube.yaml')" />
        </div>
        <ToggleSwitch v-if="auth.canManage" v-model="prom" data-testid="own-prom-toggle">
          {{ $t('ownMetrics.add.scrape.kube.prometheus') }}
        </ToggleSwitch>
        <p v-else-if="prom" class="text-13 text-text-muted">
          {{ $t('ownMetrics.add.scrape.kube.prometheusOn') }}
        </p>
      </div>
    </details>

    <!-- A Viewer and the demo: the ways forward are still worth reading. -->
    <NoMetricsYet v-if="!auth.canManage" :kube="kube" @push="emit('push')" />
  </div>
</template>
