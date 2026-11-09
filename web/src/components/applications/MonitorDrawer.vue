<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { DiscoveredService } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { serviceName } from '@/lib/applications';
import { useToastStore } from '@/stores/toast';

// Monitor a discovered service (SPEC §4.12, the mock-up's connect drawer): what was
// detected, then Start monitoring. The access step for services that need a user, the
// probe and the default alerts arrive with slice 4 (ADR-134).
const props = defineProps<{ service: DiscoveredService }>();
const emit = defineEmits<{ started: [] }>();
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();
const toast = useToastStore();
const saving = ref(false);

const s = computed(() => props.service);
const detected = computed(() => {
  const d = s.value;
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

async function start() {
  saving.value = true;
  try {
    await api('/applications', {
      method: 'POST',
      body: { clusterId: s.value.cluster.id, type: s.value.type, target: s.value.target },
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
        service: `${serviceName(s.type)} ${s.version ?? ''}`.trim(),
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
      <p class="text-13 leading-relaxed text-text-muted">
        {{ $t('applications.monitor.accessSoon') }}
      </p>
      <div class="flex justify-end gap-2 border-t border-border pt-4">
        <BaseButton variant="secondary" @click="open = false">{{
          $t('applications.monitor.cancel')
        }}</BaseButton>
        <BaseButton :loading="saving" data-testid="start-monitoring" @click="start">{{
          $t('applications.monitor.start')
        }}</BaseButton>
      </div>
    </div>
  </ModalDialog>
</template>
