<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronsUpDown, ExternalLink } from '@lucide/vue';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';

// The account button and its menu (0.10.1, design/cloud Sidebar): the user row is one button
// ("Account, tokens, sign out") that opens a menu above it, or to the right of the collapsed
// rail's avatar. Reka's menu gives aria-haspopup/aria-expanded, role="menu", Esc and a click
// outside to close, arrow keys and focus back on the button; a navigation closes it too.
// Each item links to a page that exists today; one an edition lacks is left out (Community has
// no account page and no billing).
const props = defineProps<{ collapsed?: boolean; drawer?: boolean }>();
const emit = defineEmits<{ signOut: [] }>();
const auth = useAuthStore();
const plan = usePlanStore();
const { t } = useI18n();
const route = useRoute();
const open = ref(false);
watch(
  () => route.fullPath,
  () => (open.value = false),
);

const user = computed(() => auth.user);
const initial = computed(() => (user.value?.name ?? '?').charAt(0).toUpperCase());
/** "acme · Owner · Pro" in Cloud; Community's one org has no name worth showing. */
const context = computed(() => {
  const u = user.value;
  if (!u) return '';
  const role = t(`users.roles.${u.role}.name`);
  if (!auth.isCloud) return role;
  const planName = plan.info?.plan;
  return [u.org.name, role, planName ? t(`cloud.plan.short.${planName}`) : null]
    .filter(Boolean)
    .join(' · ');
});

type Item = { key: string; label: string; to: { name: string; query?: Record<string, string> } };
const items = computed<Item[]>(() => {
  const list: Item[] = [];
  if (auth.isCloud) {
    list.push({
      key: 'security',
      label: t('sidebar.account.security'),
      to: { name: 'settings', query: { tab: 'security' } },
    });
  }
  list.push({
    key: 'tokens',
    label: t('sidebar.account.tokens'),
    to: { name: 'settings', query: { tab: 'tokens' } },
  });
  if (auth.isCloud) {
    list.push({
      key: 'billing',
      label: t('sidebar.account.billing'),
      to: { name: 'settings', query: { tab: 'billing' } },
    });
  }
  return list;
});

const item =
  'flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 text-14 text-text outline-none data-[highlighted]:bg-surface-3';
const itemHeight = computed(() => (props.drawer ? 'min-h-11' : 'min-h-9'));
</script>

<template>
  <DropdownMenuRoot v-if="user" v-model:open="open">
    <DropdownMenuTrigger
      v-if="collapsed"
      data-testid="account-menu-button"
      :aria-label="$t('sidebar.account.button', { name: user.name })"
      :title="user.name"
      class="flex size-10 items-center justify-center rounded-full border border-border bg-surface-3 text-13 font-semibold text-text hover:border-border-strong"
    >
      <span aria-hidden="true">{{ initial }}</span>
    </DropdownMenuTrigger>
    <DropdownMenuTrigger
      v-else
      data-testid="account-menu-button"
      :class="[
        'flex w-full items-center gap-2.5 rounded-card border border-border px-2.5 text-left transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2',
        drawer ? 'min-h-14 py-2' : 'py-2',
      ]"
    >
      <span
        class="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-13 font-semibold text-text"
        aria-hidden="true"
        >{{ initial }}</span
      >
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-14 font-semibold text-text">{{ user.name }}</span>
        <span class="truncate text-12 text-text-muted">{{ $t('sidebar.account.hint') }}</span>
      </span>
      <ChevronsUpDown class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
    </DropdownMenuTrigger>
    <!-- In the phone drawer (a dialog) the menu stays inside it, so its focus trap allows it. -->
    <DropdownMenuPortal :disabled="drawer">
      <DropdownMenuContent
        data-testid="account-menu"
        :aria-label="$t('account.menuLabel')"
        :side="collapsed ? 'right' : 'top'"
        :align="collapsed ? 'end' : 'start'"
        :side-offset="collapsed ? 10 : 6"
        :collision-padding="8"
        :class="[
          'z-[60] flex flex-col gap-px rounded-card border border-border-strong bg-surface-2 p-1.5 shadow-xl',
          collapsed ? 'w-64' : 'w-[var(--reka-dropdown-menu-trigger-width)] min-w-56',
        ]"
      >
        <div
          class="mb-1 flex flex-col gap-0.5 border-b border-border px-2.5 pt-2 pb-2"
          data-testid="account-menu-header"
        >
          <span class="text-12 text-text-muted">{{ $t('sidebar.account.signedInAs') }}</span>
          <span class="font-mono text-13 break-all text-text" data-testid="account-menu-email">{{
            user.email
          }}</span>
          <span class="text-12 text-text-muted" data-testid="account-menu-context">{{
            context
          }}</span>
        </div>
        <DropdownMenuItem v-for="i in items" :key="i.key" as-child>
          <RouterLink :to="i.to" :class="[item, itemHeight]" :data-testid="`account-${i.key}`">{{
            i.label
          }}</RouterLink>
        </DropdownMenuItem>
        <DropdownMenuItem as-child>
          <a
            :href="LINKS.docs"
            target="_blank"
            rel="noopener"
            :class="[item, itemHeight]"
            data-testid="account-docs"
          >
            <span class="flex-1">{{ $t('sidebar.account.docs') }}</span>
            <ExternalLink class="size-3.5 text-text-subtle" aria-hidden="true" />
            <span class="sr-only">{{ $t('common.newTab') }}</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <DropdownMenuItem
          :class="[item, itemHeight, 'text-critical data-[highlighted]:text-critical']"
          data-testid="sign-out"
          @select="emit('signOut')"
        >
          {{ $t('account.signOut') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
