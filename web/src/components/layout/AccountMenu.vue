<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronsUpDown, ExternalLink, Monitor, Moon, Sun } from '@lucide/vue';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useTheme, type ThemeChoice } from '@/composables/useTheme';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';
import { usePlanStore } from '@/stores/plan';

// The account button and its menu (0.10.1, design/cloud Sidebar): the user row is one button
// ("Account, tokens, sign out") that opens a menu above it, or to the right of the collapsed
// rail's avatar. Reka's menu gives aria-haspopup/aria-expanded, role="menu", Esc and a click
// outside to close, arrow keys and focus back on the button; a navigation closes it too.
// Each item links to a page that exists today; one an edition lacks is left out (Community has
// no account page and no billing). The Theme row (0.12.0, ADR-228) is a radio group of three
// icon buttons in one row; picking one applies it at once and keeps the menu open.
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

const { choice } = useTheme();
const themes: { value: ThemeChoice; icon: typeof Monitor; label: string }[] = [
  { value: 'system', icon: Monitor, label: 'account.theme.system' },
  { value: 'light', icon: Sun, label: 'account.theme.light' },
  { value: 'dark', icon: Moon, label: 'account.theme.dark' },
];
const pickTheme = (v: string) => void auth.setTheme(v as ThemeChoice);
/** The row reads left to right: Left and Right move along it as Up and Down do. */
function onThemeKey(e: KeyboardEvent) {
  const key = e.key === 'ArrowLeft' ? 'ArrowUp' : e.key === 'ArrowRight' ? 'ArrowDown' : null;
  if (!key) return;
  const buttons = [
    ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ];
  const at = buttons.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const next = buttons[at + (key === 'ArrowUp' ? -1 : 1)];
  next?.focus();
}

// The colour stays out of the shared classes, so Sign out's danger colour isn't overridden.
const item =
  'flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 text-14 outline-none data-[highlighted]:bg-surface-3';
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
        'flex w-full items-center gap-2 rounded-card border border-border px-2 text-left transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2',
        drawer ? 'min-h-14 py-2' : 'py-2',
      ]"
    >
      <span
        class="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-13 font-semibold text-text"
        aria-hidden="true"
        >{{ initial }}</span
      >
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-14 font-semibold text-text">{{ user.name }}</span>
        <span class="truncate text-12 text-text-muted">{{ $t('sidebar.account.hint') }}</span>
      </span>
      <ChevronsUpDown class="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
    </DropdownMenuTrigger>
    <!-- In the phone drawer (a dialog) the menu stays inside it, so its focus trap allows it. -->
    <DropdownMenuPortal :disabled="drawer">
      <DropdownMenuContent
        data-testid="account-menu"
        :aria-label="$t('account.menuLabel')"
        :side="collapsed ? 'right' : 'top'"
        :align="collapsed ? 'end' : 'start'"
        :side-offset="collapsed ? 16 : 6"
        :collision-padding="8"
        :class="[
          'z-[60] flex flex-col gap-px rounded-card border border-border-strong bg-surface-2 p-1.5 shadow-menu',
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
          <RouterLink
            :to="i.to"
            :class="[item, itemHeight, 'text-text']"
            :data-testid="`account-${i.key}`"
            >{{ i.label }}</RouterLink
          >
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <div
          class="flex items-center justify-between gap-3 px-2.5"
          :class="itemHeight"
          data-testid="account-theme"
        >
          <span id="account-theme-label" class="text-14 text-text">{{
            $t('account.theme.label')
          }}</span>
          <DropdownMenuRadioGroup
            :model-value="choice"
            aria-labelledby="account-theme-label"
            class="flex gap-0.5 rounded-control bg-surface-3 p-0.5"
            @update:model-value="pickTheme"
            @keydown="onThemeKey"
          >
            <DropdownMenuRadioItem
              v-for="th in themes"
              :key="th.value"
              :value="th.value"
              :aria-label="$t(th.label)"
              :title="$t(th.label)"
              :data-testid="`theme-${th.value}`"
              :class="[
                'flex cursor-pointer items-center justify-center rounded-control text-text-muted hover:text-text data-[highlighted]:text-text data-[state=checked]:bg-surface-1 data-[state=checked]:text-text data-[state=checked]:shadow-segment',
                drawer ? 'size-11' : 'h-8 w-9 max-sm:size-11',
              ]"
              @select="(e: Event) => e.preventDefault()"
            >
              <component :is="th.icon" class="size-4" aria-hidden="true" />
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </div>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <DropdownMenuItem as-child>
          <a
            :href="LINKS.docs"
            target="_blank"
            rel="noopener"
            :class="[item, itemHeight, 'text-text']"
            data-testid="account-docs"
          >
            <span class="flex-1">{{ $t('sidebar.account.docs') }}</span>
            <ExternalLink class="size-3.5 text-text-subtle" aria-hidden="true" />
            <span class="sr-only">{{ $t('common.newTab') }}</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <DropdownMenuItem
          :class="[item, itemHeight, 'text-critical-text data-[highlighted]:text-critical-text']"
          data-testid="sign-out"
          @select="emit('signOut')"
        >
          {{ $t('account.signOut') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
