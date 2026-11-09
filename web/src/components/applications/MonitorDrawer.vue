<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Probe } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '@/api/client';
import AccessStep from '@/components/applications/AccessStep.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { productText, type ConnectTarget } from '@/lib/applications';
import { useToastStore } from '@/stores/toast';

// Monitor a service (SPEC §4.12, the mock-up's connect drawer, ADR-134): what was
// detected, how WatchLog logs in and the test that proves it, the query-text switch
// (PostgreSQL, ADR-138), then Start monitoring. A failed test doesn't block Start: the
// service page keeps saying why it can't connect.
const props = defineProps<{ service: ConnectTarget }>();
const emit = defineEmits<{ started: [] }>();
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();
const toast = useToastStore();
const saving = ref(false);
const probe = ref<Probe | null>(null);
const queryText = ref(true);

// Default alerts (slice 5): the rules a service of this type gets, on unless unticked;
// unticked ones are created off, ready to enable on the service page.
interface AlertDefault {
  key: string;
  name: string;
  metric: string;
  condition: { op: '>' | '<'; value: number; critical?: number };
  forSeconds: number;
}
const defaults = ref<AlertDefault[]>([]);
const chosen = ref<string[]>([]);
onMounted(async () => {
  try {
    defaults.value = (
      await api<{ defaults: AlertDefault[] }>(
        `/applications/alert-defaults?type=${props.service.type}`,
      )
    ).defaults;
    chosen.value = defaults.value.map((d) => d.key);
  } catch {
    defaults.value = [];
  }
});
function toggleDefault(key: string, on: boolean) {
  chosen.value = on ? [...new Set([...chosen.value, key])] : chosen.value.filter((k) => k !== key);
}

const s = computed(() => props.service);
const detected = computed(() => {
  const d = s.value;
  if (d.target.kind === 'address') {
    return t('applications.monitor.detectedAddress', {
      address: d.target.address,
      cluster: d.cluster.name,
    });
  }
  if (d.cluster.kind === 'kubernetes') {
    return t('applications.monitor.detectedK8s', {
      image: d.image ?? '—',
      port: d.port,
      namespace: d.group,
      cluster: d.cluster.name,
    });
  }
  return t('applications.monitor.detectedDocker', {
    image: d.image ?? '—',
    port: d.port,
    host: d.host ?? d.cluster.name,
    project: d.group ? t('applications.monitor.detectedProject', { project: d.group }) : '',
  });
});
// A user's access needs its probe first (the password lives with it); "nothing to set up"
// can start while the test runs.
const ready = computed(() => probe.value !== null);

async function start() {
  saving.value = true;
  try {
    await api('/applications', {
      method: 'POST',
      body: {
        clusterId: s.value.cluster.id,
        type: s.value.type,
        target: s.value.target,
        ...(s.value.collectorHost ? { collectorHost: s.value.collectorHost } : {}),
        ...(s.value.target.kind === 'address' ? { name: s.value.name } : {}),
        ...(probe.value ? { probeId: probe.value.id } : {}),
        ...(s.value.type === 'postgres' ? { queryText: queryText.value } : {}),
        defaultAlerts: chosen.value,
      },
    });
    toast.show(t('applications.monitor.started', { name: s.value.name }));
    emit('started');
  } catch (err) {
    toast.show(
      t('applications.monitor.failed', {
        name: s.value.name,
        error: err instanceof ApiError ? err.message : String(err),
      }),
      'warning',
    );
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="
      $t('applications.monitor.title', {
        service: t(productText(s).key, productText(s).values),
      })
    "
    size="lg"
  >
    <template #icon><ServiceLogo :type="s.type" class="size-9" /></template>
    <div class="flex flex-col gap-5" data-testid="monitor-drawer">
      <p class="flex items-center gap-1.5 text-12 text-text-muted">
        <component :is="KIND_LOGO[s.cluster.kind]" class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="font-mono">{{ s.name }}</span>
        <span>· {{ s.cluster.name }}</span>
      </p>
      <section class="flex flex-col gap-1.5">
        <h3 class="text-14 font-semibold text-text">{{ $t('applications.monitor.detected') }}</h3>
        <p class="text-13 leading-relaxed text-text-muted">{{ detected }}</p>
      </section>

      <AccessStep :service="s" @probe="(p) => (probe = p)" />

      <label v-if="s.type === 'postgres'" class="flex items-start justify-between gap-4">
        <span class="flex flex-col gap-0.5">
          <span class="text-13 font-medium text-text">{{
            $t('applications.monitor.queryText')
          }}</span>
          <span class="text-12 text-text-muted">{{
            $t('applications.monitor.queryTextHint')
          }}</span>
        </span>
        <ToggleSwitch v-model="queryText" data-testid="query-text" />
      </label>

      <section v-if="defaults.length" class="flex flex-col gap-2" data-testid="default-alerts">
        <h3 class="text-14 font-semibold text-text">
          {{ $t('applications.monitor.defaultAlerts') }}
        </h3>
        <label
          v-for="d in defaults"
          :key="d.key"
          class="flex items-start gap-2.5 text-13 max-lg:min-h-11 max-lg:items-center"
          :data-default="d.key"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="chosen.includes(d.key)"
            @change="toggleDefault(d.key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="flex flex-col gap-0.5">
            <span class="text-text">{{ $t(`applications.monitor.alert.${d.key}`) }}</span>
          </span>
        </label>
        <p class="text-12 text-text-muted">{{ $t('applications.monitor.defaultAlertsHint') }}</p>
      </section>

      <div class="flex justify-end gap-2 border-t border-border pt-4">
        <BaseButton variant="secondary" @click="open = false">{{
          $t('applications.monitor.cancel')
        }}</BaseButton>
        <BaseButton
          :loading="saving"
          :disabled="!ready"
          data-testid="start-monitoring"
          @click="start"
        >
          {{ $t('applications.monitor.start') }}
        </BaseButton>
      </div>
    </div>
  </ModalDialog>
</template>
