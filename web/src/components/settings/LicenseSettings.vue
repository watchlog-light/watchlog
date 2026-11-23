<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { LicenseView } from '@watchlog/api-types';
import { CircleCheck, CircleX, Clock, KeyRound, TriangleAlert } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';
import { featureNames, licenseDate, stateTone, unitParts } from '@/lib/license';

// Settings → License (ADR-232), Owners of a self-hosted install: who the licence is for, its
// edition, units used of allowed, its features, when it ends, its id, where the key came from
// and its state in words. A key pasted here is checked at once, offline; the environment's
// key (WATCHLOG_LICENSE or WATCHLOG_LICENSE_FILE) wins, and the page says so.
const { t } = useI18n();
const auth = useAuthStore();
const page = useLoader(() => api<LicenseView>('/license'));
const v = computed(() => page.data.value ?? null);
const fromEnv = computed(() => v.value?.source === 'env' || v.value?.source === 'file');
const key = ref('');
const saving = ref(false);
const error = ref<string>();
const removing = ref(false);

async function paste() {
  error.value = undefined;
  if (!key.value.trim()) {
    error.value = t('license.paste.empty');
    return;
  }
  saving.value = true;
  try {
    page.data.value = await api<LicenseView>('/license', {
      method: 'PUT',
      body: { key: key.value.trim() },
    });
    key.value = '';
    await auth.loadLicense();
  } catch (err) {
    error.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('license.paste.failed');
  } finally {
    saving.value = false;
  }
}

async function remove() {
  page.data.value = await api<LicenseView>('/license', { method: 'DELETE' });
  await auth.loadLicense();
}

const TONE_ICON = { ok: CircleCheck, warn: Clock, bad: TriangleAlert, none: CircleX } as const;
const tone = computed(() => stateTone(v.value?.state ?? 'none'));
const stateText = computed(() => {
  const x = v.value;
  if (!x) return '';
  const l = x.license;
  switch (x.state) {
    case 'valid':
      return t('license.state.valid', { date: licenseDate(l!.expiresAt) });
    case 'expiring':
      return t('license.state.expiring', { date: licenseDate(l!.expiresAt) });
    case 'grace':
      return t('license.state.grace', {
        date: licenseDate(l!.expiresAt),
        stops: licenseDate(l!.graceEndsAt),
      });
    case 'expired':
      return t('license.state.expired', { date: licenseDate(l!.expiresAt) });
    case 'invalid':
      return t('license.state.invalid', { reason: x.reason });
    default:
      return t('license.state.none');
  }
});
const sourceText = computed(() => (v.value ? t(`license.source.${v.value.source}`) : ''));

onMounted(page.load);
</script>

<template>
  <section class="flex max-w-3xl flex-col gap-4" data-testid="license-settings">
    <ErrorState
      v-if="page.error.value"
      :message="$t('license.loadFailed')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="rounded-card border border-border bg-surface-1 p-5">
      <Skeleton class="w-40 text-14" />
      <Skeleton shape="rect" class="mt-3 h-24 w-full" />
    </div>

    <template v-else-if="v">
      <div class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-16 font-semibold text-text">{{ $t('license.title') }}</h2>
            <p class="mt-1 text-13 text-text-muted">{{ $t('license.intro') }}</p>
          </div>
          <span
            :class="[
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-13 font-medium',
              tone === 'ok'
                ? 'border-ok/40 bg-ok/10 text-ok-text'
                : tone === 'warn'
                  ? 'border-warning/40 bg-warning/10 text-warning-text'
                  : tone === 'bad'
                    ? 'border-critical/40 bg-critical/10 text-critical-text'
                    : 'border-border bg-surface-2 text-text-muted',
            ]"
            data-testid="license-state"
            :data-state="v.state"
          >
            <component :is="TONE_ICON[tone]" class="size-4" aria-hidden="true" />
            {{ $t(`license.stateShort.${v.state}`) }}
          </span>
        </div>
        <p class="text-14 text-text" data-testid="license-state-text">{{ stateText }}</p>

        <dl
          v-if="v.license"
          class="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2.5 text-14 max-sm:grid-cols-1 max-sm:gap-y-1"
          data-testid="license-facts"
        >
          <dt class="text-text-muted">{{ $t('license.facts.customer') }}</dt>
          <dd class="font-semibold text-text max-sm:mb-2" data-testid="license-customer">
            {{ v.license.customer }}
          </dd>
          <dt class="text-text-muted">{{ $t('license.facts.edition') }}</dt>
          <dd class="text-text max-sm:mb-2">{{ $t('license.edition.enterprise') }}</dd>
          <dt class="text-text-muted">{{ $t('license.facts.units') }}</dt>
          <dd class="max-sm:mb-2" data-testid="license-units">
            <span :class="v.units?.over ? 'font-semibold text-warning-text' : 'text-text'">{{
              $t('license.units.used', { used: v.units?.used ?? 0, limit: v.license.units })
            }}</span>
            <span v-if="v.units" class="block text-13 text-text-muted">{{
              unitParts(v.units.parts, t)
            }}</span>
          </dd>
          <dt class="text-text-muted">{{ $t('license.facts.features') }}</dt>
          <dd class="flex flex-wrap gap-1.5 max-sm:mb-2" data-testid="license-features">
            <span
              v-for="f in featureNames(v.license.features, t)"
              :key="f"
              class="rounded-control border border-border bg-surface-2 px-2 py-0.5 text-13 text-text"
              >{{ f }}</span
            >
          </dd>
          <dt class="text-text-muted">{{ $t('license.facts.expires') }}</dt>
          <dd class="text-text max-sm:mb-2" data-testid="license-expires">
            {{ licenseDate(v.license.expiresAt) }}
            <span class="text-13 text-text-muted">{{
              $t('license.facts.grace', { date: licenseDate(v.license.graceEndsAt) })
            }}</span>
          </dd>
          <dt class="text-text-muted">{{ $t('license.facts.id') }}</dt>
          <dd class="font-mono text-13 break-all text-text max-sm:mb-2" data-testid="license-id">
            {{ v.license.id }}
          </dd>
          <dt class="text-text-muted">{{ $t('license.facts.source') }}</dt>
          <dd class="text-text" data-testid="license-source">{{ sourceText }}</dd>
        </dl>

        <p
          v-if="v.units?.over && v.license"
          class="flex gap-2 rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-13 text-text"
          data-testid="license-over"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden="true" />
          <span>
            {{ $t('license.over.line', { used: v.units.used, limit: v.units.limit }) }}
            <template v-if="v.units.closedSince">
              {{ $t('license.over.closed', { date: v.units.closedSince }) }}</template
            >
            <template v-else>{{ $t('license.over.rule') }}</template>
          </span>
        </p>
        <p v-if="fromEnv" class="text-13 text-text-muted" data-testid="license-from-env">
          {{ $t('license.fromEnv') }}
          <template v-if="v.shadowed">{{ $t('license.shadowed') }}</template>
        </p>
      </div>

      <form
        v-if="!fromEnv"
        class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-5"
        novalidate
        @submit.prevent="paste"
      >
        <div>
          <h3 class="flex items-center gap-2 text-15 font-semibold text-text">
            <KeyRound class="size-4 text-text-muted" aria-hidden="true" />
            {{ v.license ? $t('license.paste.titleReplace') : $t('license.paste.title') }}
          </h3>
          <p class="mt-1 text-13 text-text-muted">{{ $t('license.paste.intro') }}</p>
        </div>
        <label class="flex flex-col gap-1.5">
          <span class="text-13 font-medium text-text">{{ $t('license.paste.label') }}</span>
          <textarea
            v-model="key"
            rows="3"
            spellcheck="false"
            autocomplete="off"
            :class="[
              'w-full rounded-control border bg-surface-3 px-3 py-2 font-mono text-13 break-all text-text placeholder:text-text-subtle focus:border-border-strong max-md:text-16',
              error ? 'border-critical' : 'border-border',
            ]"
            placeholder="wl1.…"
            :aria-invalid="!!error"
            aria-describedby="license-paste-error"
            data-testid="license-key"
          />
        </label>
        <p
          v-if="error"
          id="license-paste-error"
          class="text-13 text-critical-text"
          role="alert"
          data-testid="license-error"
        >
          {{ error }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <BaseButton type="submit" :loading="saving" data-testid="license-save">
            {{ $t('license.paste.save') }}
          </BaseButton>
          <BaseButton
            v-if="v.source === 'setting'"
            variant="secondary"
            data-testid="license-remove"
            @click="removing = true"
          >
            {{ $t('license.remove.button') }}
          </BaseButton>
        </div>
      </form>
      <p class="text-13 text-text-muted">
        {{ $t('license.help') }}
        <a
          href="https://watchlog.io/docs/license/"
          target="_blank"
          rel="noopener"
          class="text-link hover:underline"
          >{{ $t('license.docs') }}</a
        >
      </p>
    </template>

    <ConfirmDialog
      v-model:open="removing"
      :title="$t('license.remove.title')"
      :lines="[$t('license.remove.line')]"
      :confirm-label="$t('license.remove.confirm')"
      :action="remove"
      testid="license-remove"
    />
  </section>
</template>
