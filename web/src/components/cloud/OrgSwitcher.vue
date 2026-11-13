<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Building2 } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { cloudErrorKey } from '@/api/cloud';
import ComboBox from '@/components/ui/ComboBox.vue';
import { useAuthStore } from '@/stores/auth';
import { useOrgsStore } from '@/stores/orgs';
import { useToastStore } from '@/stores/toast';

// The org switcher (Cloud, ADR-175): in the header when the user belongs to two or more
// orgs. The same searchable list as the cluster switcher, so the keyboard and screen-reader
// behaviour is the same; choosing an org reloads the app in it.
defineProps<{ variant?: 'field' | 'toolbar' }>();
const { t } = useI18n();
const auth = useAuthStore();
const orgs = useOrgsStore();
const toast = useToastStore();
const switching = ref(false);

const current = computed(() => orgs.list.find((o) => o.current) ?? null);
const options = computed(() =>
  orgs.list.map((o) => ({
    value: o.id,
    label: o.name,
    description: t(`users.roles.${o.role}.name`),
  })),
);
async function choose(id: string | null) {
  if (!id || id === current.value?.id || switching.value) return;
  switching.value = true;
  try {
    await orgs.switchTo(id);
  } catch (err) {
    toast.show(t(cloudErrorKey(err)), 'warning');
    switching.value = false;
  }
}
onMounted(() => {
  if (auth.isCloud && auth.user && !orgs.loaded) void orgs.load();
});
</script>

<template>
  <ComboBox
    v-if="orgs.list.length >= 2"
    :model-value="current?.id ?? null"
    :options="options"
    :label="$t('cloud.orgs.label')"
    :icon="Building2"
    :variant="variant ?? 'toolbar'"
    :disabled="switching"
    testid="org-switcher"
    @update:model-value="choose"
  />
</template>
