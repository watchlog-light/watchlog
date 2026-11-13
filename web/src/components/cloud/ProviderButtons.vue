<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import googleUrl from '@/assets/brands/google.svg';
import { computed } from 'vue';
import { oauthStartUrl, PROVIDERS, type Provider } from '@/api/cloud';
import { useAuthStore } from '@/stores/auth';
import GithubMark from './GithubMark.vue';

// "Continue with GitHub / Google" (ADR-175, Signup.dc.html): plain links, since the browser
// leaves for the provider. Only the providers the backend has turned on are shown.
const props = defineProps<{ next?: string }>();
const auth = useAuthStore();
const shown = computed(() => PROVIDERS.filter((p) => auth.cloud?.providers[p]));
const href = (p: Provider) => oauthStartUrl(p, 'signin', props.next);
</script>

<template>
  <div v-if="shown.length" class="flex flex-col gap-3" data-testid="providers">
    <a
      v-for="p in shown"
      :key="p"
      :href="href(p)"
      :data-testid="`provider-${p}`"
      class="flex h-11 items-center justify-center gap-2.5 rounded-control border border-border bg-surface-2 px-4 text-14 font-semibold text-text transition-colors hover:border-border-strong hover:bg-surface-3"
    >
      <GithubMark v-if="p === 'github'" class="size-4.5" />
      <img v-else :src="googleUrl" alt="" class="size-4.5" />
      {{ $t(`cloud.providers.continue.${p}`) }}
    </a>
    <div class="flex items-center gap-3 text-13 text-text-muted" aria-hidden="true">
      <span class="h-px flex-1 bg-border" />{{ $t('cloud.providers.or')
      }}<span class="h-px flex-1 bg-border" />
    </div>
  </div>
</template>
