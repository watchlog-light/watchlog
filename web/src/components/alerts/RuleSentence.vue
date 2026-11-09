<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { AlertRule } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { boldParts, formatValueIn, humanSeconds } from '@/lib/alerts';
import { serviceName } from '@/lib/applications';

// A rule as one plain sentence with its real values (alerts redesign item 8):
// "A pod is **crash-looping** for **2 min**", "Node **disk** above **85%** (critical above **95%**)".
const props = defineProps<{ rule: AlertRule }>();
const { t, te } = useI18n();

function scopeText(scope: AlertRule['scope'], service?: AlertRule['service']): string {
  const s = scope as {
    service?: string;
    serviceType?: string;
    namespaces?: string[];
    workload?: { name: string };
    node?: string;
    host?: string;
    container?: string;
    labels?: Record<string, string>;
  };
  const k = 'alerts.rules.sentence';
  if (s.service) return t(`${k}.service`, { name: service?.name ?? t(`${k}.serviceRemoved`) });
  if (s.serviceType) return t(`${k}.serviceType`, { type: serviceName(s.serviceType) });
  if (s.labels && Object.keys(s.labels).length) {
    return t(`${k}.labels`, {
      labels: Object.entries(s.labels)
        .map(([a, b]) => `${a}=${b}`)
        .join(', '),
    });
  }
  if (s.workload) return t(`${k}.workload`, { name: s.workload.name });
  if (s.node) return t(`${k}.node`, { name: s.node });
  if (s.host) return t(`${k}.host`, { name: s.host });
  if (s.container) return t(`${k}.container`, { name: s.container });
  if (s.namespaces?.length) return t(`${k}.namespaces`, { list: s.namespaces.join(', ') });
  return t(`${k}.wholeCluster`);
}

const parts = computed(() => {
  const r = props.rule;
  const k = 'alerts.rules.sentence';
  const c = r.condition;
  const value = c ? formatValueIn(c.value, r.unit) : '';
  let text: string;
  if (r.type === 'threshold') {
    const mk = `metricNames.${(r.metric ?? '').replaceAll('.', '_')}`;
    text = t(`${k}.custom`, {
      metric: te(mk) ? t(mk) : (r.metric ?? ''),
      scope: scopeText(r.scope, r.service),
      op: t(c?.op === '<' ? `${k}.below` : `${k}.above`),
      value,
    });
  } else {
    const key = `${k}.${(r.ruleKey ?? '').replaceAll('.', '_')}`;
    text = te(key) ? t(key, { value }) : r.name;
  }
  if (r.forSeconds > 0) text += t(`${k}.for`, { d: humanSeconds(r.forSeconds) });
  if (c?.critical !== undefined) {
    text += t(c.op === '<' ? `${k}.criticalBelow` : `${k}.critical`, {
      value: formatValueIn(c.critical, r.unit),
    });
  }
  return boldParts(text);
});
</script>

<template>
  <span>
    <template v-for="(p, i) in parts" :key="i">
      <b v-if="p.bold" class="font-semibold text-text">{{ p.text }}</b>
      <template v-else>{{ p.text }}</template>
    </template>
    <span v-if="rule.ruleKey === 'agent.not_reporting'" class="text-text-subtle">
      · {{ $t('alerts.rules.sentence.agentNote') }}</span
    >
  </span>
</template>
