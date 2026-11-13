<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import googleUrl from '@/assets/brands/google.svg';
import { KeyRound, LogOut, MonitorSmartphone, ShieldCheck } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
  cloudApi,
  cloudErrorKey,
  isCloudErrorCode,
  oauthStartUrl,
  PROVIDERS,
  type AccountSession,
  type Provider,
} from '@/api/cloud';
import FormAlert from '@/components/cloud/FormAlert.vue';
import GithubMark from '@/components/cloud/GithubMark.vue';
import InfoTag from '@/components/cloud/InfoTag.vue';
import RecoveryCodes from '@/components/cloud/RecoveryCodes.vue';
import StaffAccess from '@/components/cloud/StaffAccess.vue';
import TwoFactorSetup from '@/components/cloud/TwoFactorSetup.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';

import TextField from '@/components/ui/TextField.vue';
import { describeAgent } from '@/lib/sessions';
import { useAuthStore } from '@/stores/auth';

// Settings › Security (Cloud, ADR-175): 2FA on or off with its recovery codes, the signed-in
// sessions with revoke, GitHub and Google as ways to sign in, and for Owners WatchLog
// staff's support sessions (ADR-179). The OAuth callback comes
// back here with ?linked=<provider> or ?error=<code>.
const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const account = computed(() => auth.account);
const notice = ref<{ tone: 'ok' | 'error'; text: string } | null>(null);

watch(
  () => [route.query.linked, route.query.error] as const,
  ([linked, error]) => {
    if (linked === 'github' || linked === 'google') {
      notice.value = {
        tone: 'ok',
        text: t('cloud.security.linked', { provider: t(`cloud.providers.name.${linked}`) }),
      };
    } else if (isCloudErrorCode(error)) {
      notice.value = { tone: 'error', text: t(`cloud.errors.${error}`) };
    }
  },
  { immediate: true },
);

// ---- 2FA
const setupOpen = ref(false);
const codeDialog = ref<'disable' | 'recovery' | null>(null);
const confirmCode = ref('');
const codeError = ref<string>();
const codeBusy = ref(false);
const newCodes = ref<string[] | null>(null);

function openCode(kind: 'disable' | 'recovery') {
  confirmCode.value = '';
  codeError.value = undefined;
  newCodes.value = null;
  codeDialog.value = kind;
}
async function confirm() {
  codeError.value = undefined;
  const value = confirmCode.value.trim().toLowerCase().replace(/\s/g, '');
  if (!value) return void (codeError.value = 'cloud.mfa.sixDigits');
  codeBusy.value = true;
  try {
    if (codeDialog.value === 'disable') {
      await cloudApi.disableMfa(value);
      codeDialog.value = null;
      notice.value = { tone: 'ok', text: t('cloud.security.mfaOff') };
    } else {
      newCodes.value = (await cloudApi.newRecoveryCodes(value)).recoveryCodes;
    }
    await auth.loadAccount();
  } catch (err) {
    codeError.value = cloudErrorKey(err);
  } finally {
    codeBusy.value = false;
  }
}
async function setupDone() {
  setupOpen.value = false;
  await auth.loadAccount();
  notice.value = { tone: 'ok', text: t('cloud.security.mfaOn') };
  void loadSessions();
}

// ---- sessions
const sessions = ref<AccountSession[] | null>(null);
const sessionsError = ref<string>();
async function loadSessions() {
  sessionsError.value = undefined;
  try {
    sessions.value = (await cloudApi.sessions()).sessions;
  } catch (err) {
    sessionsError.value = cloudErrorKey(err);
  }
}
const others = computed(() => (sessions.value ?? []).filter((s) => !s.current).length);
async function revoke(s: AccountSession) {
  try {
    await cloudApi.revokeSession(s.id);
    if (s.current) {
      auth.clear();
      await router.replace({ name: 'login' });
      return;
    }
    await loadSessions();
  } catch (err) {
    sessionsError.value = cloudErrorKey(err);
  }
}
async function revokeOthers() {
  try {
    const { revoked } = await cloudApi.revokeOtherSessions();
    notice.value = { tone: 'ok', text: t('cloud.security.revokedOthers', { n: revoked }) };
    await loadSessions();
  } catch (err) {
    sessionsError.value = cloudErrorKey(err);
  }
}
function device(s: AccountSession) {
  const d = describeAgent(s.userAgent);
  if (!d) return t('cloud.security.unknownDevice');
  if (d.browser && d.os) return t('cloud.security.browserOn', { browser: d.browser, os: d.os });
  return d.browser ?? d.os!;
}
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

// ---- sign-in methods
const identity = (p: Provider) => account.value?.identities.find((i) => i.provider === p);
const providers = computed(() => PROVIDERS.filter((p) => auth.cloud?.providers[p] || identity(p)));
const linkUrl = (p: Provider) => oauthStartUrl(p, 'link', '/settings/security');
const unlinkError = ref<string>();
async function unlink(p: Provider) {
  unlinkError.value = undefined;
  try {
    await cloudApi.unlink(p);
    await auth.loadAccount();
  } catch (err) {
    unlinkError.value = cloudErrorKey(err);
  }
}

onMounted(() => {
  void auth.loadAccount();
  void loadSessions();
});
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-6" data-testid="security-settings">
    <FormAlert v-if="notice" :tone="notice.tone" data-testid="security-notice">{{
      notice.text
    }}</FormAlert>

    <!-- 2FA -->
    <section
      class="rounded-card border border-border bg-surface-1 p-4 md:p-5"
      aria-labelledby="sec-mfa"
    >
      <div class="flex flex-wrap items-start gap-3">
        <ShieldCheck class="mt-0.5 size-5 shrink-0 text-text-muted" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="sec-mfa" class="text-16 font-semibold text-text">
              {{ $t('cloud.security.mfaTitle') }}
            </h2>
            <InfoTag
              v-if="account"
              :tone="account.mfa.enabled ? 'ok' : 'neutral'"
              :label="account.mfa.enabled ? $t('cloud.security.on') : $t('cloud.security.off')"
              data-testid="mfa-status"
            />
          </div>
          <p class="mt-1 text-13 text-text-muted">
            {{
              account?.mfa.required
                ? $t('cloud.security.mfaRequired')
                : $t('cloud.security.mfaIntro')
            }}
          </p>
          <p
            v-if="account?.mfa.enabled"
            class="mt-1 text-13 text-text-muted"
            data-testid="codes-left"
          >
            {{ $t('cloud.security.codesLeft', { n: account.mfa.recoveryCodesLeft }) }}
          </p>
        </div>
        <div v-if="account" class="flex flex-wrap gap-2 max-sm:w-full">
          <BaseButton
            v-if="!account.mfa.enabled"
            data-testid="mfa-turn-on"
            @click="setupOpen = true"
          >
            {{ $t('cloud.security.turnOn') }}
          </BaseButton>
          <template v-else>
            <BaseButton
              variant="secondary"
              data-testid="mfa-new-codes"
              @click="openCode('recovery')"
            >
              {{ $t('cloud.security.newCodes') }}
            </BaseButton>
            <BaseButton
              variant="secondary"
              :disabled="account.mfa.required"
              :title="account.mfa.required ? $t('cloud.errors.mfa-required') : undefined"
              data-testid="mfa-turn-off"
              @click="openCode('disable')"
            >
              {{ $t('cloud.security.turnOff') }}
            </BaseButton>
          </template>
        </div>
      </div>
    </section>

    <!-- Sessions -->
    <section
      class="rounded-card border border-border bg-surface-1 p-4 md:p-5"
      aria-labelledby="sec-sessions"
    >
      <div class="flex flex-wrap items-center gap-3">
        <MonitorSmartphone class="size-5 shrink-0 text-text-muted" aria-hidden="true" />
        <h2 id="sec-sessions" class="min-w-0 flex-1 text-16 font-semibold text-text">
          {{ $t('cloud.security.sessionsTitle') }}
        </h2>
        <BaseButton
          v-if="others > 0"
          variant="secondary"
          class="max-sm:w-full"
          data-testid="revoke-others"
          @click="revokeOthers"
        >
          {{ $t('cloud.security.revokeOthers') }}
        </BaseButton>
      </div>
      <FormAlert v-if="sessionsError" class="mt-3">{{ $t(sessionsError) }}</FormAlert>
      <ul v-if="sessions" class="mt-3 flex flex-col divide-y divide-border" data-testid="sessions">
        <li
          v-for="s in sessions"
          :key="s.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
        >
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-14 text-text">
              {{ device(s) }}
              <InfoTag v-if="s.current" tone="ok" :label="$t('cloud.security.thisDevice')" />
              <InfoTag v-if="s.mfa" tone="neutral" :label="$t('cloud.security.with2fa')" />
            </p>
            <p class="mt-0.5 text-12 text-text-muted">
              {{
                $t('cloud.security.sessionMeta', {
                  ip: s.ip ?? '—',
                  seen: when(s.lastSeenAt ?? s.createdAt),
                  since: when(s.createdAt),
                })
              }}
            </p>
          </div>
          <BaseButton
            variant="ghost"
            :aria-label="
              s.current
                ? $t('cloud.security.signOutHere')
                : $t('cloud.security.revokeLabel', { device: device(s) })
            "
            data-testid="revoke-session"
            @click="revoke(s)"
          >
            <LogOut class="size-4" aria-hidden="true" />
            {{ s.current ? $t('account.signOut') : $t('cloud.security.revoke') }}
          </BaseButton>
        </li>
      </ul>
      <p v-else-if="!sessionsError" class="mt-3 text-13 text-text-muted">
        {{ $t('common.loading') }}
      </p>
    </section>

    <!-- Sign-in methods -->
    <section
      class="rounded-card border border-border bg-surface-1 p-4 md:p-5"
      aria-labelledby="sec-methods"
    >
      <div class="flex items-center gap-3">
        <KeyRound class="size-5 shrink-0 text-text-muted" aria-hidden="true" />
        <h2 id="sec-methods" class="text-16 font-semibold text-text">
          {{ $t('cloud.security.methodsTitle') }}
        </h2>
      </div>
      <FormAlert v-if="unlinkError" class="mt-3">{{ $t(unlinkError) }}</FormAlert>
      <ul class="mt-3 flex flex-col divide-y divide-border" data-testid="identities">
        <li class="flex flex-wrap items-center gap-3 py-3">
          <span class="min-w-0 flex-1 text-14 text-text">{{ $t('auth.fields.password') }}</span>
          <span class="text-13 text-text-muted">{{
            account?.password ? $t('cloud.security.passwordSet') : $t('cloud.security.passwordNone')
          }}</span>
        </li>
        <li
          v-for="p in providers"
          :key="p"
          class="flex flex-wrap items-center gap-3 py-3"
          :data-testid="`identity-${p}`"
        >
          <GithubMark v-if="p === 'github'" class="size-4.5 text-text" />
          <img v-else :src="googleUrl" alt="" class="size-4.5" />
          <div class="min-w-0 flex-1">
            <p class="text-14 text-text">{{ $t(`cloud.providers.name.${p}`) }}</p>
            <p class="text-12 text-text-muted">
              {{
                identity(p)
                  ? $t('cloud.security.linkedAs', {
                      email: identity(p)!.email ?? '—',
                      date: when(identity(p)!.linkedAt),
                    })
                  : $t('cloud.security.notLinked')
              }}
            </p>
          </div>
          <BaseButton
            v-if="identity(p)"
            variant="secondary"
            :data-testid="`unlink-${p}`"
            @click="unlink(p)"
          >
            {{ $t('cloud.security.unlink') }}
          </BaseButton>
          <a
            v-else
            :href="linkUrl(p)"
            :data-testid="`link-${p}`"
            class="inline-flex h-9 items-center rounded-control border border-border-strong px-4 text-14 font-semibold text-text hover:bg-surface-2 max-lg:h-11"
          >
            {{ $t('cloud.security.link') }}
          </a>
        </li>
      </ul>
    </section>

    <!-- WatchLog staff's support sessions (ADR-179): Owners only. -->
    <StaffAccess v-if="auth.user?.role === 'owner'" />

    <ModalDialog
      v-model:open="setupOpen"
      :title="$t('cloud.security.setupTitle')"
      :description="$t('cloud.security.setupIntro')"
      locked
    >
      <TwoFactorSetup @done="setupDone" />
      <BaseButton variant="ghost" class="self-end" @click="setupOpen = false">{{
        $t('common.cancel')
      }}</BaseButton>
    </ModalDialog>

    <ModalDialog
      :open="codeDialog !== null"
      :title="
        codeDialog === 'disable'
          ? $t('cloud.security.turnOffTitle')
          : $t('cloud.security.newCodesTitle')
      "
      :description="newCodes ? undefined : $t('cloud.security.confirmIntro')"
      :locked="!!newCodes"
      @update:open="
        (o) => {
          if (!o) codeDialog = null;
        }
      "
    >
      <RecoveryCodes v-if="newCodes" :codes="newCodes" @done="codeDialog = null" />
      <form
        v-else
        class="flex flex-col gap-4"
        novalidate
        data-testid="mfa-confirm"
        @submit.prevent="confirm"
      >
        <TextField
          v-model="confirmCode"
          :label="$t('cloud.security.confirmLabel')"
          autocomplete="one-time-code"
          :maxlength="11"
          mono
          required
        />
        <FormAlert v-if="codeError">{{ $t(codeError) }}</FormAlert>
        <div class="flex flex-wrap justify-end gap-2">
          <BaseButton variant="ghost" @click="codeDialog = null">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton
            type="submit"
            :variant="codeDialog === 'disable' ? 'danger' : 'primary'"
            :loading="codeBusy"
            data-testid="mfa-confirm-submit"
          >
            {{
              codeDialog === 'disable'
                ? $t('cloud.security.turnOff')
                : $t('cloud.security.newCodes')
            }}
          </BaseButton>
        </div>
      </form>
    </ModalDialog>
  </div>
</template>
