<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { networkApi } from '../../api';
import { feedGroups, feedKey, type FeedHost } from '../../lib/storage';

// Which servers and nodes a UPS powers (ADR-234), for Owners and Admins: the hosts whose agents
// report, grouped by cluster or fleet, ticked and saved.
const props = defineProps<{ upsId: string; feeds: { clusterId: string; node: string }[] }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const hosts = ref<FeedHost[] | null>(null);
const loadFailed = ref(false);
const picked = ref(new Set(props.feeds.map(feedKey)));
const saving = ref(false);
const saveFailed = ref(false);

onMounted(async () => {
  try {
    hosts.value = (await networkApi.feedOptions()).hosts;
  } catch {
    loadFailed.value = true;
  }
});
// Feeds already set but whose agents no longer report stay listed, so a save doesn't drop them
// silently.
const groups = computed(() => {
  const known = new Set((hosts.value ?? []).map(feedKey));
  const extra = props.feeds
    .filter((f) => !known.has(feedKey(f)))
    .map((f) => ({ clusterId: f.clusterId, node: f.node, cluster: f.clusterId, kind: '' }));
  return feedGroups([...(hosts.value ?? []), ...extra]);
});

function toggle(k: string, on: boolean) {
  const next = new Set(picked.value);
  if (on) next.add(k);
  else next.delete(k);
  picked.value = next;
}

async function save() {
  saving.value = true;
  saveFailed.value = false;
  try {
    const feeds = groups.value.flatMap((g) =>
      g.nodes
        .filter((n) => picked.value.has(feedKey({ clusterId: g.clusterId, node: n })))
        .map((node) => ({ clusterId: g.clusterId, node })),
    );
    await networkApi.setFeeds(props.upsId, feeds);
    emit('saved');
  } catch {
    saveFailed.value = true;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form
    class="flex flex-col gap-3 rounded-control border border-border bg-surface-2 p-3"
    data-testid="ups-feeds-editor"
    @submit.prevent="save"
  >
    <p v-if="loadFailed" class="text-13 text-critical-text" role="alert">
      {{ $t('netStorage.ups.feedsLoadError') }}
    </p>
    <p v-else-if="!hosts" class="text-13 text-text-muted">{{ $t('common.loading') }}</p>
    <p v-else-if="!groups.length" class="text-13 text-text-muted">
      {{ $t('netStorage.ups.feedsNone') }}
    </p>
    <fieldset v-for="g in groups" :key="g.clusterId" class="flex flex-col gap-1">
      <legend class="mb-1 text-12 font-semibold text-text-muted">
        {{ g.cluster
        }}<template v-if="g.kind">
          ·
          {{
            $t(`netStorage.ups.place.${g.kind === 'kubernetes' ? 'kubernetes' : 'server'}`)
          }}</template
        >
      </legend>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1">
        <label
          v-for="n in g.nodes"
          :key="n"
          class="flex min-h-9 cursor-pointer items-center gap-2 rounded-control px-2 text-13 text-text hover:bg-surface-3 max-md:min-h-11"
        >
          <input
            type="checkbox"
            class="size-4 accent-primary"
            :checked="picked.has(feedKey({ clusterId: g.clusterId, node: n }))"
            @change="
              toggle(
                feedKey({ clusterId: g.clusterId, node: n }),
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
          <span class="truncate font-mono">{{ n }}</span>
        </label>
      </div>
    </fieldset>
    <p v-if="saveFailed" class="text-13 text-critical-text" role="alert">
      {{ $t('netStorage.ups.feedsSaveError') }}
    </p>
    <div class="flex flex-wrap gap-2">
      <BaseButton type="submit" :loading="saving" :disabled="!hosts" data-testid="ups-feeds-save">{{
        $t('netStorage.ups.feedsSave')
      }}</BaseButton>
      <BaseButton variant="secondary" @click="emit('cancel')">{{
        $t('netStorage.ups.feedsCancel')
      }}</BaseButton>
    </div>
  </form>
</template>
