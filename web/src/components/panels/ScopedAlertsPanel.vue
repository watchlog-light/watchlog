<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { AlertChannelList } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import LockedControl from '@/components/ui/LockedControl.vue';
import type { PanelOf } from '@/lib/panels';
import { useServicePage } from '@/lib/service-page';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// A database statement's or table's alerts (1.2, as a queue's in 1.1.0): firing, quiet or
// off, and the ones the page adds in one click, scoped to this service and this statement or
// table, sent to every channel. Owners and Admins add; Viewers read.
const props = defineProps<{ panel: PanelOf<'scoped_alerts'> }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const page = useServicePage();
const auth = useAuthStore();
const toast = useToastStore();
const adding = ref('');
const taken = computed(() => new Set(props.panel.rules.map((r) => r.name)));
// The rule's name says what it watches: "shop/public.orders: …", "statement 38368…: …".
const name = computed(() =>
  props.panel.scope.table
    ? props.panel.scope.table
    : t('integrations.db.panels.alerts.statementName', {
        id: (props.panel.scope.statement ?? '').slice(0, 12),
      }),
);
const ruleName = (key: string) => `${name.value}: ${t(key)}`;

async function add(p: PanelOf<'scoped_alerts'>['presets'][number]) {
  adding.value = p.key;
  try {
    const { channels } = await api<AlertChannelList>('/alert-channels');
    await api('/alert-rules', {
      method: 'POST',
      body: {
        name: ruleName(p.nameKey),
        metric: p.metric,
        clusterId: page.clusterId,
        scope: { service: page.appId, ...props.panel.scope },
        condition: { op: p.op, value: p.value },
        forSeconds: p.forSeconds,
        severity: p.severity,
        channelIds: channels.map((c) => c.id),
      },
    });
    toast.show(t('integrations.db.panels.alerts.added', { name: ruleName(p.nameKey) }));
    emit('changed');
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    adding.value = '';
  }
}
const STATE = {
  firing: 'bg-critical/15 text-critical-text',
  quiet: 'bg-surface-3 text-text-muted',
  off: 'bg-surface-3 text-text-subtle',
} as const;
</script>

<template>
  <div class="flex flex-col gap-3 text-13">
    <ul v-if="panel.rules.length" class="flex flex-col divide-y divide-border">
      <li
        v-for="r in panel.rules"
        :key="r.id"
        class="flex items-center justify-between gap-3 py-2"
        data-testid="scoped-rule"
      >
        <span class="min-w-0 truncate text-text" :title="r.name">{{ r.name }}</span>
        <span
          class="shrink-0 rounded-full px-2.5 py-0.5 text-12 font-medium"
          :class="STATE[r.state]"
          >{{ $t(`integrations.db.panels.alerts.state.${r.state}`) }}</span
        >
      </li>
    </ul>
    <p v-else class="text-text-subtle">{{ $t('integrations.db.panels.alerts.none') }}</p>
    <div class="flex flex-col gap-2">
      <span class="text-12 text-text-muted">{{ $t('integrations.db.panels.alerts.addOne') }}</span>
      <div class="flex flex-wrap gap-2">
        <LockedControl v-for="p in panel.presets" :key="p.key">
          <BaseButton
            variant="secondary"
            :disabled="taken.has(ruleName(p.nameKey)) || !auth.canManage"
            :loading="adding === p.key"
            :data-testid="`scoped-alert-${p.key}`"
            @click="add(p)"
            >{{ $t(p.nameKey) }}</BaseButton
          >
        </LockedControl>
      </div>
    </div>
  </div>
</template>
