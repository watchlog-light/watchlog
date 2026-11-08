<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ApiToken } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useCopy } from '@/composables/useCopy';
import { useNarrow } from '@/composables/useNarrow';
import { snippet, SNIPPET_TABS, type SnippetTab } from '@/lib/api-tokens';

// The token's value, shown once, and how to connect each app (ADR-125): Claude Code,
// Claude Desktop through mcp-remote, Cursor, or any HTTP client. "Done" waits until the
// user ticks that they stored the token.
const props = defineProps<{ token: ApiToken; value: string; baseUrl: string }>();
defineEmits<{ done: [] }>();
const narrow = useNarrow();

const tab = ref<SnippetTab>('code');
const ack = ref(false);
const code = computed(() => snippet(tab.value, props.baseUrl, props.value));
const valueCopy = useCopy();
const snippetCopy = useCopy();
const copyLabel = (state: 'idle' | 'copied' | 'failed') =>
  state === 'copied' ? 'common.copied' : state === 'failed' ? 'common.copyFailed' : 'common.copy';

// Arrow keys, Home and End move between the tabs (WAI-ARIA tabs pattern).
function onTabKey(e: KeyboardEvent) {
  const last = SNIPPET_TABS.length - 1;
  const i = SNIPPET_TABS.indexOf(tab.value);
  const keys: Record<string, number> = {
    ArrowRight: i === last ? 0 : i + 1,
    ArrowLeft: i === 0 ? last : i - 1,
    Home: 0,
    End: last,
  };
  const n = keys[e.key];
  if (n === undefined) return;
  e.preventDefault();
  tab.value = SNIPPET_TABS[n]!;
  document.getElementById(`snippet-tab-${tab.value}`)?.focus();
}
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="api-token-reveal">
    <div class="flex items-stretch gap-2">
      <code
        class="flex min-w-0 flex-1 items-center rounded-control border border-primary bg-bg px-3 py-2.5 font-mono text-13 break-all text-text"
        data-testid="api-token-value"
        >{{ value }}</code
      >
      <BaseButton
        class="min-w-22 self-center max-lg:h-11"
        data-testid="api-token-copy"
        @click="valueCopy.copy(value)"
      >
        <span aria-live="polite">{{ $t(copyLabel(valueCopy.state.value)) }}</span>
      </BaseButton>
    </div>

    <div class="flex flex-col gap-2.5">
      <span class="text-13 font-semibold text-text">{{ $t('apiTokens.reveal.connect') }}</span>
      <div
        role="tablist"
        :aria-label="$t('apiTokens.reveal.connect')"
        class="flex gap-1 overflow-x-auto border-b border-border"
      >
        <button
          v-for="tb in SNIPPET_TABS"
          :id="`snippet-tab-${tb}`"
          :key="tb"
          type="button"
          role="tab"
          :aria-selected="tab === tb"
          aria-controls="snippet-panel"
          :tabindex="tab === tb ? 0 : -1"
          :class="[
            '-mb-px min-h-11 shrink-0 border-b-2 px-3 text-13 font-medium whitespace-nowrap transition-colors',
            tab === tb
              ? 'border-primary text-text'
              : 'border-transparent text-text-muted hover:text-text',
          ]"
          :data-testid="`snippet-tab-${tb}`"
          @click="tab = tb"
          @keydown="onTabKey"
        >
          {{ $t(`apiTokens.reveal.tabs.${tb}`) }}
        </button>
      </div>
      <div
        id="snippet-panel"
        role="tabpanel"
        :aria-labelledby="`snippet-tab-${tab}`"
        class="flex flex-col gap-2.5"
      >
        <p class="text-12 text-text-muted">{{ $t(`apiTokens.reveal.hints.${tab}`) }}</p>
        <pre
          class="rounded-control border border-border bg-bg px-4 py-3.5 font-mono text-12 leading-relaxed break-all whitespace-pre-wrap text-text"
          data-testid="snippet"
          >{{ code }}</pre>
        <div class="flex flex-wrap items-center justify-between gap-2.5">
          <span class="text-12 text-text-muted">{{ $t('apiTokens.reveal.address') }}</span>
          <BaseButton
            variant="secondary"
            data-testid="snippet-copy"
            @click="snippetCopy.copy(code)"
          >
            <span aria-live="polite">{{
              snippetCopy.state.value === 'idle'
                ? $t('apiTokens.reveal.copySnippet')
                : $t(copyLabel(snippetCopy.state.value))
            }}</span>
          </BaseButton>
        </div>
      </div>
    </div>

    <div
      :class="[
        'flex gap-2.5 border-t border-border pt-3.5',
        narrow ? 'flex-col' : 'items-center justify-between',
      ]"
    >
      <label class="flex min-h-11 cursor-pointer items-center gap-2.5 text-14 text-text">
        <input
          v-model="ack"
          type="checkbox"
          class="size-4.5 accent-primary"
          data-testid="api-token-ack"
        />
        {{ $t('apiTokens.reveal.ack') }}
      </label>
      <BaseButton
        :disabled="!ack"
        :block="narrow"
        data-testid="api-token-done"
        @click="$emit('done')"
      >
        {{ $t('apiTokens.reveal.done') }}
      </BaseButton>
    </div>
  </div>
</template>
