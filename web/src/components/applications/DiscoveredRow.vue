<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { DiscoveredService } from '@watchlog/api-types';
import BaseButton from '@/components/ui/BaseButton.vue';
import LockedControl from '@/components/ui/LockedControl.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo } from '@/components/ui/serviceLogos';
import { discoveredHint, NEEDS_USER, productText } from '@/lib/applications';

// One discovered service: what it is, where, how it was found and what it needs (kept on
// one line of its own under the name, so it never wraps into the buttons), Ignore and Monitor.
defineProps<{
  service: DiscoveredService;
  /** In a group, the cluster and namespace are in its title already. */
  showWhere: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ ignore: []; monitor: [] }>();
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-border bg-surface-2/40 px-3 py-2"
    data-testid="discovered-row"
  >
    <ServiceLogo :type="service.type" class="size-7 shrink-0" />
    <div class="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
      <span class="text-14 font-medium text-text">
        {{ $t(productText(service).key, productText(service).values) }}
        <span class="text-text-muted">·</span>
        <span class="font-mono break-all">{{ service.name }}</span>
      </span>
      <span class="flex min-w-0 items-center gap-1.5 text-12 text-text-muted">
        <component
          :is="KIND_LOGO[service.cluster.kind]"
          v-if="showWhere"
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate">
          <template v-if="showWhere"
            >{{ service.cluster.name
            }}{{ service.host && service.cluster.kind === 'docker' ? ` · ${service.host}` : '' }} ·
          </template>
          {{ $t(discoveredHint(service).key, discoveredHint(service).values) }}
        </span>
      </span>
      <span
        :class="[
          'text-12 whitespace-nowrap',
          NEEDS_USER.has(service.type) ? 'text-warning' : 'text-ok',
        ]"
        data-testid="needs-user"
      >
        {{
          NEEDS_USER.has(service.type)
            ? $t('applications.discovered.needsUser')
            : $t('applications.discovered.ready')
        }}
      </span>
    </div>
    <div class="ms-auto flex shrink-0 items-center gap-2">
      <LockedControl>
        <BaseButton
          variant="ghost"
          :loading="busy"
          :aria-label="$t('applications.discovered.ignoreName', { name: service.name })"
          data-testid="ignore"
          @click="emit('ignore')"
        >
          {{ $t('applications.discovered.ignore') }}
        </BaseButton>
      </LockedControl>
      <LockedControl>
        <BaseButton
          :aria-label="$t('applications.discovered.monitorName', { name: service.name })"
          data-testid="monitor"
          @click="emit('monitor')"
        >
          {{ $t('applications.discovered.monitor') }}
        </BaseButton>
      </LockedControl>
    </div>
  </div>
</template>
