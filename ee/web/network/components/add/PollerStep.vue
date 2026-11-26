<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Boxes, Server } from '@lucide/vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import type { PollerChoice } from '../../api';
import PollerMove from './PollerMove.vue';

// Step 1 (ADR-233): the place that reads the devices, each in its own words: a Kubernetes
// cluster's collector polls from inside the cluster; on a Server fleet one of its servers does,
// and a server without the collector shows the one line that adds it.
defineProps<{ pollers: PollerChoice[] }>();
// 1.0.2: each poller says how many devices it reads, and they can be moved to another.
const emit = defineEmits<{ moved: [] }>();
const model = defineModel<{ clusterId: string; host: string } | null>({ required: true });

const installLine = `curl -fsSL ${window.location.origin}/install.sh | sudo sh -s -- --upgrade`;
const isPicked = (clusterId: string, host: string) =>
  model.value?.clusterId === clusterId && model.value.host === host;
</script>

<template>
  <div class="flex flex-col gap-3" role="radiogroup" :aria-label="$t('netAdd.poller.title')">
    <p v-if="!pollers.length" class="text-13 text-text-muted">{{ $t('netAdd.poller.none') }}</p>
    <div v-for="p in pollers" :key="p.clusterId" class="flex flex-col gap-2">
      <template v-if="p.kind === 'kubernetes'">
        <label
          class="flex cursor-pointer items-center gap-3 rounded-card border bg-surface-2 px-4 py-3"
          :class="isPicked(p.clusterId, '') ? 'border-primary' : 'border-border'"
          :data-testid="`poller-${p.name}`"
        >
          <input
            type="radio"
            name="poller"
            class="size-[18px] shrink-0 accent-primary"
            :checked="isPicked(p.clusterId, '')"
            :disabled="!p.hosts[0]?.collector"
            @change="model = { clusterId: p.clusterId, host: '' }"
          />
          <Boxes class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="font-mono text-14 text-text">{{ p.name }}</span>
            <span class="text-12 text-text-muted">{{ $t('netAdd.poller.kubernetesLong') }}</span>
            <span v-if="!p.hosts[0]?.collector" class="text-12 text-warning-text">{{
              $t('netAdd.poller.kubernetesNoCollector')
            }}</span>
            <span v-else-if="!p.hosts[0]?.reporting" class="text-12 text-warning-text">{{
              $t('netAdd.poller.notReporting')
            }}</span>
          </span>
        </label>
        <PollerMove
          :from="{ clusterId: p.clusterId, host: '' }"
          :name="p.name"
          :devices="p.hosts[0]?.devices ?? 0"
          :pollers="pollers"
          @moved="emit('moved')"
        />
      </template>
      <template v-else>
        <span class="text-11 tracking-[0.08em] text-text-subtle uppercase">
          {{ $t('netAdd.poller.fleet', { name: p.name }) }}
        </span>
        <p v-if="!p.hosts.length" class="text-13 text-text-muted">
          {{ $t('netAdd.poller.noServers') }}
        </p>
        <div v-for="h in p.hosts" :key="h.host" class="flex flex-col gap-2">
          <label
            class="flex items-center gap-3 rounded-card border bg-surface-2 px-4 py-3"
            :class="[
              isPicked(p.clusterId, h.host) ? 'border-primary' : 'border-border',
              h.collector ? 'cursor-pointer' : 'cursor-not-allowed',
            ]"
            :data-testid="`poller-${p.name}-${h.host}`"
          >
            <input
              type="radio"
              name="poller"
              class="size-[18px] shrink-0 accent-primary"
              :checked="isPicked(p.clusterId, h.host)"
              :disabled="!h.collector"
              @change="model = { clusterId: p.clusterId, host: h.host }"
            />
            <Server class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="font-mono text-14 break-all text-text">{{ h.host }}</span>
              <span class="text-12 text-text-muted">{{
                $t('netAdd.poller.serverLong', { fleet: p.name })
              }}</span>
              <span v-if="!h.collector" class="text-12 text-warning-text">{{
                $t('netAdd.poller.noCollector')
              }}</span>
              <span v-else-if="!h.reporting" class="text-12 text-warning-text">{{
                $t('netAdd.poller.notReporting')
              }}</span>
            </span>
          </label>
          <PollerMove
            :from="{ clusterId: p.clusterId, host: h.host }"
            :name="h.host"
            :devices="h.devices ?? 0"
            :pollers="pollers"
            @moved="emit('moved')"
          />
          <div v-if="!h.collector" class="flex flex-col gap-1.5 sm:pl-8">
            <p class="text-12 text-text-muted">
              {{ $t('netAdd.poller.install', { host: h.host }) }}
            </p>
            <CodeBlock :code="installLine" :label="$t('netAdd.poller.installLabel')" wrap />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
