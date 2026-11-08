<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useCopy } from '@/composables/useCopy';
import { snippet } from '@/lib/api-tokens';
import { LINKS } from '@/lib/links';
import { useAuthStore } from '@/stores/auth';

// The live demo (ADR-122) makes no tokens. When it has a public read-only MCP token
// (ADR-130), it offers it with a ready Claude Code command; and always the way to get
// your own tokens: install WatchLog.
const auth = useAuthStore();
const command = computed(() =>
  auth.demoMcpToken
    ? snippet('code', window.location.origin, auth.demoMcpToken, 'watchlog-demo')
    : null,
);
const copier = useCopy();
</script>

<template>
  <section class="flex max-w-215 flex-col gap-5" data-testid="api-tokens-demo">
    <div class="flex flex-col gap-2">
      <h2 class="text-20 font-semibold text-text">{{ $t('apiTokens.title') }}</h2>
      <p class="text-14 leading-relaxed text-text-muted">{{ $t('apiTokens.demo.intro') }}</p>
    </div>

    <div
      v-if="command"
      class="flex flex-col gap-3.5 rounded-card border border-border bg-surface-1 p-5"
      data-testid="api-tokens-demo-try"
    >
      <div class="flex flex-wrap items-center gap-2.5">
        <span
          class="inline-flex h-[22px] items-center rounded-full bg-primary-soft px-2 text-12 font-medium text-ok"
          >{{ $t('apiTokens.demo.tryIt') }}</span
        >
        <h3 class="text-16 font-semibold text-text">{{ $t('apiTokens.demo.askTitle') }}</h3>
      </div>
      <p class="text-14 leading-relaxed text-text-muted">{{ $t('apiTokens.demo.askText') }}</p>
      <pre
        class="rounded-control border border-border bg-bg px-4 py-3.5 font-mono text-12 leading-relaxed break-all whitespace-pre-wrap text-text"
        data-testid="api-tokens-demo-command"
        >{{ command }}</pre>
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <span class="text-12 text-text-muted">{{ $t('apiTokens.demo.limits') }}</span>
        <div class="flex flex-wrap items-center gap-2">
          <BaseButton variant="secondary" @click="copier.copy(command)">
            <span aria-live="polite">{{
              copier.state.value === 'copied'
                ? $t('common.copied')
                : copier.state.value === 'failed'
                  ? $t('common.copyFailed')
                  : $t('common.copy')
            }}</span>
          </BaseButton>
          <a
            :href="LINKS.mcp"
            target="_blank"
            rel="noopener"
            class="inline-flex min-h-11 items-center px-2 text-13 text-primary hover:underline lg:min-h-9"
            >{{ $t('apiTokens.demo.otherApps') }}</a
          >
        </div>
      </div>
    </div>

    <div
      class="flex flex-wrap items-center justify-between gap-3.5 rounded-card border border-dashed border-border-strong px-5 py-5"
    >
      <div class="flex flex-col gap-1">
        <span class="text-16 font-semibold text-text">{{ $t('apiTokens.demo.ownTitle') }}</span>
        <span class="text-13 text-text-muted">{{ $t('apiTokens.demo.ownText') }}</span>
      </div>
      <a
        :href="LINKS.install"
        target="_blank"
        rel="noopener"
        class="inline-flex h-11 items-center rounded-control bg-primary px-4 text-14 font-semibold text-on-primary transition-colors hover:bg-primary-hover lg:h-9"
        data-testid="api-tokens-demo-install"
        >{{ $t('apiTokens.demo.install') }}</a
      >
    </div>
  </section>
</template>
