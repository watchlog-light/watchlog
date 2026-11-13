<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleAlert, CirclePause, Trash2 } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { cloudApi, cloudErrorKey } from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useAuthStore } from '@/stores/auth';
import { useOrgStatusStore } from '@/stores/orgStatus';
import { useToastStore } from '@/stores/toast';

// The org's state (ADR-181), Cloud only, over every page:
//   - scheduled for deletion: the day, that agents' data isn't stored, Undo for Owners;
//   - suspended: for inactivity (Owners reactivate it) or by WatchLog staff (the reason);
//   - no data for 30 days: the day it will be suspended, and the way to keep it.
// Plain words, one action, and a link to Settings › Data for export and deletion.
const { t } = useI18n();
const auth = useAuthStore();
const store = useOrgStatusStore();
const toast = useToastStore();
const DATA = { name: 'settings', query: { tab: 'data' } } as const;

const isOwner = computed(() => auth.user?.role === 'owner' && !auth.support);
const org = computed(() => auth.user?.org.name ?? '');
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

const view = computed(() => {
  const s = store.status;
  if (!s) return null;
  if (s.deletion) {
    return {
      kind: 'deletion' as const,
      text: t('cloud.dataRights.banner.deletion', {
        org: org.value,
        date: day(s.deletion.dueAt),
      }),
    };
  }
  if (s.suspension?.kind === 'inactive') {
    return {
      kind: 'inactive' as const,
      text: t('cloud.dataRights.banner.suspendedInactive', { org: org.value }),
    };
  }
  if (s.suspension) {
    return {
      kind: 'staff' as const,
      text: s.suspension.reason
        ? t('cloud.dataRights.banner.suspendedStaff', {
            org: org.value,
            reason: s.suspension.reason,
          })
        : t('cloud.dataRights.banner.suspendedStaffNoReason', { org: org.value }),
    };
  }
  if (s.inactivity) {
    return {
      kind: 'warning' as const,
      text: t('cloud.dataRights.banner.inactive', {
        org: org.value,
        date: day(s.inactivity.suspendsAt),
      }),
    };
  }
  return null;
});

const busy = ref(false);
async function act() {
  const v = view.value;
  if (!v) return;
  busy.value = true;
  try {
    if (v.kind === 'deletion') {
      store.set(await cloudApi.undoDeletion());
      toast.show(t('cloud.dataRights.undone'));
    } else if (v.kind === 'inactive') {
      store.set(await cloudApi.reactivate());
      toast.show(t('cloud.dataRights.reactivated'));
    }
  } catch (err) {
    toast.show(t(cloudErrorKey(err)), 'warning');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    v-if="view"
    :class="[
      'flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 text-13 text-text md:px-6',
      view.kind === 'deletion'
        ? 'border-critical/40 bg-critical/10'
        : 'border-warning/40 bg-warning/10',
    ]"
    role="region"
    :aria-label="$t('cloud.dataRights.banner.label')"
    :data-testid="`org-status-banner-${view.kind}`"
  >
    <Trash2
      v-if="view.kind === 'deletion'"
      class="size-4 shrink-0 text-critical"
      aria-hidden="true"
    />
    <CirclePause
      v-else-if="view.kind === 'inactive' || view.kind === 'staff'"
      class="size-4 shrink-0 text-warning"
      aria-hidden="true"
    />
    <CircleAlert v-else class="size-4 shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-0 flex-1">
      {{ view.text }}
      <span
        v-if="!isOwner && (view.kind === 'deletion' || view.kind === 'inactive')"
        class="text-text-muted"
      >
        {{ $t('cloud.dataRights.banner.askOwner') }}
      </span>
    </p>
    <div class="flex items-center gap-3 max-sm:basis-full max-sm:pl-7">
      <RouterLink
        v-if="view.kind !== 'staff'"
        :to="DATA"
        class="font-semibold whitespace-nowrap text-primary hover:text-primary-hover"
      >
        {{ $t('cloud.dataRights.banner.manage') }}
      </RouterLink>
      <BaseButton
        v-if="isOwner && (view.kind === 'deletion' || view.kind === 'inactive')"
        variant="secondary"
        :loading="busy"
        data-testid="org-status-action"
        @click="act"
      >
        {{
          view.kind === 'deletion' ? $t('cloud.dataRights.undo') : $t('cloud.dataRights.reactivate')
        }}
      </BaseButton>
    </div>
  </div>
</template>
