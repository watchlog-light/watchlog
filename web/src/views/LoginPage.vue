<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// "Forgot your password?" (ADR-140): with SMTP, a reset link by email (the same answer
// whether the account exists or not); without it, the Owner's command line.
const forgotOpen = ref(false);
const forgotEmail = ref('');
const forgotSent = ref(false);
const forgotBusy = ref(false);
async function sendReset() {
  forgotBusy.value = true;
  try {
    await api('/auth/forgot-password', {
      method: 'POST',
      body: { email: forgotEmail.value.trim() },
    });
  } catch {
    // The same message either way: nothing to tell about the account.
  } finally {
    forgotBusy.value = false;
    forgotSent.value = true;
  }
}
const CLI_K8S =
  'kubectl exec -n watchlog deploy/watchlog-backend -- \\\n  watchlog admin reset-password';
const CLI_DOCKER = 'docker exec watchlog-backend-1 \\\n  watchlog admin reset-password';

const email = ref('');
const password = ref('');
const error = ref<string>();
const submitting = ref(false);

function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return t('auth.errors.generic');
  if (err.status === 401) return t('auth.errors.invalidCredentials');
  if (err.status === 429) return t('auth.errors.tooManyAttempts');
  if (err.status === 0 || err.status >= 500) return t('auth.errors.unavailable');
  return t('auth.errors.generic');
}

function afterSignIn() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  // Only follow same-app paths, never absolute URLs.
  return router.replace(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/');
}

async function submit() {
  error.value = undefined;
  submitting.value = true;
  try {
    await auth.login({ email: email.value.trim(), password: password.value });
    await afterSignIn();
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

// Read-only demo (ADR-122): one button instead of the form; /demo presses it at once.
async function enterDemo() {
  error.value = undefined;
  submitting.value = true;
  try {
    await auth.enterDemo();
    await afterSignIn();
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 429
        ? t('auth.errors.tooManyAttempts')
        : t('auth.demo.unavailable');
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  if (route.name !== 'demo') return;
  if (auth.demoMode) void enterDemo();
  else void router.replace({ name: 'login' });
});
</script>

<template>
  <AuthCard v-if="auth.demoMode" :title="$t('auth.demo.title')" :intro="$t('auth.demo.intro')">
    <div class="flex flex-col gap-4">
      <p
        v-if="error"
        role="alert"
        class="rounded-control border border-critical bg-surface-2 px-3 py-2 text-13 text-text"
      >
        {{ error }}
      </p>
      <BaseButton block :loading="submitting" data-testid="enter-demo" @click="enterDemo">
        {{ $t('auth.demo.enter') }}
      </BaseButton>
      <a
        :href="LINKS.install"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center justify-center gap-1.5 self-center text-13 text-primary hover:text-primary-hover max-lg:min-h-11"
      >
        {{ $t('auth.demo.install') }}
        <ArrowRight class="size-4" aria-hidden="true" />
      </a>
    </div>
  </AuthCard>
  <AuthCard v-else :title="$t('auth.login.title')" :intro="$t('auth.login.intro')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <TextField
        v-model="email"
        :label="$t('auth.fields.email')"
        type="email"
        autocomplete="username"
        required
      />
      <TextField
        v-model="password"
        :label="$t('auth.fields.password')"
        type="password"
        autocomplete="current-password"
        required
      />
      <p
        v-if="error"
        role="alert"
        class="rounded-control border border-critical bg-surface-2 px-3 py-2 text-13 text-text"
      >
        {{ error }}
      </p>
      <BaseButton type="submit" block :loading="submitting">
        {{ $t('auth.login.submit') }}
      </BaseButton>
      <button
        type="button"
        class="self-center text-13 text-text-muted hover:text-text max-lg:min-h-11"
        data-testid="forgot"
        @click="
          forgotOpen = true;
          forgotSent = false;
          forgotEmail = email;
        "
      >
        {{ $t('auth.forgot.link') }}
      </button>
    </form>
    <ModalDialog v-model:open="forgotOpen" :title="$t('auth.forgot.title')">
      <form
        v-if="auth.smtp"
        class="flex flex-col gap-4"
        data-testid="forgot-email"
        @submit.prevent="sendReset"
      >
        <template v-if="!forgotSent">
          <p class="text-13 text-text-muted">{{ $t('auth.forgot.emailIntro') }}</p>
          <TextField
            v-model="forgotEmail"
            :label="$t('auth.fields.email')"
            type="email"
            autocomplete="username"
            required
          />
          <BaseButton type="submit" :loading="forgotBusy">{{ $t('auth.forgot.send') }}</BaseButton>
        </template>
        <p v-else role="status" class="text-13 text-text" data-testid="forgot-sent">
          {{ $t('auth.forgot.sent') }}
        </p>
      </form>
      <div v-else class="flex flex-col gap-3" data-testid="forgot-cli">
        <p class="text-13 text-text-muted">{{ $t('auth.forgot.cliIntro') }}</p>
        <p class="text-13 font-medium text-text">Kubernetes</p>
        <CodeBlock wrap :code="CLI_K8S" :label="$t('auth.forgot.command')" />
        <p class="text-13 font-medium text-text">Docker</p>
        <CodeBlock wrap :code="CLI_DOCKER" :label="$t('auth.forgot.command')" />
        <p class="text-12 text-text-muted">{{ $t('auth.forgot.cliFoot') }}</p>
      </div>
    </ModalDialog>
  </AuthCard>
</template>
