<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleCheck, CircleX } from '@lucide/vue';
import type { Alert, AlertList, Cluster } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { api } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { byCluster } from '@/lib/alerts';
import { since } from '@/lib/time';
import AlertItem from './AlertItem.vue';
import SilenceForm from './SilenceForm.vue';

// Firing (alerts redesign item 7): what needs attention now — summary tiles, one card
// for each cluster that stopped reporting with its held alerts, then the alerts
// grouped by cluster, each with its delivery status and a Silence menu.
const props = defineProps<{ list: AlertList; clusters: Cluster[]; canManage: boolean }>();
const emit = defineEmits<{ changed: [] }>();

const silencing = ref<Alert | null>(null);
const showHeld = ref(false);
const held = ref<Alert[] | null>(null);
const loadingHeld = ref(false);

/** A cluster's "stopped reporting" alert stands apart, above its group (ADR-094). */
const incidents = computed(() => props.list.alerts.filter((a) => a.labels.agent === 'all'));
const others = computed(() => props.list.alerts.filter((a) => a.labels.agent !== 'all'));
const groups = computed(() => byCluster(others.value));
const heldIn = (clusterId: string) =>
  held.value ? held.value.filter((a) => a.cluster.id === clusterId).length : null;
const clusterOf = (id: string) => props.clusters.find((c) => c.id === id);

async function toggleHeld() {
  showHeld.value = !showHeld.value;
  if (showHeld.value && held.value === null) {
    loadingHeld.value = true;
    try {
      held.value = (await api<AlertList>('/alerts?held=true')).alerts;
    } finally {
      loadingHeld.value = false;
    }
  }
}
function silenced() {
  silencing.value = null;
  emit('changed');
}
const count = (alerts: Alert[], severity: string) =>
  alerts.filter((a) => a.severity === severity && a.state === 'firing' && !a.silenced).length;

// Fetch the held alerts with the list when a cluster is silent, for the card's count.
if (props.list.counts.held > 0) {
  void api<AlertList>('/alerts?held=true')
    .then((r) => (held.value = r.alerts))
    .catch(() => {});
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <dl class="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-testid="alert-summary">
      <div class="flex flex-col gap-0.5 rounded-card border border-border bg-surface-1 px-3.5 py-3">
        <dt class="text-12 tracking-wide text-text-muted uppercase">
          {{ $t('alerts.severity.critical') }}
        </dt>
        <dd class="font-mono text-20 text-critical tabular" data-testid="tile-critical">
          {{ list.counts.critical }}
        </dd>
      </div>
      <div class="flex flex-col gap-0.5 rounded-card border border-border bg-surface-1 px-3.5 py-3">
        <dt class="text-12 tracking-wide text-text-muted uppercase">
          {{ $t('alerts.severity.warning') }}
        </dt>
        <dd class="font-mono text-20 text-warning tabular" data-testid="tile-warning">
          {{ list.counts.warning }}
        </dd>
      </div>
      <div class="flex flex-col gap-0.5 rounded-card border border-border bg-surface-1 px-3.5 py-3">
        <dt class="text-12 tracking-wide text-text-muted uppercase">{{ $t('alerts.heldBack') }}</dt>
        <dd class="font-mono text-20 text-text tabular" data-testid="tile-held">
          {{ list.counts.held }}
        </dd>
        <dd v-if="incidents.length" class="text-12 text-text-subtle">{{ $t('alerts.heldWhy') }}</dd>
        <dd v-else-if="list.counts.held > 0">
          <button
            type="button"
            class="text-12 text-primary hover:underline"
            data-testid="tile-show-held"
            @click="toggleHeld"
          >
            {{ showHeld ? $t('alerts.hideHeld') : $t('alerts.showHeld') }}
          </button>
        </dd>
      </div>
      <div class="flex flex-col gap-0.5 rounded-card border border-border bg-surface-1 px-3.5 py-3">
        <dt class="text-12 tracking-wide text-text-muted uppercase">{{ $t('alerts.silenced') }}</dt>
        <dd class="font-mono text-20 text-text tabular" data-testid="tile-silenced">
          {{ list.counts.silenced }}
        </dd>
      </div>
    </dl>

    <SilenceForm v-if="silencing" :alert="silencing" @done="silenced" @cancel="silencing = null" />

    <section
      v-for="a in incidents"
      :key="a.id"
      class="rounded-card border border-critical bg-surface-1"
      data-testid="incident"
    >
      <header class="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <TonePill tone="critical" :label="$t('alerts.severity.critical')" />
        <h2 class="text-14 font-semibold text-text">{{ a.title }}</h2>
        <span class="flex-1" />
        <span class="font-mono text-12 text-text-muted tabular">
          {{ $t('alerts.sinceFor', { d: since(a.startedAt) }) }}
        </span>
      </header>
      <div class="flex flex-wrap items-start gap-3 px-4 py-3">
        <p class="min-w-0 flex-[1_1_320px] text-13 text-text-muted">
          {{
            $t('alerts.incident.text', {
              agents: (a.why ?? '').replace(/^./, (c) => c.toUpperCase()).split(' · ')[0],
              n: heldIn(a.cluster.id) ?? list.counts.held,
            })
          }}
        </p>
        <div class="flex flex-wrap gap-2">
          <RouterLink
            :to="{ name: 'cluster-settings', params: { id: a.cluster.id } }"
            class="inline-flex h-7 items-center rounded-control border border-border-strong bg-surface-2 px-2.5 text-12 text-text hover:bg-surface-3"
          >
            {{ $t('alerts.incident.check') }}
          </RouterLink>
          <BaseButton
            v-if="list.counts.held > 0"
            variant="secondary"
            class="!h-7 !px-2.5 !text-12"
            :loading="loadingHeld"
            data-testid="show-held"
            @click="toggleHeld"
          >
            {{ showHeld ? $t('alerts.hideHeld') : $t('alerts.showHeld') }}
          </BaseButton>
        </div>
      </div>
    </section>

    <section
      v-if="showHeld && held"
      class="rounded-card border border-border bg-surface-1"
      data-testid="held-alerts"
    >
      <header class="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <h2 class="text-14 font-semibold text-text">
          {{ $t('alerts.heldTitle', { n: held.length }) }}
        </h2>
        <span class="text-13 text-text-muted">{{ $t('alerts.heldExplain') }}</span>
      </header>
      <ul>
        <AlertItem v-for="a in held" :key="a.id" :alert="a" :can-silence="false" />
      </ul>
    </section>

    <section
      v-for="g in groups"
      :key="g.cluster.id"
      class="rounded-card border border-border bg-surface-1"
      data-testid="cluster-group"
    >
      <header class="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <h2 class="text-14 font-semibold text-text">{{ g.cluster.name }}</h2>
        <span class="text-13 text-text-muted">
          {{ $t(`clusters.kind.${g.cluster.kind}`) }}
          <template v-if="clusterOf(g.cluster.id)">
            ·
            {{
              $t(
                g.cluster.kind === 'kubernetes' ? 'clusters.nodes' : 'clusters.hosts',
                { n: clusterOf(g.cluster.id)!.nodeCount },
                clusterOf(g.cluster.id)!.nodeCount,
              )
            }}
          </template>
        </span>
        <span class="flex-1" />
        <TonePill
          v-if="count(g.alerts, 'critical')"
          tone="critical"
          :label="$t('alerts.nCritical', { n: count(g.alerts, 'critical') })"
        />
        <TonePill
          v-if="count(g.alerts, 'warning')"
          tone="warning"
          :label="$t('alerts.nWarning', { n: count(g.alerts, 'warning') })"
        />
      </header>
      <ul>
        <AlertItem
          v-for="a in g.alerts"
          :key="a.id"
          :alert="a"
          :can-silence="canManage"
          @silenced="emit('changed')"
          @custom="silencing = $event"
        />
      </ul>
    </section>

    <EmptyState
      v-if="list.alerts.length === 0 && list.counts.held === 0"
      :icon="CircleCheck"
      :title="$t('alerts.empty.firing.title')"
      :description="$t('alerts.empty.firing.description')"
      :action-label="$t('alerts.empty.firing.action')"
      :action-to="{ query: { view: 'rules' } }"
    />
    <p v-else-if="list.alerts.length === 0" class="flex items-center gap-2 text-13 text-text-muted">
      <CircleX class="size-4 text-text-subtle" aria-hidden="true" />{{ $t('alerts.onlyHeld') }}
    </p>
  </div>
</template>
