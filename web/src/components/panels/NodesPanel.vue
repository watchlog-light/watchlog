<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { gaugeLevel, SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';
import { formatDuration, formatValue } from '@/lib/units';

// Each node against its own limits (1.1.0): memory against the high watermark, the disk
// alarm's limit against free disk, file descriptors, sockets (where the version has them)
// and Erlang processes; then its connections, queue leaders (4.x) and uptime.
defineProps<{ panel: PanelOf<'nodes'> }>();
</script>

<template>
  <ul class="grid gap-3 lg:grid-cols-3">
    <li
      v-for="n in panel.items"
      :key="n.name"
      class="flex min-w-0 flex-col gap-3 rounded-control border border-border bg-surface-2 p-3.5"
      data-testid="node"
      :data-node="n.name"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: `var(${SEVERITY_TOKEN[n.severity ?? 'ok']})` }"
          aria-hidden="true"
        />
        <span class="truncate font-mono text-14 text-text" :title="n.name">{{ n.name }}</span>
        <span v-if="n.version" class="ml-auto shrink-0 text-12 text-text-subtle">{{
          n.version
        }}</span>
      </div>
      <p v-if="n.down" class="text-13 text-critical-text" data-testid="node-down">
        {{ $t('integrations.rabbitmq.panels.node.down', { error: n.down }) }}
      </p>
      <ul class="flex flex-col gap-2.5">
        <li v-for="l in n.limits" :key="l.labelKey" class="flex flex-col gap-1">
          <div class="flex flex-wrap items-baseline justify-between gap-2 text-12">
            <span class="text-text-muted">{{ $t(l.labelKey) }}</span>
            <span class="text-text tabular-nums">{{
              $t('integrations.panel.ofLimit', {
                value: formatValue(l.value, l.unit),
                max: formatValue(l.max, l.unit),
              })
            }}</span>
          </div>
          <div
            class="h-1.5 overflow-hidden rounded-full bg-surface-3"
            role="meter"
            :aria-label="$t(l.labelKey)"
            :aria-valuenow="l.value"
            :aria-valuemin="0"
            :aria-valuemax="l.max"
          >
            <span
              class="block h-full rounded-full"
              :style="{
                width: `${gaugeLevel(l.value, l.max).share * 100}%`,
                background: `var(${SEVERITY_TOKEN[gaugeLevel(l.value, l.max).severity]})`,
              }"
            />
          </div>
        </li>
      </ul>
      <dl class="grid grid-cols-3 gap-2 border-t border-border pt-2.5 text-12">
        <div class="flex flex-col">
          <dt class="text-text-muted">{{ $t('integrations.rabbitmq.panels.node.connections') }}</dt>
          <dd class="text-text tabular-nums">{{ n.connections ?? '–' }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-text-muted">{{ $t('integrations.rabbitmq.panels.node.leaders') }}</dt>
          <dd class="text-text tabular-nums">{{ n.leaders ?? '–' }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-text-muted">{{ $t('integrations.rabbitmq.panels.node.uptime') }}</dt>
          <dd class="text-text tabular-nums">
            {{ n.uptime === null ? '–' : formatDuration(n.uptime) }}
          </dd>
        </div>
      </dl>
    </li>
  </ul>
</template>
