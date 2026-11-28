<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type {
  AlertChannelList,
  AlertRule,
  AlertRuleList,
  Application,
  ClusterList,
} from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '@/api/client';
import LockedControl from '@/components/ui/LockedControl.vue';
import RuleDrawer from '@/components/alerts/RuleDrawer.vue';
import RuleSentence from '@/components/alerts/RuleSentence.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// Alerts for this service (SPEC §4.12, the mock-up's block): the rules scoped to it, each
// switched on or off in place, how many fire, and "+ Add rule", which opens the rule
// editor with the service already chosen. Viewers read (ADR-140).
const props = defineProps<{ app: Application }>();
const { t, te } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const data = useLoader(async () => {
  const [r, c, cl, d] = await Promise.all([
    api<AlertRuleList>('/alert-rules'),
    auth.canManage
      ? api<AlertChannelList>('/alert-channels')
      : Promise.resolve({ channels: [] } as unknown as AlertChannelList),
    api<ClusterList>('/clusters'),
    api<{ defaults: { key: string; name: string }[] }>(
      `/applications/alert-defaults?type=${encodeURIComponent(props.app.type)}`,
    ).catch(() => ({ defaults: [] })),
  ]);
  return { rules: r.rules, channels: c.channels, clusters: cl.clusters, defaults: d.defaults };
});
onMounted(data.load);
const rules = computed(() =>
  (data.data.value?.rules ?? []).filter((r) => r.service?.id === props.app.id),
);

// Defaults WatchLog added after this service was set up (1.2's for databases): never on by
// themselves; offered here, added in one click by an Owner or Admin.
const missing = computed(() => {
  const have = new Set(rules.value.map((r) => r.defaultKey));
  return (data.data.value?.defaults ?? []).filter((d) => !have.has(d.key));
});
const defaultName = (d: { key: string; name: string }) =>
  te(`applications.monitor.alert.${d.key}`) ? t(`applications.monitor.alert.${d.key}`) : d.name;
const adding = ref(false);
async function addMissing() {
  adding.value = true;
  try {
    const keys = missing.value.map((d) => d.key);
    await api(`/applications/${props.app.id}/alert-defaults`, { method: 'POST', body: { keys } });
    toast.show(t('integrations.alerts.newDefaultsAdded', { n: keys.length }, keys.length));
    await data.load();
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    adding.value = false;
  }
}
const editing = ref<AlertRule | null>(null);
const drawerOpen = ref(false);
function open(rule: AlertRule | null) {
  editing.value = rule;
  drawerOpen.value = true;
}
async function toggle(rule: AlertRule, enabled: boolean) {
  try {
    await api(`/alert-rules/${rule.id}`, { method: 'PATCH', body: { enabled } });
    await data.load();
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  }
}
</script>

<template>
  <section
    class="flex min-w-0 flex-[999_1_28rem] flex-col rounded-card border border-border bg-surface-1"
    data-testid="service-alerts"
  >
    <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
      <h3 class="text-14 font-semibold text-text">{{ $t('integrations.alerts.title') }}</h3>
      <LockedControl align="end">
        <BaseButton variant="secondary" data-testid="add-rule" @click="open(null)">{{
          $t('integrations.alerts.add')
        }}</BaseButton>
      </LockedControl>
    </div>
    <p v-if="data.error.value" class="px-4 py-3 text-13 text-text-subtle sm:px-5">
      {{ $t('integrations.alerts.error') }}
    </p>
    <p
      v-else-if="data.loaded.value && rules.length === 0"
      class="px-4 py-3 text-13 text-text-subtle sm:px-5"
    >
      {{ $t('integrations.alerts.none') }}
    </p>
    <ul v-else>
      <li
        v-for="r in rules"
        :key="r.id"
        class="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
        data-testid="service-rule"
      >
        <LockedControl>
          <ToggleSwitch
            :model-value="r.enabled"
            :aria-label="t('integrations.alerts.enable', { name: r.name })"
            @update:model-value="(v: boolean) => toggle(r, v)"
          />
        </LockedControl>
        <button
          type="button"
          class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left max-lg:min-h-11 max-lg:justify-center"
          :disabled="!auth.canManage"
          @click="open(r)"
        >
          <span :class="['text-14', r.enabled ? 'text-text' : 'text-text-muted']">{{
            r.name
          }}</span>
          <span class="text-12 text-text-muted"><RuleSentence :rule="r" /></span>
        </button>
        <span
          v-if="r.firing > 0"
          class="shrink-0 rounded-full bg-critical/15 px-2 py-0.5 text-12 font-semibold text-critical-text"
          >{{ $t('applications.firing', { n: r.firing }) }}</span
        >
        <span v-else-if="!r.enabled" class="shrink-0 text-12 text-text-subtle">{{
          $t('integrations.alerts.off')
        }}</span>
      </li>
    </ul>
    <div
      v-if="data.loaded.value && missing.length && rules.length"
      class="flex flex-col gap-2 border-t border-border px-4 py-3 sm:px-5"
      data-testid="new-defaults"
    >
      <p class="text-13 text-text">
        {{ $t('integrations.alerts.newDefaults', { n: missing.length }, missing.length) }}
      </p>
      <ul class="list-disc pl-5 text-13 text-text-muted">
        <li v-for="d in missing" :key="d.key">{{ defaultName(d) }}</li>
      </ul>
      <LockedControl class="self-start">
        <BaseButton
          variant="secondary"
          :loading="adding"
          :disabled="!auth.canManage"
          data-testid="add-new-defaults"
          @click="addMissing"
          >{{
            $t('integrations.alerts.addNewDefaults', { n: missing.length }, missing.length)
          }}</BaseButton
        >
      </LockedControl>
    </div>
    <p class="px-4 pb-3 text-12 text-text-muted sm:px-5">
      {{ $t('integrations.alerts.anyMetric') }}
    </p>
    <RuleDrawer
      v-if="data.data.value && drawerOpen"
      v-model:open="drawerOpen"
      :rule="editing"
      :channels="data.data.value.channels"
      :clusters="data.data.value.clusters"
      :service="{ id: app.id, name: app.name, clusterId: app.cluster.id, type: app.type }"
      @saved="data.load"
    />
  </section>
</template>
