<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// "No /metrics page here yet" (1.0.3): what the search's empty answer leads to, instead of a
// dead end. Push instead (the quickest), add a /metrics page to your own app with your
// language's Prometheus library, or use an exporter.
import {
  EXPOSE_LANG_NAMES,
  EXPOSE_LANGS,
  exposeSnippet,
  type ExposeLang,
} from '@watchlog/snippets';
import { ref } from 'vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';

defineProps<{ kube: boolean }>();
const emit = defineEmits<{ push: [] }>();
const lang = ref<ExposeLang | null>(null);
const BOX = 'flex flex-col gap-1.5 rounded-control border px-3.5 py-3 text-left';
</script>

<template>
  <section
    class="rounded-card border border-border bg-bg px-4 py-4"
    aria-labelledby="own-none-h"
    data-testid="own-none"
  >
    <h3 id="own-none-h" class="text-14 font-semibold text-text">
      {{ $t('ownMetrics.add.none.title') }}
    </h3>
    <div class="mt-3 grid gap-3 md:grid-cols-3">
      <button
        type="button"
        :class="[BOX, 'border-primary bg-primary/10 hover:bg-primary/15']"
        data-testid="own-none-push"
        @click="emit('push')"
      >
        <b class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.none.push.b') }}</b>
        <span class="text-13 leading-relaxed text-text-muted">{{
          $t('ownMetrics.add.none.push.t')
        }}</span>
      </button>
      <div :class="[BOX, 'border-border']">
        <b class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.none.app.b') }}</b>
        <span class="text-13 leading-relaxed text-text-muted">{{
          $t('ownMetrics.add.none.app.t')
        }}</span>
        <div
          role="tablist"
          class="mt-1 flex flex-wrap gap-1.5"
          :aria-label="$t('ownMetrics.add.none.lang')"
        >
          <button
            v-for="l in EXPOSE_LANGS"
            :key="l"
            type="button"
            role="tab"
            :aria-selected="lang === l"
            :class="[
              'min-h-8 rounded-full border px-3 text-13 max-lg:min-h-11',
              lang === l
                ? 'border-border-strong bg-surface-3 font-semibold text-text'
                : 'border-border text-text-muted hover:text-text',
            ]"
            :data-testid="`own-none-lang-${l}`"
            @click="lang = lang === l ? null : l"
          >
            {{ EXPOSE_LANG_NAMES[l] }}
          </button>
        </div>
      </div>
      <div :class="[BOX, 'border-border']">
        <b class="text-14 font-semibold text-text">{{ $t('ownMetrics.add.none.exporter.b') }}</b>
        <span class="text-13 leading-relaxed text-text-muted">{{
          $t('ownMetrics.add.none.exporter.t')
        }}</span>
      </div>
    </div>
    <div v-if="lang" class="mt-3 min-w-0" data-testid="own-none-code">
      <CodeBlock :code="exposeSnippet(lang)" :label="EXPOSE_LANG_NAMES[lang]" />
      <p v-if="!kube" class="mt-2 text-13 text-text-muted">
        {{ $t('ownMetrics.add.none.app.then') }}
      </p>
    </div>
  </section>
</template>
