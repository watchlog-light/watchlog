<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleCheck, CircleX, RotateCw, Square, TriangleAlert } from '@lucide/vue';
import type { DockerContainer } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import { badState, exitMeaning, unhealthySummary } from '@/lib/diagnosis';
import { formatDateTime } from '@/lib/format';
import { clockTime } from '@/lib/time';
import { formatBytes } from '@/lib/units';

// Explains a bad state under the container header (ADR-047). Renders nothing for a
// running, healthy container.
const props = defineProps<{ container: DockerContainer; now?: number }>();
const { t } = useI18n();

const kind = computed(() => badState(props.container));
const detail = computed(() => props.container.healthDetail);
const lastProbe = computed(() => detail.value?.probes.at(-1));
const meaning = (code: number) => {
  const m = exitMeaning(code);
  return t(m.key, m.params ?? {});
};
const summary = computed(() => unhealthySummary(props.container, t, props.now ?? Date.now()));
const ICONS = { unhealthy: TriangleAlert, exited: Square, dead: CircleX, restarting: RotateCw };
const probeLabel = (p: { end: string; exitCode: number }) =>
  p.exitCode === 0
    ? t('docker.diagnosis.probePassed', { time: formatDateTime(p.end) })
    : t('docker.diagnosis.probeFailed', { time: formatDateTime(p.end), code: p.exitCode });
const seconds = (n: number) => t('docker.diagnosis.seconds', { n: Number(n.toFixed(1)) });
</script>

<template>
  <section
    v-if="kind"
    class="rounded-card border border-border bg-surface-1"
    :aria-labelledby="`diagnosis-${kind}`"
    data-testid="diagnosis"
  >
    <header class="flex items-center gap-2 border-b border-border px-5 py-3">
      <component
        :is="ICONS[kind]"
        :class="['size-4', kind === 'exited' ? 'text-text-muted' : 'text-critical']"
        aria-hidden="true"
      />
      <h3 :id="`diagnosis-${kind}`" class="text-14 font-semibold text-text">
        {{ $t(`docker.diagnosis.title.${kind}`) }}
      </h3>
    </header>

    <div class="flex flex-col gap-4 px-5 py-4 text-13">
      <!-- Out of memory is called out first: it is the answer whenever it applies. -->
      <p
        v-if="container.oomKilled"
        class="flex items-start gap-2 rounded-control border border-critical px-3 py-2 text-text"
        data-testid="oom"
      >
        <TriangleAlert class="mt-0.5 size-4 shrink-0 text-critical" aria-hidden="true" />
        {{ $t('docker.diagnosis.oomFlag') }}
      </p>

      <template v-if="kind === 'unhealthy'">
        <p class="text-14 text-text" data-testid="diagnosis-summary">{{ summary }}</p>

        <div v-if="lastProbe" class="flex flex-col gap-2">
          <p class="text-12 text-text-muted">
            {{ $t('docker.diagnosis.lastProbe') }} ·
            {{
              $t('docker.diagnosis.probeMeta', {
                time: formatDateTime(lastProbe.end),
                code: lastProbe.exitCode,
              })
            }}
          </p>
          <CodeBlock
            v-if="lastProbe.output"
            :code="lastProbe.output"
            :label="$t('docker.diagnosis.output')"
          />
          <p v-else-if="lastProbe.output === null" class="text-12 text-text-subtle">
            {{ $t('docker.diagnosis.noOutput') }}
          </p>
          <p v-else class="text-12 text-text-subtle">{{ $t('docker.diagnosis.emptyOutput') }}</p>
        </div>

        <div v-if="detail && detail.probes.length > 0" class="flex flex-col gap-1.5">
          <p class="text-12 text-text-muted">{{ $t('docker.diagnosis.recentProbes') }}</p>
          <ol class="flex flex-wrap gap-2" data-testid="probes">
            <li
              v-for="p in detail.probes"
              :key="p.start"
              class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-12 text-text-muted tabular"
              :title="probeLabel(p)"
            >
              <CircleCheck v-if="p.exitCode === 0" class="size-3.5 text-ok" aria-hidden="true" />
              <CircleX v-else class="size-3.5 text-critical" aria-hidden="true" />
              <span aria-hidden="true">{{ clockTime(p.end) }}</span>
              <span class="sr-only">{{ probeLabel(p) }}</span>
            </li>
          </ol>
        </div>

        <div v-if="detail?.check" class="flex flex-col gap-2" data-testid="check">
          <CodeBlock :code="detail.check.command" :label="$t('docker.diagnosis.command')" />
          <dl class="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <div>
              <dt class="text-12 text-text-subtle">{{ $t('docker.diagnosis.interval') }}</dt>
              <dd class="font-mono text-text tabular">{{ seconds(detail.check.intervalS) }}</dd>
            </div>
            <div>
              <dt class="text-12 text-text-subtle">{{ $t('docker.diagnosis.timeout') }}</dt>
              <dd class="font-mono text-text tabular">{{ seconds(detail.check.timeoutS) }}</dd>
            </div>
            <div>
              <dt class="text-12 text-text-subtle">{{ $t('docker.diagnosis.retries') }}</dt>
              <dd class="font-mono text-text tabular">{{ detail.check.retries }}</dd>
            </div>
            <div v-if="detail.check.startPeriodS > 0">
              <dt class="text-12 text-text-subtle">{{ $t('docker.diagnosis.startPeriod') }}</dt>
              <dd class="font-mono text-text tabular">{{ seconds(detail.check.startPeriodS) }}</dd>
            </div>
          </dl>
          <p class="text-12 text-text-subtle">{{ $t('docker.diagnosis.redacted') }}</p>
        </div>
      </template>

      <template v-else>
        <dl class="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
          <div v-if="kind === 'restarting'">
            <dt class="text-12 text-text-subtle">{{ $t('docker.columns.restarts') }}</dt>
            <dd class="font-mono text-text tabular" data-testid="restart-count">
              {{ container.restartCount }}
            </dd>
          </div>
          <div class="col-span-2">
            <dt class="text-12 text-text-subtle">
              {{
                kind === 'restarting'
                  ? $t('docker.diagnosis.lastExit')
                  : $t('docker.diagnosis.exitCode')
              }}
            </dt>
            <dd class="text-text" data-testid="exit-meaning">
              <span class="font-mono tabular">{{ container.exitCode }}</span>
              · {{ meaning(container.exitCode) }}
            </dd>
          </div>
          <div v-if="container.finishedAt">
            <dt class="text-12 text-text-subtle">{{ $t('docker.diagnosis.finishedAt') }}</dt>
            <dd class="text-text">{{ formatDateTime(container.finishedAt) }}</dd>
          </div>
        </dl>
        <p
          v-if="container.exitCode === 137 && !container.oomKilled"
          class="text-13 text-text-muted"
          data-testid="killed-hint"
        >
          {{ $t('docker.diagnosis.killedHint') }}
          <template v-if="container.memoryLimitBytes">
            {{
              $t('docker.diagnosis.killedHintLimit', {
                limit: formatBytes(container.memoryLimitBytes),
              })
            }}
          </template>
        </p>
        <div v-if="container.stateError" class="flex flex-col gap-1.5">
          <CodeBlock :code="container.stateError" :label="$t('docker.diagnosis.stateError')" />
        </div>
      </template>
    </div>
  </section>
</template>
