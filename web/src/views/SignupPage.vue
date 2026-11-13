<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';
import type { UserEnvelope } from '@watchlog/api-types';
import { MailCheck, Users } from '@lucide/vue';
import { computed, onMounted, ref, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '@/api/client';
import { cloudApi, cloudErrorKey } from '@/api/cloud';
import FormAlert from '@/components/cloud/FormAlert.vue';
import PasswordStrength from '@/components/cloud/PasswordStrength.vue';
import ProviderButtons from '@/components/cloud/ProviderButtons.vue';
import TurnstileWidget from '@/components/cloud/TurnstileWidget.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';

// Sign up for WatchLog Cloud (ADR-175, Signup.dc.html): GitHub or Google in one click, or
// email and password with a strength meter and Cloudflare's human check; no card. The
// answer is the same for a new and a taken address: a new account comes back signed in
// (GET /me answers) and goes on; a taken one gets an email, and the page says to check it.
//
// Invite waves (ADR-173): while signup is in `invite` mode, the page needs the invite from
// the wave's email (`/signup?invite=wl_si_…`). It checks the code, fills in the address it
// is for (read-only) and hands the code to the signup and to GitHub/Google. Without a
// usable invite it says Cloud is opening in waves and links to the waitlist.
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const inviteCode = computed(() => {
  const q = route.query.invite;
  return typeof q === 'string' && q.length <= 128 ? q : '';
});
type InviteState = 'none' | 'checking' | 'valid' | 'invalid';
const inviteState = ref<InviteState>(inviteCode.value ? 'checking' : 'none');
const invitedUntil = ref('');
const inviteOk = computed(() => inviteState.value === 'valid');
/** Signup is closed to this visitor: invite mode and no usable invite. */
const closed = computed(
  () =>
    auth.cloud?.signupMode === 'invite' &&
    (inviteState.value === 'none' || inviteState.value === 'invalid'),
);
const min = computed(() => auth.cloud?.passwordMinLength ?? 10);
const siteKey = computed(() => auth.cloud?.turnstileSiteKey ?? null);

const email = ref('');
const password = ref('');
const turnstileToken = ref<string | null>(null);
const turnstile = ref<InstanceType<typeof TurnstileWidget> | null>(null);
const error = ref<string>();
const busy = ref(false);
const checkEmail = ref(false);
const strengthId = useId();

onMounted(async () => {
  if (!inviteCode.value) return;
  try {
    const invite = await cloudApi.signupInvite(inviteCode.value);
    email.value = invite.email;
    invitedUntil.value = invite.expiresAt.slice(0, 10);
    inviteState.value = 'valid';
  } catch {
    inviteState.value = 'invalid';
  }
});

const STEPS = ['account', 'install', 'checklist'] as const;
const CHIPS = ['readOnly', 'noSecrets', 'openSource'] as const;

async function submit() {
  error.value = undefined;
  const address = email.value.trim();
  if (!address.includes('@')) return void (error.value = 'cloud.signup.emailNeeded');
  if (password.value.length < min.value) return void (error.value = 'cloud.signup.tooShort');
  if (siteKey.value && !turnstileToken.value) return void (error.value = 'cloud.turnstile.needed');
  busy.value = true;
  try {
    await cloudApi.signup({
      email: address,
      password: password.value,
      ...(turnstileToken.value ? { turnstileToken: turnstileToken.value } : {}),
      ...(inviteOk.value ? { invite: inviteCode.value } : {}),
    });
    try {
      const { user } = await api<UserEnvelope>('/me');
      await auth.signedIn(user);
      // Straight to "Add your first cluster" (SPEC §10.1, ADR-176).
      await router.replace({ name: 'onboarding' });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
      checkEmail.value = true;
    }
  } catch (err) {
    error.value = cloudErrorKey(err);
    turnstile.value?.reset();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg text-text">
    <header class="flex flex-wrap items-center justify-between gap-4 px-4 py-4 md:px-8 md:py-5">
      <RouterLink
        :to="{ name: 'login' }"
        class="flex items-center gap-2.5 text-16 font-semibold tracking-tight text-text"
      >
        <img :src="logoUrl" alt="" class="size-8" />{{ $t('app.name') }}
      </RouterLink>
      <p class="text-14 text-text-muted">
        {{ $t('cloud.signup.haveAccount') }}
        <RouterLink
          :to="{ name: 'login' }"
          class="inline-flex items-center text-primary hover:text-primary-hover max-lg:min-h-11"
          data-testid="to-signin"
          >{{ $t('cloud.signup.signIn') }}</RouterLink
        >
      </p>
    </header>

    <main
      class="mx-auto flex w-full max-w-275 flex-1 flex-wrap items-start gap-10 px-4 pt-4 pb-14 md:gap-14 md:px-6 md:pt-8"
    >
      <section
        class="flex max-w-115 min-w-0 flex-[1_1_420px] flex-col gap-4.5 rounded-card border border-border bg-surface-1 p-5 md:p-8"
        :aria-labelledby="`${strengthId}-title`"
      >
        <template v-if="checkEmail">
          <MailCheck class="size-8 text-primary" aria-hidden="true" />
          <h1 :id="`${strengthId}-title`" class="text-24 font-semibold">
            {{ $t('cloud.signup.checkTitle') }}
          </h1>
          <p class="text-14 leading-relaxed text-text-muted" data-testid="signup-check-email">
            {{ $t('cloud.signup.checkIntro', { email: email.trim() }) }}
          </p>
          <RouterLink
            :to="{ name: 'login' }"
            class="inline-flex h-11 items-center justify-center rounded-control border border-border-strong text-14 font-semibold text-text hover:bg-surface-2"
            >{{ $t('cloud.signup.signIn') }}</RouterLink
          >
        </template>
        <p
          v-else-if="inviteState === 'checking'"
          class="text-14 text-text-muted"
          role="status"
          data-testid="signup-invite-checking"
        >
          {{ $t('cloud.signup.checkingInvite') }}
        </p>
        <template v-else-if="closed">
          <Users class="size-8 text-primary" aria-hidden="true" />
          <h1 :id="`${strengthId}-title`" class="text-24 font-semibold">
            {{ $t('cloud.signup.waves.title') }}
          </h1>
          <FormAlert v-if="inviteState === 'invalid'" data-testid="signup-invite-invalid">{{
            $t('cloud.signup.waves.invalid')
          }}</FormAlert>
          <p class="text-14 leading-relaxed text-text-muted" data-testid="signup-waves">
            {{ $t('cloud.signup.waves.intro') }}
          </p>
          <a
            :href="LINKS.waitlist"
            class="inline-flex h-11 items-center justify-center rounded-control bg-primary px-4 text-14 font-semibold text-on-primary hover:bg-primary-hover"
            data-testid="signup-waitlist"
            >{{ $t('cloud.signup.waves.join') }}</a
          >
          <div class="flex flex-col gap-1">
            <p class="text-13 leading-relaxed text-text-muted">
              {{ $t('cloud.signup.waves.selfHost') }}
            </p>
            <a
              :href="LINKS.install"
              target="_blank"
              rel="noopener"
              class="inline-flex w-fit items-center text-13 text-primary hover:text-primary-hover max-lg:min-h-11"
              >{{ $t('cloud.signup.waves.selfHostLink') }}</a
            >
          </div>
        </template>
        <template v-else>
          <div class="flex flex-col gap-1.5">
            <h1 :id="`${strengthId}-title`" class="text-24 font-semibold">
              {{ $t('cloud.signup.title') }}
            </h1>
            <p class="text-14 text-text-muted">{{ $t('cloud.signup.intro') }}</p>
          </div>
          <div
            v-if="inviteOk"
            class="flex flex-col gap-0.5 rounded-control border border-border bg-surface-2 px-3 py-2.5"
            data-testid="signup-invited"
          >
            <p class="text-14 font-semibold">
              {{ $t('cloud.signup.invitedAs', { email }) }}
            </p>
            <p class="text-13 text-text-muted">
              {{ $t('cloud.signup.invitedNote', { date: invitedUntil }) }}
            </p>
          </div>
          <ProviderButtons :invite="inviteOk ? inviteCode : undefined" />
          <form
            class="flex flex-col gap-4.5"
            novalidate
            data-testid="signup"
            @submit.prevent="submit"
          >
            <TextField
              v-model="email"
              :label="$t('cloud.signup.email')"
              type="email"
              autocomplete="email"
              inputmode="email"
              :readonly="inviteOk"
              required
            />
            <div class="flex flex-col gap-2">
              <TextField
                v-model="password"
                :label="$t('auth.fields.password')"
                type="password"
                autocomplete="new-password"
                :minlength="min"
                required
              />
              <PasswordStrength :id="strengthId" :password="password" :min-length="min" />
            </div>
            <TurnstileWidget
              v-if="siteKey"
              ref="turnstile"
              v-model="turnstileToken"
              :site-key="siteKey"
            />
            <FormAlert v-if="error">{{ $t(error) }}</FormAlert>
            <BaseButton
              type="submit"
              block
              :loading="busy"
              class="h-11"
              data-testid="signup-submit"
            >
              {{ $t('cloud.signup.submit') }}
            </BaseButton>
            <i18n-t
              keypath="cloud.signup.agree"
              tag="p"
              class="text-13 leading-relaxed text-text-muted"
              scope="global"
            >
              <template #terms>
                <a
                  :href="LINKS.terms"
                  target="_blank"
                  rel="noopener"
                  class="text-primary hover:text-primary-hover"
                  >{{ $t('cloud.signup.terms') }}</a
                >
              </template>
              <template #privacy>
                <a
                  :href="LINKS.privacy"
                  target="_blank"
                  rel="noopener"
                  class="text-primary hover:text-primary-hover"
                  >{{ $t('cloud.signup.privacy') }}</a
                >
              </template>
            </i18n-t>
          </form>
        </template>
      </section>

      <aside
        class="flex min-w-0 flex-[1_1_360px] flex-col gap-7 md:pt-3"
        :aria-label="$t('cloud.signup.stepsLabel')"
      >
        <h2 class="text-24 leading-tight font-semibold md:text-32">
          {{ $t('cloud.signup.panelTitle') }}
        </h2>
        <ol class="flex flex-col gap-4.5">
          <li v-for="(step, i) in STEPS" :key="step" class="flex gap-3.5">
            <span
              :class="[
                'flex size-7 shrink-0 items-center justify-center rounded-full text-14 font-semibold',
                i === 0
                  ? 'bg-primary text-on-primary'
                  : 'border border-border-strong text-text-muted',
              ]"
              aria-hidden="true"
              >{{ i + 1 }}</span
            >
            <div>
              <p class="font-semibold">
                <span class="sr-only">{{ $t('cloud.signup.stepN', { n: i + 1 }) }} </span
                >{{ $t(`cloud.signup.steps.${step}.title`) }}
              </p>
              <p class="mt-0.5 text-14 text-text-muted">
                {{ $t(`cloud.signup.steps.${step}.text`) }}
              </p>
            </div>
          </li>
        </ol>
        <ul class="flex flex-wrap gap-2.5 border-t border-border pt-5">
          <li
            v-for="chip in CHIPS"
            :key="chip"
            class="rounded-full border border-border px-3 py-1.5 text-13 text-text-muted"
          >
            {{ $t(`cloud.signup.chips.${chip}`) }}
          </li>
        </ul>
      </aside>
    </main>
  </div>
</template>
