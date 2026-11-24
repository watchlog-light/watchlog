<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import TextField from '@/components/ui/TextField.vue';
import { networkApi, type Credential } from '../../api';

// The commands that make a profile's read-only user on the device (ADR-233), for Cisco IOS,
// NX-OS and RouterOS, written by the server from the profile; the poller's address, when
// typed, limits who may use them.
const props = defineProps<{ credentials: Credential[]; preferred: string[] }>();
const { t } = useI18n();

type Platform = 'ios' | 'nxos' | 'routeros';
const PLATFORMS: Platform[] = ['ios', 'nxos', 'routeros'];
const platform = ref<Platform>('ios');
const protocolOf = (p: Platform) => (p === 'routeros' ? 'routeros' : 'snmp');
const matching = computed(() =>
  props.credentials.filter((c) => c.protocol === protocolOf(platform.value)),
);
const credentialId = ref('');
watch(
  [matching, () => props.preferred],
  () => {
    if (matching.value.some((c) => c.id === credentialId.value)) return;
    credentialId.value =
      matching.value.find((c) => props.preferred.includes(c.id))?.id ?? matching.value[0]?.id ?? '';
  },
  { immediate: true },
);
const poller = ref('');
const pollerOk = computed(() => /^[0-9A-Fa-f.:]*$/.test(poller.value.trim()));

const commands = ref('');
const error = ref('');
let seq = 0;
watch(
  [platform, credentialId, poller],
  async () => {
    const mine = ++seq;
    commands.value = '';
    error.value = '';
    if (!credentialId.value || !pollerOk.value) return;
    try {
      const r = await networkApi.setupCommands(
        platform.value,
        credentialId.value,
        poller.value.trim(),
      );
      if (mine === seq) commands.value = r.commands;
    } catch (err) {
      if (mine === seq) error.value = err instanceof Error ? err.message : t('netAdd.setup.failed');
    }
  },
  { immediate: true },
);

function onKey(e: KeyboardEvent, i: number) {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  platform.value = PLATFORMS[(i + d + PLATFORMS.length) % PLATFORMS.length]!;
  (e.currentTarget as HTMLElement).parentElement
    ?.querySelectorAll('button')
    [PLATFORMS.indexOf(platform.value)]?.focus();
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="setup-commands">
    <div
      role="tablist"
      class="flex gap-1 overflow-x-auto border-b border-border"
      :aria-label="$t('netAdd.setup.title')"
    >
      <button
        v-for="(p, i) in PLATFORMS"
        :key="p"
        type="button"
        role="tab"
        :aria-selected="platform === p"
        :tabindex="platform === p ? 0 : -1"
        class="-mb-px h-9 shrink-0 border-b-2 px-3 text-13 font-medium max-lg:h-11"
        :class="
          platform === p
            ? 'border-primary text-text'
            : 'border-transparent text-text-muted hover:text-text'
        "
        @click="platform = p"
        @keydown="onKey($event, i)"
      >
        {{ $t(`netAdd.setup.platforms.${p}`) }}
      </button>
    </div>
    <div role="tabpanel" class="flex flex-col gap-3">
      <p v-if="!matching.length" class="text-13 text-text-muted">
        {{ $t(platform === 'routeros' ? 'netAdd.setup.needRouteros' : 'netAdd.setup.needSnmp') }}
      </p>
      <template v-else>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label for="setup-cred" class="text-13 font-medium text-text">{{
              $t('netAdd.setup.profile')
            }}</label>
            <select
              id="setup-cred"
              v-model="credentialId"
              class="h-9 rounded-control border border-border bg-surface-3 px-3 text-14 text-text max-lg:h-11 max-md:text-16"
            >
              <option v-for="c in matching" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <TextField
            v-model="poller"
            :label="$t('netAdd.setup.poller')"
            :hint="$t('netAdd.setup.pollerHint')"
            :error="pollerOk ? undefined : $t('netAdd.setup.pollerBad')"
            placeholder="10.0.10.5"
            :maxlength="64"
          />
        </div>
        <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
        <CodeBlock
          v-else-if="commands"
          :code="commands"
          :label="$t(`netAdd.setup.platforms.${platform}`)"
          wrap
        />
      </template>
    </div>
  </div>
</template>
