<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { InviteInfo, UserEnvelope } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import { cloudApi, cloudErrorKey } from '@/api/cloud';
import FormAlert from '@/components/cloud/FormAlert.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';

// Join WatchLog (ADR-140, Accept.dc.html): who invited you and as what, your name and a
// password of at least 12 characters, then you are signed in. A used, revoked or expired
// link says so and who to ask.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const token = computed(() => String(route.params.token));
const info = useLoader(() => api<InviteInfo>(`/invites/${token.value}`));
onMounted(info.load);

const name = ref('');
const password = ref('');
const error = ref<string>();
const busy = ref(false);
const usable = computed(() => info.data.value?.status === 'pending');

async function accept() {
  error.value = undefined;
  if (password.value.length < 12) {
    error.value = t('invite.tooShort');
    return;
  }
  busy.value = true;
  try {
    const res = await api<UserEnvelope>(`/invites/${token.value}/accept`, {
      method: 'POST',
      body: { name: name.value.trim(), password: password.value },
    });
    auth.user = res.user;
    await router.replace('/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('auth.errors.generic');
    if (err instanceof ApiError && err.status === 410) void info.load();
  } finally {
    busy.value = false;
  }
}
// Cloud (ADR-175): an existing account joins with one click, signed in; signed out, it
// signs in first and comes back here.
const joinError = ref<string>();
async function join() {
  joinError.value = undefined;
  busy.value = true;
  try {
    await cloudApi.joinInvite(token.value);
    // The session is now in the new org: start the app again there.
    window.location.assign('/');
  } catch (err) {
    joinError.value = cloudErrorKey(err);
    busy.value = false;
  }
}
const signInToJoin = computed(() => ({
  name: 'login',
  query: { redirect: `/invite/${token.value}` },
}));
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
</script>

<template>
  <AuthCard
    v-if="info.data.value && usable && auth.isCloud && auth.user"
    :title="$t('cloud.join.title')"
    :intro="
      $t('invite.intro', {
        who: info.data.value.invitedBy ?? $t('invite.someone'),
        site: info.data.value.site,
        role: $t(`users.roles.${info.data.value.role}.name`),
      })
    "
  >
    <div class="flex flex-col gap-4" data-testid="join">
      <p class="text-13 text-text-muted">
        {{ $t('cloud.join.as', { email: auth.user.email }) }}
      </p>
      <FormAlert v-if="joinError">{{ $t(joinError) }}</FormAlert>
      <BaseButton block :loading="busy" data-testid="join-submit" @click="join">
        {{ $t('cloud.join.submit') }}
      </BaseButton>
      <RouterLink
        to="/"
        class="self-center text-13 text-text-muted hover:text-text max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
        >{{ $t('cloud.join.notNow') }}</RouterLink
      >
    </div>
  </AuthCard>
  <AuthCard
    v-else-if="info.data.value && usable"
    :title="$t('invite.title')"
    :intro="
      $t('invite.intro', {
        who: info.data.value.invitedBy ?? $t('invite.someone'),
        site: info.data.value.site,
        role: $t(`users.roles.${info.data.value.role}.name`),
      })
    "
  >
    <form class="flex flex-col gap-4" novalidate data-testid="accept" @submit.prevent="accept">
      <TextField
        :model-value="info.data.value.email"
        :label="$t('auth.fields.email')"
        type="email"
        autocomplete="username"
        readonly
      />
      <TextField v-model="name" :label="$t('invite.name')" autocomplete="name" required />
      <TextField
        v-model="password"
        :label="$t('auth.fields.password')"
        :hint="$t('invite.passwordHint')"
        type="password"
        autocomplete="new-password"
        required
      />
      <p
        v-if="error"
        role="alert"
        class="rounded-control border border-critical bg-surface-2 px-3 py-2 text-13 text-text"
      >
        {{ error }}
      </p>
      <BaseButton type="submit" block :loading="busy" data-testid="accept-submit">{{
        $t('invite.submit')
      }}</BaseButton>
      <p class="text-12 text-text-muted">
        {{ $t('invite.foot', { date: day(info.data.value.expiresAt) }) }}
      </p>
      <RouterLink
        v-if="auth.isCloud"
        :to="signInToJoin"
        class="self-center text-13 text-primary hover:text-primary-hover max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
        data-testid="sign-in-to-join"
        >{{ $t('cloud.join.signIn') }}</RouterLink
      >
    </form>
  </AuthCard>
  <AuthCard
    v-else-if="info.data.value || info.error.value"
    :title="
      info.data.value?.status === 'expired' ? $t('invite.expiredTitle') : $t('invite.unusableTitle')
    "
    :intro="
      info.data.value?.status === 'expired'
        ? $t('invite.expiredIntro', { who: info.data.value.invitedBy ?? $t('invite.theInviter') })
        : $t('invite.unusableIntro')
    "
  >
    <RouterLink
      :to="{ name: 'login' }"
      class="self-center text-13 text-text-muted hover:text-text max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
      data-testid="invite-gone"
    >
      {{ $t('invite.signIn') }}
    </RouterLink>
  </AuthCard>
</template>
