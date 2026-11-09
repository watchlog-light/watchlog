<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { DiscoveredList, DiscoveredService } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import DiscoveredRow from '@/components/applications/DiscoveredRow.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import LockedControl from '@/components/ui/LockedControl.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { useToastStore } from '@/stores/toast';

// Services the agents see that aren't monitored (ADR-132), below the monitored ones so a
// long list never pushes them off screen: three at first, all on "Show all", grouped by
// namespace or Compose project there so a whole group can be ignored at once. Ignored
// ones are listed under it, to restore.
const props = defineProps<{
  discovered: DiscoveredService[];
  ignored: DiscoveredList['ignored'];
}>();
const emit = defineEmits<{ monitor: [service: DiscoveredService]; changed: [] }>();
const { t } = useI18n();
const toast = useToastStore();

const PREVIEW = 3;
const expanded = ref(false);
const showIgnored = ref(false);
const busy = ref<string | null>(null);

/** Expanded: by cluster, then namespace or project; a container without one is its own. */
const groups = computed(() => {
  const by = new Map<
    string,
    {
      id: string;
      title: string;
      group: string | null;
      kind: string;
      clusterId: string;
      rows: DiscoveredService[];
    }
  >();
  for (const d of props.discovered) {
    const id = `${d.cluster.id}/${d.group}`;
    let g = by.get(id);
    if (!g) {
      g = {
        id,
        clusterId: d.cluster.id,
        kind: d.cluster.kind,
        group: d.group || null,
        title: d.group
          ? `${d.cluster.name} · ${t(d.cluster.kind === 'kubernetes' ? 'applications.discovered.groupKubernetes' : 'applications.discovered.groupDocker', { group: d.group })}`
          : `${d.cluster.name} · ${t('applications.discovered.standalone')}`,
        rows: [],
      };
      by.set(id, g);
    }
    g.rows.push(d);
  }
  return [...by.values()];
});
const preview = computed(() => props.discovered.slice(0, PREVIEW));

async function ignore(body: { clusterId: string; key?: string; group?: string }, name: string) {
  busy.value = body.key ?? `${body.clusterId}/${body.group}`;
  try {
    await api('/applications/discovered/ignore', { method: 'POST', body });
    toast.show(t('applications.discovered.ignoredDone', { name }));
    emit('changed');
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    busy.value = null;
  }
}
async function restore(id: string, name: string) {
  busy.value = id;
  try {
    await api(`/applications/discovered/ignore/${id}`, { method: 'DELETE' });
    toast.show(t('applications.discovered.restoredDone', { name }));
    emit('changed');
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    busy.value = null;
  }
}
/** "Ignore all from namespace shop": the toast and the screen reader's label. */
const groupLabel = (g: { kind: string; group: string | null }) =>
  t(
    g.kind === 'kubernetes'
      ? 'applications.discovered.ignoreGroupNameKubernetes'
      : 'applications.discovered.ignoreGroupNameDocker',
    { group: g.group },
  );
</script>

<template>
  <section
    :aria-label="$t('applications.discovered.title', { n: discovered.length }, discovered.length)"
    class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 px-4 py-3.5 sm:px-5"
    data-testid="discovered"
  >
    <div v-if="discovered.length" class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span class="size-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
      <span class="text-14 font-semibold text-text">{{
        $t('applications.discovered.title', { n: discovered.length }, discovered.length)
      }}</span>
      <span class="text-13 text-text-muted">{{ $t('applications.discovered.from') }}</span>
    </div>

    <ul v-if="!expanded && discovered.length" class="flex flex-col gap-2">
      <li v-for="d in preview" :key="d.key">
        <DiscoveredRow
          :service="d"
          :show-where="true"
          :busy="busy === d.key"
          @ignore="ignore({ clusterId: d.cluster.id, key: d.key }, d.name)"
          @monitor="emit('monitor', d)"
        />
      </li>
    </ul>

    <div v-else class="flex flex-col gap-4">
      <div
        v-for="g in groups"
        :key="g.id"
        class="flex flex-col gap-2"
        data-testid="discovered-group"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span
            class="min-w-0 text-12 font-medium tracking-wider break-all text-text-muted uppercase"
            >{{ g.title }}</span
          >
          <LockedControl v-if="g.group">
            <BaseButton
              variant="ghost"
              :loading="busy === g.id"
              :aria-label="groupLabel(g)"
              data-testid="ignore-group"
              @click="ignore({ clusterId: g.clusterId, group: g.group }, groupLabel(g))"
            >
              {{
                $t(
                  g.kind === 'kubernetes'
                    ? 'applications.discovered.ignoreGroupKubernetes'
                    : 'applications.discovered.ignoreGroupDocker',
                )
              }}
            </BaseButton>
          </LockedControl>
        </div>
        <ul class="flex flex-col gap-2">
          <li v-for="d in g.rows" :key="d.key">
            <DiscoveredRow
              :service="d"
              :show-where="false"
              :busy="busy === d.key"
              @ignore="ignore({ clusterId: d.cluster.id, key: d.key }, d.name)"
              @monitor="emit('monitor', d)"
            />
          </li>
        </ul>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      <BaseButton
        v-if="discovered.length > PREVIEW"
        variant="secondary"
        :aria-expanded="expanded"
        data-testid="discovered-toggle"
        @click="expanded = !expanded"
      >
        {{
          expanded
            ? $t('applications.discovered.showFewer')
            : $t('applications.discovered.showAll', { n: discovered.length })
        }}
      </BaseButton>
      <span v-if="ignored.length" class="flex items-center gap-1 text-13 text-text-muted">
        {{ $t('applications.discovered.ignored', { n: ignored.length }, ignored.length) }} ·
        <button
          type="button"
          class="min-h-11 min-w-11 px-1 font-medium text-text underline-offset-2 hover:underline lg:min-h-0"
          :aria-expanded="showIgnored"
          data-testid="ignored-toggle"
          @click="showIgnored = !showIgnored"
        >
          {{
            showIgnored
              ? $t('applications.discovered.hideIgnored')
              : $t('applications.discovered.showIgnored')
          }}
        </button>
      </span>
    </div>
    <ul
      v-if="showIgnored && ignored.length"
      class="flex flex-col gap-1.5"
      data-testid="ignored-list"
    >
      <li
        v-for="i in ignored"
        :key="i.id"
        class="flex flex-wrap items-center justify-between gap-2 text-13 text-text-muted"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <component :is="KIND_LOGO[i.cluster.kind]" class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="truncate">{{ i.cluster.name }} · {{ i.label }}</span>
        </span>
        <LockedControl>
          <BaseButton
            variant="ghost"
            :loading="busy === i.id"
            :aria-label="$t('applications.discovered.restoreName', { name: i.label })"
            data-testid="restore"
            @click="restore(i.id, i.label)"
          >
            {{ $t('applications.discovered.restore') }}
          </BaseButton>
        </LockedControl>
      </li>
    </ul>
  </section>
</template>
