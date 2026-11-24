<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Check, X } from '@lucide/vue';
import { computed } from 'vue';
import type { Credential, Found } from '../../api';

// Step 4 (ADR-233): what the discovery found, each tested with the profiles: its address,
// name, model, the profile that answered (or why none did), and who reported it. Devices
// already added can't be picked again.
const props = defineProps<{ found: Found[]; credentials: Credential[] }>();
const picked = defineModel<string[]>({ required: true });

const nameOf = computed(() => new Map(props.credentials.map((c) => [c.id, c.name])));
const pickable = computed(() => props.found.filter((f) => !f.added));
const allPicked = computed(
  () => pickable.value.length > 0 && pickable.value.every((f) => picked.value.includes(f.address)),
);
function toggleAll(on: boolean) {
  picked.value = on ? pickable.value.map((f) => f.address) : [];
}
function toggle(address: string, on: boolean) {
  picked.value = on
    ? [...new Set([...picked.value, address])]
    : picked.value.filter((a) => a !== address);
}
</script>

<template>
  <div class="overflow-x-auto rounded-card border border-border">
    <table class="w-full min-w-[880px] text-13" data-testid="found-list">
      <thead class="text-11 tracking-[0.08em] text-text-subtle uppercase">
        <tr class="border-b border-border text-left">
          <th class="w-11 px-3 py-2 font-normal">
            <label class="inline-flex items-center justify-center max-lg:size-11">
              <input
                type="checkbox"
                class="size-[18px] accent-primary"
                :checked="allPicked"
                :disabled="!pickable.length"
                :aria-label="$t('netAdd.found.all')"
                @change="toggleAll(($event.target as HTMLInputElement).checked)"
              />
            </label>
          </th>
          <th class="px-3 py-2 font-normal">{{ $t('netAdd.found.address') }}</th>
          <th class="px-3 py-2 font-normal">{{ $t('netAdd.found.name') }}</th>
          <th class="px-3 py-2 font-normal">{{ $t('netAdd.found.model') }}</th>
          <th class="px-3 py-2 font-normal">{{ $t('netAdd.found.profile') }}</th>
          <th class="px-3 py-2 font-normal">{{ $t('netAdd.found.test') }}</th>
          <th class="px-3 py-2 font-normal">{{ $t('netAdd.found.via') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="f in found"
          :key="f.address"
          class="border-b border-border last:border-0"
          :class="f.added ? 'text-text-subtle' : ''"
          :data-testid="`found-${f.address}`"
        >
          <td class="px-3 py-2">
            <label class="inline-flex items-center justify-center max-lg:size-11">
              <input
                type="checkbox"
                class="size-[18px] accent-primary"
                :checked="!f.added && picked.includes(f.address)"
                :disabled="f.added"
                :aria-label="f.name || f.address"
                @change="toggle(f.address, ($event.target as HTMLInputElement).checked)"
              />
            </label>
          </td>
          <td class="px-3 py-2 font-mono">{{ f.address }}</td>
          <td class="px-3 py-2 font-mono" :class="f.added ? '' : 'text-text'">
            {{ f.name || '–' }}
          </td>
          <td class="px-3 py-2 text-text-muted">
            {{ [f.vendor, f.model].filter(Boolean).join(' ') || '–' }}
          </td>
          <td class="px-3 py-2">
            <template v-if="f.credential">{{ nameOf.get(f.credential) ?? '–' }}</template>
            <template v-else>–</template>
            <span v-if="f.profile" class="ml-1 text-text-subtle">· {{ f.profile }}</span>
          </td>
          <td class="px-3 py-2">
            <span v-if="f.added" class="text-text-subtle">{{ $t('netAdd.found.added') }}</span>
            <span v-else-if="f.answered" class="inline-flex items-center gap-1 text-ok-text">
              <Check class="size-4" aria-hidden="true" />{{ $t('netAdd.found.answered') }}
            </span>
            <span v-else class="inline-flex items-start gap-1 text-critical-text">
              <X class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{
                f.error || $t('netAdd.found.noAnswer')
              }}
            </span>
          </td>
          <td class="px-3 py-2 text-text-muted">
            {{
              f.viaNeighbour
                ? $t('netAdd.found.viaValue', { name: f.viaNeighbour })
                : $t('netAdd.found.seed')
            }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
