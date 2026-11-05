<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import logoUrl from '@watchlog/design-tokens/assets/logo.svg';

defineProps<{ title: string; intro: string }>();
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
    <div class="w-full max-w-sm">
      <div class="mb-8 flex items-center justify-center gap-2.5">
        <img :src="logoUrl" alt="" class="size-9" />
        <span class="text-20 font-semibold tracking-tight text-text">{{ $t('app.name') }}</span>
      </div>
      <section class="rounded-card border border-border bg-surface-1 p-6">
        <h1 class="text-20 font-semibold text-text">{{ title }}</h1>
        <p class="mt-1.5 mb-6 text-14 leading-relaxed text-text-muted">{{ intro }}</p>
        <slot />
      </section>
    </div>
  </main>
</template>
