<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { KeyRound } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { computed, ref } from 'vue';

// One install command per cluster kind: docker run per host, or helm install once.
const props = defineProps<{
  token: string;
  install: { dockerRun?: string; helm?: string; script?: string; deb?: string; rpm?: string };
  rotation?: boolean;
}>();
const kind = computed(() => (props.install.helm ? 'kubernetes' : 'docker'));
// A Server fleet (ADR-209): the install script, the packages, or docker run.
const SERVER_METHODS = ['script', 'deb', 'rpm', 'dockerRun'] as const;
type ServerMethod = (typeof SERVER_METHODS)[number];
const serverMethods = computed(() => SERVER_METHODS.filter((m) => !!props.install[m]));
const method = ref<ServerMethod>('script');
const command = computed(() =>
  props.install.helm
    ? props.install.helm
    : (props.install[method.value] ?? props.install.dockerRun ?? ''),
);
defineEmits<{ done: [] }>();
</script>

<template>
  <section
    data-testid="token-reveal"
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5"
  >
    <div class="flex items-start gap-3">
      <KeyRound class="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <h3 class="text-14 font-semibold text-text">{{ $t('clusters.reveal.title') }}</h3>
        <p class="mt-1 text-13 text-text-muted">{{ $t('clusters.reveal.once') }}</p>
      </div>
    </div>
    <div
      v-if="kind === 'docker' && serverMethods.length > 1"
      class="flex flex-wrap gap-1"
      role="group"
      :aria-label="$t('onboarding.install.methods')"
    >
      <button
        v-for="m in serverMethods"
        :key="m"
        type="button"
        class="rounded-control px-2.5 py-1 text-12 max-lg:min-h-11"
        :class="method === m ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'"
        :aria-pressed="method === m"
        :data-method="m"
        @click="method = m"
      >
        {{ $t(`onboarding.install.method.${m}`) }}
      </button>
    </div>
    <CodeBlock :label="$t(`clusters.reveal.installLabel.${kind}`)" :code="command" />
    <p class="text-13 text-text-muted">
      {{
        rotation
          ? $t('clusters.reveal.rotationHint')
          : kind === 'docker' && install.script
            ? $t(`onboarding.install.note.${method}`)
            : $t(`clusters.reveal.installHint.${kind}`)
      }}
    </p>
    <CodeBlock :label="$t('clusters.reveal.tokenLabel')" :code="token" />
    <div>
      <BaseButton variant="secondary" @click="$emit('done')">{{
        $t('clusters.reveal.done')
      }}</BaseButton>
    </div>
  </section>
</template>
