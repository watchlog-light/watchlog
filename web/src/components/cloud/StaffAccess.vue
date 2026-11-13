<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { LifeBuoy } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { cloudApi, cloudErrorKey, type SupportSession } from '@/api/cloud';
import FormAlert from '@/components/cloud/FormAlert.vue';
import InfoTag from '@/components/cloud/InfoTag.vue';

// Settings › Security, Owners (ADR-179): every support session WatchLog staff opened in this
// organization: who, when, why, and the pages' API paths it opened. Sessions are read-only
// and last at most an hour; the Owners also get an email when one starts.
const sessions = ref<SupportSession[] | null>(null);
const error = ref<string>();
const open = ref<string | null>(null);

onMounted(async () => {
  try {
    sessions.value = (await cloudApi.supportSessions()).sessions;
  } catch (err) {
    error.value = cloudErrorKey(err);
  }
});

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function state(s: SupportSession): 'active' | 'ended' | 'unused' {
  if (!s.endedAt && Date.parse(s.expiresAt) > Date.now()) return s.enteredAt ? 'active' : 'unused';
  return s.enteredAt ? 'ended' : 'unused';
}
const end = (s: SupportSession) =>
  s.endedAt && Date.parse(s.endedAt) < Date.parse(s.expiresAt) ? s.endedAt : s.expiresAt;
</script>

<template>
  <section
    class="rounded-card border border-border bg-surface-1 p-4 md:p-5"
    aria-labelledby="sec-staff"
    data-testid="staff-access"
  >
    <div class="flex items-start gap-3">
      <LifeBuoy class="mt-0.5 size-5 shrink-0 text-text-muted" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <h2 id="sec-staff" class="text-16 font-semibold text-text">
          {{ $t('cloud.support.title') }}
        </h2>
        <p class="mt-1 text-13 text-text-muted">{{ $t('cloud.support.intro') }}</p>
      </div>
    </div>
    <FormAlert v-if="error" class="mt-3">{{ $t(error) }}</FormAlert>
    <p v-else-if="!sessions" class="mt-3 text-13 text-text-muted">{{ $t('common.loading') }}</p>
    <p
      v-else-if="sessions.length === 0"
      class="mt-3 text-13 text-text-muted"
      data-testid="staff-access-none"
    >
      {{ $t('cloud.support.none') }}
    </p>
    <ul v-else class="mt-3 flex flex-col divide-y divide-border" data-testid="staff-sessions">
      <li v-for="s in sessions" :key="s.id" class="py-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p class="min-w-0 flex-1 text-14 text-text">
            <span class="break-all">{{ s.staffEmail }}</span>
            <span class="text-text-muted">
              · {{ $t('cloud.support.when', { start: when(s.startedAt), end: time(end(s)) }) }}
            </span>
          </p>
          <InfoTag
            :tone="state(s) === 'active' ? 'ok' : 'neutral'"
            :label="$t(`cloud.support.state.${state(s)}`)"
          />
        </div>
        <p class="mt-1 text-13 text-text">
          {{ $t('cloud.support.why', { reason: s.reason }) }}
        </p>
        <button
          v-if="s.opened.length"
          type="button"
          class="mt-1 min-h-8 text-13 text-primary hover:underline max-lg:min-h-11"
          :aria-expanded="open === s.id"
          @click="open = open === s.id ? null : s.id"
        >
          {{ $t('cloud.support.opened', { n: s.opened.length }, s.opened.length) }}
        </button>
        <p v-else class="mt-1 text-12 text-text-muted">{{ $t('cloud.support.openedNone') }}</p>
        <ul
          v-if="open === s.id"
          class="mt-2 flex flex-col gap-1 rounded-control bg-surface-2 p-2"
          data-testid="staff-opened"
        >
          <li
            v-for="v in s.opened"
            :key="v.path"
            class="flex flex-wrap gap-x-3 font-mono text-12 text-text-muted"
          >
            <span class="min-w-0 flex-1 break-all text-text">{{ v.path }}</span>
            <span
              >{{ time(v.at) }}<template v-if="v.count > 1"> · ×{{ v.count }}</template></span
            >
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
