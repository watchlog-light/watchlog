<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import LockedControl from '@/components/ui/LockedControl.vue';
import { Hash, Mail, Plus, Send, Webhook } from '@lucide/vue';
import type { AlertChannel, AlertRule, AlertRuleList } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { api } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import { RULE_GROUPS, ruleGroup, ruleOrder, severityTone } from '@/lib/alerts';
import RuleSentence from './RuleSentence.vue';

// Rules (alerts redesign item 8): where default rules send to, said once at the top;
// then every rule as one sentence with its real values, grouped, with how many fire
// now, its severity and an on/off switch. A row opens the rule editor.
const props = defineProps<{ rules: AlertRule[]; channels: AlertChannel[]; canManage: boolean }>();
const emit = defineEmits<{ changed: []; open: [rule: AlertRule]; create: [] }>();
const ICONS = { slack: Hash, telegram: Send, email: Mail, webhook: Webhook } as const;

const groups = computed(() =>
  RULE_GROUPS.map((g) => ({
    group: g,
    rules: props.rules
      .filter((r) => ruleGroup(r) === g)
      .sort((a, b) => ruleOrder(a) - ruleOrder(b)),
  })).filter((g) => g.rules.length),
);
const defaults = computed(() => props.rules.filter((r) => r.type === 'default'));
/** The channels default rules send to, and whether some default rules differ. */
const defaultIds = computed(() => [...new Set(defaults.value.flatMap((r) => r.channelIds))]);
const mixed = computed(() =>
  defaults.value.some(
    (r) => r.channelIds.slice().sort().join() !== defaultIds.value.slice().sort().join(),
  ),
);
const channelById = (id: string) => props.channels.find((c) => c.id === id);
const channelLabel = (c: AlertChannel) =>
  c.type === 'email' ? `${c.name} · ${(c.config.recipients ?? []).join(', ')}` : c.name;

const changing = ref(false);
const chosen = ref<string[]>([]);
const saving = ref(false);
function change() {
  chosen.value = [...defaultIds.value];
  changing.value = true;
}
async function saveDefaults() {
  saving.value = true;
  try {
    await api<AlertRuleList>('/alert-rules/defaults/channels', {
      method: 'PUT',
      body: { channelIds: chosen.value },
    });
    changing.value = false;
    emit('changed');
  } finally {
    saving.value = false;
  }
}

const toggling = ref<string | null>(null);
async function toggle(rule: AlertRule) {
  toggling.value = rule.id;
  try {
    await api(`/alert-rules/${rule.id}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
    emit('changed');
  } finally {
    toggling.value = null;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <section
      class="flex flex-wrap items-center gap-2.5 rounded-card border border-border bg-surface-1 px-4 py-3"
      data-testid="default-channels"
    >
      <span class="text-13 text-text-muted">{{ $t('alerts.rules.defaultsSendTo') }}</span>
      <template v-if="!changing">
        <span
          v-for="id in defaultIds"
          :key="id"
          class="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface-3 px-2 py-0.5 text-12 text-text"
          data-testid="default-channel"
        >
          <component
            :is="ICONS[channelById(id)?.type ?? 'webhook']"
            class="size-3.5 text-text-muted"
            aria-hidden="true"
          />
          {{ channelById(id) ? channelLabel(channelById(id)!) : id }}
        </span>
        <span v-if="defaultIds.length === 0" class="text-13 text-text-subtle">{{
          $t('alerts.rules.defaultsNone')
        }}</span>
        <span v-if="mixed" class="text-12 text-text-subtle">{{
          $t('alerts.rules.defaultsMixed')
        }}</span>
        <span class="flex-1" />
        <LockedControl>
          <BaseButton
            variant="secondary"
            class="!h-7 !px-2.5 !text-12 max-lg:!h-11 max-lg:!px-3.5 max-lg:!text-13"
            data-testid="change-defaults"
            @click="change"
          >
            {{ $t('alerts.rules.change') }}
          </BaseButton>
        </LockedControl>
        <LockedControl>
          <BaseButton
            class="!h-7 !px-2.5 !text-12 max-lg:!h-11 max-lg:!px-3.5 max-lg:!text-13"
            data-testid="new-rule"
            @click="emit('create')"
          >
            <Plus class="size-3.5" aria-hidden="true" />{{ $t('alerts.rules.newCustom') }}
          </BaseButton>
        </LockedControl>
      </template>
      <template v-else>
        <ComboBox
          v-model="chosen"
          multiple
          clearable
          :options="
            channels.map((c) => ({ value: c.id, label: channelLabel(c), icon: ICONS[c.type] }))
          "
          :label="$t('alerts.rules.defaultsSendTo')"
          :empty-text="$t('alerts.rules.noChannels')"
          class="min-w-64 flex-1"
          testid="default-channels-picker"
        />
        <BaseButton
          class="!h-8 max-lg:!h-11"
          :loading="saving"
          data-testid="save-defaults"
          @click="saveDefaults"
          >{{ $t('common.save') }}</BaseButton
        >
        <BaseButton variant="ghost" class="!h-8 max-lg:!h-11" @click="changing = false">{{
          $t('common.cancel')
        }}</BaseButton>
      </template>
    </section>

    <section
      v-for="g in groups"
      :key="g.group"
      class="overflow-hidden rounded-card border border-border bg-surface-1"
      :data-testid="`rule-group-${g.group}`"
    >
      <header class="flex items-baseline gap-2 border-b border-border bg-surface-2 px-4 py-2.5">
        <h2 class="text-14 font-semibold text-text">{{ $t(`alerts.rules.groups.${g.group}`) }}</h2>
        <small class="text-12 text-text-subtle">{{
          $t('alerts.rules.count', { n: g.rules.length }, g.rules.length)
        }}</small>
      </header>
      <ul>
        <li
          v-for="r in g.rules"
          :key="r.id"
          :class="[
            'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-surface-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]',
            r.enabled ? '' : 'opacity-70',
          ]"
          data-testid="rule-row"
          @click="emit('open', r)"
        >
          <button
            type="button"
            class="min-w-0 text-left text-14 text-text-muted max-lg:min-h-11"
            data-testid="rule-sentence"
            @click.stop="emit('open', r)"
          >
            <RuleSentence :rule="r" />
            <span
              v-if="r.evalError"
              class="mt-0.5 block text-12 text-critical"
              data-testid="rule-error"
            >
              {{ $t('alerts.rules.evalError', { error: r.evalError }) }}
            </span>
          </button>
          <span
            :class="[
              'hidden text-12 whitespace-nowrap sm:inline',
              r.firing
                ? r.severity === 'critical'
                  ? 'text-critical'
                  : 'text-warning'
                : 'text-text-subtle',
            ]"
          >
            {{
              r.firing
                ? $t('alerts.rules.firing', { n: r.firing }, r.firing)
                : r.enabled
                  ? ''
                  : $t('alerts.rules.off')
            }}
          </span>
          <span class="hidden items-center gap-1 sm:flex">
            <TonePill
              :tone="r.enabled ? severityTone(r.severity) : 'neutral'"
              :label="$t(`alerts.severity.${r.severity}`)"
            />
            <template v-if="r.condition?.critical !== undefined && r.severity !== 'critical'">
              <span class="text-text-subtle">/</span>
              <TonePill
                :tone="r.enabled ? 'critical' : 'neutral'"
                :label="$t('alerts.severity.critical')"
              />
            </template>
          </span>
          <button
            type="button"
            role="switch"
            :aria-checked="r.enabled"
            :aria-label="$t('alerts.rules.enabled', { name: r.name })"
            :disabled="!canManage || toggling === r.id"
            class="flex shrink-0 items-center justify-center rounded-full disabled:opacity-60 max-lg:-my-2 max-lg:size-11"
            data-testid="rule-toggle"
            @click.stop="toggle(r)"
          >
            <!-- The visible track; on touch screens the button around it is 44 px. -->
            <span
              :class="[
                'relative block h-5 w-9 rounded-full border transition-colors',
                r.enabled ? 'border-primary bg-primary' : 'border-border-strong bg-surface-3',
              ]"
            >
              <span
                :class="[
                  'absolute top-0.5 size-3.5 rounded-full bg-text transition-all',
                  r.enabled ? 'left-[18px]' : 'left-0.5',
                ]"
              />
            </span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
