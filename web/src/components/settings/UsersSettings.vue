<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, Copy, Info, MailX, UserPlus, X } from '@lucide/vue';
import type { CreatedInvite, IssuedLink, UserList, UserRow, InviteRow } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { planLimitKey } from '@/api/cloud';
import { ApiError, api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LockedControl from '@/components/ui/LockedControl.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/users';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// Settings → Users (ADR-140, the Users and invites mock-up): who can open this WatchLog
// and their role, open invites, the three roles, and for Owners and Admins: invite (a
// link to copy, also emailed when SMTP is set up), change roles, reset links, remove,
// hand ownership over, and the log. Viewers see the same page with the controls locked.
const { t, tm, rt } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();
const narrow = useNarrow();

const page = useLoader(() => api<UserList>('/users'));
onMounted(page.load);
const data = computed(() => page.data.value);
const canManage = computed(() => auth.canManage);
const owner = computed(() => data.value?.users.find((u) => u.role === 'owner'));
// My role as the list has it (the session's, after a handover reloads).
const myRole = computed(() => data.value?.users.find((u) => u.you)?.role ?? auth.user?.role);
const someAdmin = computed(() => data.value?.users.find((u) => u.role === 'admin' && !u.you));

// ------------------------------------------------------------ dialogs

type Dialog =
  | { kind: 'invite' }
  | {
      kind: 'link';
      title: string;
      meta: string;
      link: string;
      emailed: boolean;
      to: string;
      reset: boolean;
      foot: string;
    }
  | { kind: 'remove'; user: UserRow }
  | { kind: 'owner'; user: UserRow };
const dialog = ref<Dialog | null>(null);
const dialogOpen = computed({
  get: () => dialog.value !== null,
  set: (v: boolean) => {
    if (!v) dialog.value = null;
  },
});
const busy = ref(false);
const copied = ref(false);

const inviteEmail = ref('');
const inviteRole = ref<'admin' | 'viewer'>('viewer');
const inviteError = ref<string>();
function openInvite() {
  inviteEmail.value = '';
  inviteRole.value = 'viewer';
  inviteError.value = undefined;
  dialog.value = { kind: 'invite' };
}

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const roleName = (r: string) => t(`users.roles.${r}.name`);

function showInviteLink(
  email: string,
  role: string,
  res: { link: string; expiresAt: string; emailed: boolean },
) {
  copied.value = false;
  dialog.value = {
    kind: 'link',
    title: t('users.link.inviteTitle', { email }),
    meta: t('users.link.inviteMeta', { role: roleName(role), date: fmtDay(res.expiresAt) }),
    link: res.link,
    emailed: res.emailed,
    to: email,
    reset: false,
    foot: t('users.link.inviteFoot'),
  };
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  try {
    return await fn();
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
    return undefined;
  } finally {
    busy.value = false;
  }
}

async function createInvite() {
  inviteError.value = undefined;
  busy.value = true;
  try {
    const res = await api<CreatedInvite>('/users/invites', {
      method: 'POST',
      body: { email: inviteEmail.value.trim(), role: inviteRole.value },
    });
    showInviteLink(res.invite.email, res.invite.role, res);
    void page.load();
  } catch (err) {
    // Cloud: over the plan's users (ADR-177) in plain words, not the server's.
    const limit = planLimitKey(err);
    inviteError.value = limit ? t(limit) : err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function copyLink(i: InviteRow) {
  const res = await run(() =>
    api<{ link: string; expiresAt: string }>(`/users/invites/${i.id}/link`, { method: 'POST' }),
  );
  if (!res) return;
  try {
    await navigator.clipboard.writeText(res.link);
    toast.show(t('users.copiedFor', { email: i.email }));
  } catch {
    showInviteLink(i.email, i.role, { ...res, emailed: false });
  }
}
async function renew(i: InviteRow) {
  const res = await run(() => api<IssuedLink>(`/users/invites/${i.id}/renew`, { method: 'POST' }));
  if (res) {
    showInviteLink(i.email, i.role, res);
    void page.load();
  }
}
async function revoke(i: InviteRow) {
  if ((await run(() => api(`/users/invites/${i.id}`, { method: 'DELETE' }))) !== undefined) {
    toast.show(
      t(i.status === 'expired' ? 'users.removedInvite' : 'users.revoked', { email: i.email }),
    );
    void page.load();
  }
}
async function setRole(u: UserRow, role: 'admin' | 'viewer') {
  if (role === u.role) return;
  if ((await run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { role } }))) !== undefined) {
    toast.show(t('users.roleChanged', { name: u.name || u.email, role: roleName(role) }));
    void page.load();
  }
}
async function resetLink(u: UserRow) {
  const res = await run(() => api<IssuedLink>(`/users/${u.id}/reset-link`, { method: 'POST' }));
  if (!res) return;
  copied.value = false;
  const first = (u.name || '').split(' ')[0] || t('users.link.their');
  dialog.value = {
    kind: 'link',
    title: t('users.link.resetTitle', { name: u.name || u.email }),
    meta: t('users.link.resetMeta'),
    link: res.link,
    emailed: res.emailed,
    to: u.email,
    reset: true,
    foot: t('users.link.resetFoot', { name: first }),
  };
  void page.load();
}
async function remove(u: UserRow) {
  if ((await run(() => api(`/users/${u.id}`, { method: 'DELETE' }))) !== undefined) {
    dialog.value = null;
    toast.show(t('users.removed', { name: u.name || u.email }));
    void page.load();
  }
}
async function makeOwner(u: UserRow) {
  if ((await run(() => api(`/users/${u.id}/owner`, { method: 'POST' }))) !== undefined) {
    dialog.value = null;
    toast.show(t('users.ownerNow', { name: u.name || u.email }));
    await auth.reload();
    void page.load();
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

// ------------------------------------------------------------ rows

interface Row {
  key: string;
  initials: string;
  title: string;
  email: string;
  role: 'owner' | 'admin' | 'viewer';
  status: 'active' | 'pending' | 'expired';
  last: string;
  user?: UserRow;
  invite?: InviteRow;
}
const initials = (s: string) => {
  const parts = s
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
};
const rows = computed<Row[]>(() => {
  const d = data.value;
  if (!d) return [];
  return [
    ...d.users.map((u) => ({
      key: u.id,
      initials: initials(u.name || u.email),
      title: u.you ? t('users.you', { name: u.name || u.email }) : u.name || u.email,
      email: u.email,
      role: u.role,
      status: 'active' as const,
      last: u.you
        ? t('users.activeNow')
        : u.lastActiveAt
          ? relativeTime(u.lastActiveAt, t)
          : t('users.neverActive'),
      user: u,
    })),
    ...d.invites.map((i) => ({
      key: i.id,
      initials: initials(i.email),
      title: t('users.invited'),
      email: i.email,
      role: i.role,
      status: i.status,
      last:
        i.status === 'expired'
          ? t('users.inviteExpiredOn', { date: fmtDay(i.expiresAt) })
          : t('users.invitedBy', {
              name: i.invitedBy ?? '—',
              date: fmtDay(i.createdAt),
              date2: fmtDay(i.expiresAt),
            }),
      invite: i,
    })),
  ];
});
const BADGE: Record<Row['status'], string> = {
  active: 'bg-ok/15 text-ok',
  pending: 'bg-warning/15 text-warning',
  expired: 'bg-surface-3 text-text-muted',
};
const AVATAR: Record<Row['role'], string> = {
  owner: 'bg-ok/25',
  admin: 'bg-info/25',
  viewer: 'bg-surface-3',
};
const editable = (r: Row) => !!r.user && !r.user.you && r.role !== 'owner';
const roleCards = computed(() => {
  const n = (role: string) => data.value?.users.filter((u) => u.role === role).length ?? 0;
  return (['viewer', 'admin', 'owner'] as const).map((r) => ({
    role: r,
    count: r === 'owner' ? t('users.roles.owner.count') : t('users.activeCount', { n: n(r) }, n(r)),
    // "+" can, "-" can't (the mock-up's ticks and crosses).
    items: (tm(`users.roles.${r}.items`) as unknown as Parameters<typeof rt>[0][]).map((m) => {
      const x = rt(m);
      return { yes: !x.startsWith('-'), text: x.replace(/^[-+]\s*/, '') };
    }),
  }));
});
const auditText = (a: UserList['audit'][number]) =>
  t(`users.audit.${a.action}`, {
    subject: a.subject ?? '—',
    ...Object.fromEntries(Object.entries(a.details).map(([k, v]) => [k, String(v)])),
  });
</script>

<template>
  <section class="flex flex-col gap-5" data-testid="users">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex max-w-160 flex-col gap-2">
        <h2 class="text-20 font-semibold text-text">{{ $t('users.title') }}</h2>
        <p class="text-14 text-text-muted">{{ $t('users.intro') }}</p>
      </div>
      <LockedControl align="end">
        <BaseButton data-testid="invite" @click="openInvite">
          <UserPlus class="size-4" aria-hidden="true" />{{ $t('users.invite') }}
        </BaseButton>
      </LockedControl>
    </header>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('users.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonTable
      v-if="page.skeleton.value"
      :columns="5"
      :rows="3"
      :label="$t('common.loading')"
    />

    <template v-else-if="data">
      <p
        v-if="!canManage && !auth.demoMode"
        class="flex items-start gap-2.5 rounded-card border border-border bg-surface-1 px-4 py-3 text-13 text-text-muted"
        data-testid="viewer-banner"
      >
        <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          {{ $t('users.viewerBanner') }}
          <template v-if="someAdmin">
            {{ $t('users.viewerAsk', { email: someAdmin.email }) }}</template
          >
        </span>
      </p>
      <p
        v-else-if="canManage && !data.smtp"
        class="flex flex-wrap items-start gap-2.5 rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-13 text-text"
        data-testid="smtp-banner"
      >
        <MailX class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ $t('users.smtpBanner') }}</span>
        <RouterLink
          :to="{ name: 'settings', query: { tab: 'channels' } }"
          class="font-medium text-text underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
          >{{ $t('users.setUpSmtp') }}</RouterLink
        >
      </p>

      <section class="overflow-hidden rounded-card border border-border bg-surface-1">
        <div
          v-if="!narrow"
          class="grid grid-cols-[minmax(0,2.2fr)_8rem_9rem_minmax(0,1.5fr)_minmax(15rem,1.9fr)] gap-3.5 border-b border-border px-4 py-2.5 text-11 font-medium tracking-wider text-text-muted uppercase"
        >
          <span>{{ $t('users.columns.person') }}</span>
          <span>{{ $t('users.columns.role') }}</span>
          <span>{{ $t('users.columns.status') }}</span>
          <span>{{ $t('users.columns.last') }}</span>
          <span class="text-right">{{ $t('users.columns.actions') }}</span>
        </div>
        <ul>
          <li
            v-for="r in rows"
            :key="r.key"
            :class="[
              'border-t border-border first:border-t-0 px-4 py-3',
              narrow
                ? 'flex flex-col gap-2.5'
                : 'grid grid-cols-[minmax(0,2.2fr)_8rem_9rem_minmax(0,1.5fr)_minmax(15rem,1.9fr)] items-center gap-3.5',
            ]"
            data-testid="user-row"
            :data-status="r.status"
          >
            <span class="flex min-w-0 items-center gap-3">
              <span
                :class="[
                  'flex size-8.5 shrink-0 items-center justify-center rounded-full text-12 font-semibold text-text',
                  r.status === 'active'
                    ? AVATAR[r.role]
                    : 'border border-dashed border-border-strong text-text-muted',
                ]"
                aria-hidden="true"
                >{{ r.initials }}</span
              >
              <span class="flex min-w-0 flex-col">
                <span class="truncate text-14 font-medium text-text">{{ r.title }}</span>
                <span class="truncate text-12 text-text-muted">{{ r.email }}</span>
              </span>
            </span>
            <span>
              <select
                v-if="editable(r) && canManage"
                :value="r.role"
                class="h-8.5 rounded-control border border-border bg-surface-2 px-2 text-13 text-text max-lg:h-11"
                :aria-label="$t('users.roleFor', { email: r.email })"
                data-testid="role"
                @change="
                  setRole(r.user!, ($event.target as HTMLSelectElement).value as 'admin' | 'viewer')
                "
              >
                <option value="admin">{{ roleName('admin') }}</option>
                <option value="viewer">{{ roleName('viewer') }}</option>
              </select>
              <span v-else class="text-13 text-text" data-testid="role-fixed">{{
                roleName(r.role)
              }}</span>
            </span>
            <span>
              <span
                :class="[
                  'inline-flex h-5.5 items-center rounded-full px-2.5 text-12 font-semibold whitespace-nowrap',
                  BADGE[r.status],
                ]"
                >{{ $t(`users.status.${r.status}`) }}</span
              >
            </span>
            <span class="text-13 text-text-muted">{{ r.last }}</span>
            <span :class="['flex flex-wrap gap-2', narrow ? '' : 'justify-end']">
              <template v-if="r.user?.you">
                <span class="text-12 text-text-subtle">{{ $t('users.ownAccount') }}</span>
              </template>
              <template v-else-if="r.user && r.role !== 'owner'">
                <LockedControl align="end">
                  <span class="flex flex-wrap gap-2">
                    <BaseButton
                      v-if="myRole === 'owner' && r.role === 'admin'"
                      variant="secondary"
                      data-testid="make-owner"
                      @click="dialog = { kind: 'owner', user: r.user! }"
                      >{{ $t('users.makeOwner') }}</BaseButton
                    >
                    <BaseButton
                      variant="secondary"
                      data-testid="reset-link"
                      :loading="busy"
                      @click="resetLink(r.user!)"
                      >{{ $t('users.resetPassword') }}</BaseButton
                    >
                    <BaseButton
                      variant="ghost"
                      class="text-critical!"
                      data-testid="remove"
                      @click="dialog = { kind: 'remove', user: r.user! }"
                      >{{ $t('users.remove') }}</BaseButton
                    >
                  </span>
                </LockedControl>
              </template>
              <template v-else-if="r.invite">
                <LockedControl align="end">
                  <span class="flex flex-wrap gap-2">
                    <BaseButton
                      v-if="r.status === 'pending'"
                      variant="secondary"
                      data-testid="copy-link"
                      @click="copyLink(r.invite!)"
                      >{{ $t('users.copyLink') }}</BaseButton
                    >
                    <BaseButton
                      v-else
                      variant="secondary"
                      data-testid="new-link"
                      @click="renew(r.invite!)"
                      >{{ $t('users.newLink') }}</BaseButton
                    >
                    <BaseButton
                      variant="ghost"
                      class="text-critical!"
                      data-testid="revoke"
                      @click="revoke(r.invite!)"
                      >{{
                        r.status === 'pending' ? $t('users.revoke') : $t('users.remove')
                      }}</BaseButton
                    >
                  </span>
                </LockedControl>
              </template>
            </span>
          </li>
        </ul>
      </section>

      <section class="grid gap-3.5 lg:grid-cols-3" :aria-label="$t('users.rolesTitle')">
        <article
          v-for="c in roleCards"
          :key="c.role"
          class="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 p-4"
          :data-role-card="c.role"
        >
          <div class="flex items-baseline justify-between gap-2">
            <h3 class="text-14 font-semibold text-text">{{ roleName(c.role) }}</h3>
            <span class="text-12 text-text-muted">{{ c.count }}</span>
          </div>
          <p class="text-13 text-text-muted">{{ $t(`users.roles.${c.role}.desc`) }}</p>
          <ul class="flex flex-col gap-1.5 text-13">
            <li
              v-for="(it, i) in c.items"
              :key="i"
              :class="['flex items-start gap-2', it.yes ? 'text-text' : 'text-text-muted']"
            >
              <Check v-if="it.yes" class="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" />
              <X v-else class="mt-0.5 size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
              <span
                ><span class="sr-only">{{ it.yes ? $t('users.can') : $t('users.cannot') }}</span
                >{{ it.text }}</span
              >
            </li>
          </ul>
        </article>
      </section>

      <section
        v-if="canManage && data.audit.length"
        class="flex flex-col gap-2 rounded-card border border-border bg-surface-1 px-4 py-3.5"
        data-testid="audit"
      >
        <h3 class="text-14 font-semibold text-text">{{ $t('users.auditTitle') }}</h3>
        <ul class="flex flex-col divide-y divide-border text-13">
          <li
            v-for="(a, i) in data.audit.slice(0, 15)"
            :key="i"
            class="flex flex-wrap justify-between gap-2 py-2"
          >
            <span class="text-text"
              >{{ auditText(a)
              }}<span v-if="a.actor" class="text-text-muted"> · {{ a.actor }}</span></span
            >
            <span class="text-12 text-text-muted"
              >{{ formatDateTime(a.at) }}<template v-if="a.ip"> · {{ a.ip }}</template></span
            >
          </li>
        </ul>
      </section>
    </template>

    <!-- Invite someone -->
    <ModalDialog
      v-if="dialog?.kind === 'invite'"
      v-model:open="dialogOpen"
      :title="$t('users.inviteTitle')"
      :description="$t('users.inviteDescription')"
    >
      <form class="flex flex-col gap-4" data-testid="invite-form" @submit.prevent="createInvite">
        <TextField
          v-model="inviteEmail"
          type="email"
          :label="$t('users.email')"
          :hint="$t('users.emailHint')"
          :error="inviteError"
          autocomplete="off"
          required
        />
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-2 text-13 font-medium text-text">{{ $t('users.columns.role') }}</legend>
          <label
            v-for="o in ['admin', 'viewer'] as const"
            :key="o"
            :class="[
              'flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3',
              inviteRole === o ? 'border-ok bg-ok/5' : 'border-border',
            ]"
            :data-invite-role="o"
          >
            <input v-model="inviteRole" type="radio" name="invite-role" :value="o" class="mt-1" />
            <span class="flex flex-col gap-0.5">
              <span class="text-14 font-medium text-text">{{ roleName(o) }}</span>
              <span class="text-12 text-text-muted">{{ $t(`users.inviteRole.${o}`) }}</span>
            </span>
          </label>
          <p class="text-12 text-text-muted">{{ $t('users.oneOwner') }}</p>
        </fieldset>
        <p class="text-13 text-text-muted">
          {{ data?.smtp ? $t('users.inviteHowSmtp') : $t('users.inviteHowLink') }}
        </p>
        <div class="flex justify-end gap-2 border-t border-border pt-4">
          <BaseButton variant="secondary" @click="dialog = null">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton type="submit" :loading="busy" data-testid="invite-submit">{{
            $t('users.createInvite')
          }}</BaseButton>
        </div>
      </form>
    </ModalDialog>

    <!-- The link: an invite or a password reset -->
    <ModalDialog
      v-if="dialog?.kind === 'link'"
      v-model:open="dialogOpen"
      :title="dialog.title"
      :description="dialog.meta"
    >
      <div class="flex flex-col gap-4" data-testid="link-dialog">
        <div class="flex items-center gap-2 rounded-control border border-border bg-bg px-3 py-2">
          <code class="min-w-0 flex-1 font-mono text-13 break-all text-text" data-testid="link">{{
            dialog.link
          }}</code>
          <BaseButton variant="secondary" data-testid="copy" @click="copy(dialog.link)">
            <Check v-if="copied" class="size-4 text-ok" aria-hidden="true" /><Copy
              v-else
              class="size-4"
              aria-hidden="true"
            />{{ copied ? $t('common.copied') : $t('common.copy') }}
          </BaseButton>
        </div>
        <p v-if="dialog.emailed" class="text-13 text-ok" data-testid="emailed">
          {{ $t('users.link.emailed', { email: dialog.to }) }}
        </p>
        <p v-else class="text-13 text-text-muted" data-testid="not-emailed">
          {{ $t('users.link.notEmailed') }}
          <RouterLink
            v-if="canManage && !data?.smtp"
            :to="{ name: 'settings', query: { tab: 'channels' } }"
            class="text-text underline"
            >{{ $t('users.setUpSmtpToSend') }}</RouterLink
          >
        </p>
        <p class="text-12 text-text-muted">{{ dialog.foot }}</p>
        <div class="flex justify-end border-t border-border pt-4">
          <BaseButton @click="dialog = null">{{ $t('users.done') }}</BaseButton>
        </div>
      </div>
    </ModalDialog>

    <!-- Remove -->
    <ModalDialog
      v-if="dialog?.kind === 'remove'"
      v-model:open="dialogOpen"
      :title="$t('users.removeTitle', { name: dialog.user.name || dialog.user.email })"
    >
      <div class="flex flex-col gap-4" data-testid="remove-dialog">
        <ul class="flex list-disc flex-col gap-1.5 pl-5 text-13 text-text">
          <li>{{ $t('users.removeSignedOut') }}</li>
          <li>{{ $t('users.removeTokens', { n: dialog.user.tokens }, dialog.user.tokens) }}</li>
          <li>{{ $t('users.removeStays') }}</li>
        </ul>
        <div class="flex justify-end gap-2 border-t border-border pt-4">
          <BaseButton variant="secondary" @click="dialog = null">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton
            variant="danger"
            :loading="busy"
            data-testid="remove-confirm"
            @click="remove(dialog.user)"
            >{{ $t('users.removeUser') }}</BaseButton
          >
        </div>
      </div>
    </ModalDialog>

    <!-- Hand ownership over -->
    <ModalDialog
      v-if="dialog?.kind === 'owner'"
      v-model:open="dialogOpen"
      :title="$t('users.ownerTitle', { name: dialog.user.name || dialog.user.email })"
    >
      <div class="flex flex-col gap-4" data-testid="owner-dialog">
        <p class="text-13 text-text">
          {{
            $t('users.ownerBody', {
              name: dialog.user.name || dialog.user.email,
              owner: owner?.name || owner?.email || '',
            })
          }}
        </p>
        <div class="flex justify-end gap-2 border-t border-border pt-4">
          <BaseButton variant="secondary" @click="dialog = null">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton :loading="busy" data-testid="owner-confirm" @click="makeOwner(dialog.user)">{{
            $t('users.makeOwner')
          }}</BaseButton>
        </div>
      </div>
    </ModalDialog>
  </section>
</template>
