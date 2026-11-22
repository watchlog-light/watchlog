<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue';
import type { ProcessRule, ProcessRuleList } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import { previewRules } from '@/lib/process-rules';
import { useToastStore } from '@/stores/toast';

// A Server fleet's own process-group rules (ADR-207): an ordered list, with a preview on a
// process the user types and the groups the rules name now. Owners and Admins edit it.
const props = defineProps<{ clusterId: string; canManage: boolean }>();
const { t } = useI18n();
const toast = useToastStore();

const rules = ref<ProcessRule[]>([]);
const matches = ref<ProcessRuleList['matches']>([]);
const loaded = ref(false);
const loadError = ref(false);
const saving = ref(false);
const error = ref('');
const sample = ref({ exe: 'python3', unit: '', args: '/usr/bin/python3 -m sync --interval 30' });

async function load() {
  try {
    const r = await api<ProcessRuleList>(`/clusters/${props.clusterId}/process-rules`);
    rules.value = r.rules.map((x) => ({ ...x }));
    matches.value = r.matches;
    loadError.value = false;
  } catch {
    loadError.value = true;
  } finally {
    loaded.value = true;
  }
}

function add() {
  rules.value.push({ exe: '', unit: '', args: '', name: '' });
}
function move(i: number, by: -1 | 1) {
  const j = i + by;
  if (j < 0 || j >= rules.value.length) return;
  const list = [...rules.value];
  [list[i], list[j]] = [list[j]!, list[i]!];
  rules.value = list;
}
function remove(i: number) {
  rules.value = rules.value.filter((_, k) => k !== i);
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const body = {
      rules: rules.value.map((r) => ({
        ...(r.exe ? { exe: r.exe } : {}),
        ...(r.unit ? { unit: r.unit } : {}),
        ...(r.args ? { args: r.args } : {}),
        name: r.name,
      })),
    };
    const res = await api<{ rules: ProcessRule[] }>(`/clusters/${props.clusterId}/process-rules`, {
      method: 'PUT',
      body,
    });
    rules.value = res.rules.map((x) => ({ ...x }));
    toast.show(t('servers.rules.saved'));
  } catch (e) {
    error.value =
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : t('servers.rules.errorSave');
  } finally {
    saving.value = false;
  }
}

const preview = computed(() => previewRules(rules.value, sample.value));
const FIELDS = ['exe', 'unit', 'args', 'name'] as const;
const HINTS = { exe: 'exeHint', unit: 'unitHint', args: 'argsHint', name: 'nameHint' } as const;

onMounted(load);
</script>

<template>
  <section
    id="process-rules"
    class="rounded-card border border-border bg-surface-1"
    data-testid="process-rules"
  >
    <div class="border-b border-border px-5 py-4 max-md:px-4">
      <h3 class="text-14 font-semibold text-text">{{ $t('servers.rules.title') }}</h3>
      <p class="mt-1 text-13 text-text-muted">{{ $t('servers.rules.intro') }}</p>
      <p v-if="!canManage" class="mt-1 text-12 text-text-subtle">
        {{ $t('servers.rules.viewer') }}
      </p>
    </div>
    <p v-if="loadError" role="alert" class="px-5 py-4 text-13 text-critical-text">
      {{ $t('servers.rules.errorLoad') }}
    </p>
    <div v-else-if="loaded" class="flex flex-col gap-4 px-5 py-4 max-md:px-4">
      <p v-if="rules.length === 0" class="text-13 text-text-muted">
        {{ $t('servers.rules.empty') }}
      </p>
      <ol class="flex flex-col gap-3">
        <li
          v-for="(r, i) in rules"
          :key="i"
          class="grid gap-2 rounded-control border border-border bg-surface-2 p-3 md:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] md:items-end"
          data-testid="rule-row"
        >
          <span class="font-mono text-13 text-text-subtle md:pb-2">{{ i + 1 }}</span>
          <label v-for="f in FIELDS" :key="f" class="flex min-w-0 flex-col gap-1">
            <span class="text-12 text-text-muted">{{ $t(`servers.rules.${f}`) }}</span>
            <input
              v-model="r[f]"
              :placeholder="$t(`servers.rules.${HINTS[f]}`)"
              :disabled="!canManage"
              :data-field="f"
              class="min-h-9 w-full min-w-0 rounded-control border border-border bg-surface-1 px-2 font-mono text-13 text-text placeholder:text-text-subtle max-lg:min-h-11"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
          <div v-if="canManage" class="flex gap-1">
            <button
              type="button"
              class="rounded-control p-2 text-text-muted hover:bg-surface-3 hover:text-text"
              :aria-label="$t('servers.rules.up')"
              @click="move(i, -1)"
            >
              <ArrowUp class="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="rounded-control p-2 text-text-muted hover:bg-surface-3 hover:text-text"
              :aria-label="$t('servers.rules.down')"
              @click="move(i, 1)"
            >
              <ArrowDown class="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="rounded-control p-2 text-text-muted hover:bg-surface-3 hover:text-critical-text"
              :aria-label="$t('servers.rules.remove')"
              @click="remove(i)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ol>
      <div v-if="canManage" class="flex flex-wrap gap-2">
        <BaseButton variant="secondary" data-testid="add-rule" @click="add">
          <Plus class="size-4" aria-hidden="true" /> {{ $t('servers.rules.add') }}
        </BaseButton>
        <BaseButton data-testid="save-rules" :loading="saving" @click="save">
          {{ $t('servers.rules.save') }}
        </BaseButton>
      </div>
      <p v-if="error" role="alert" class="text-13 text-critical-text" data-testid="rules-error">
        {{ error }}
      </p>

      <div class="rounded-control border border-border p-3" data-testid="rule-preview">
        <p class="mb-2 text-13 font-medium text-text">{{ $t('servers.rules.try') }}</p>
        <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <label
            v-for="f in ['exe', 'unit', 'args'] as const"
            :key="f"
            class="flex min-w-0 flex-col gap-1"
          >
            <span class="text-12 text-text-muted">{{
              $t(`servers.rules.try${f === 'exe' ? 'Exe' : f === 'unit' ? 'Unit' : 'Args'}`)
            }}</span>
            <input
              v-model="sample[f]"
              :data-sample="f"
              class="min-h-9 w-full min-w-0 rounded-control border border-border bg-surface-1 px-2 font-mono text-13 text-text max-lg:min-h-11"
              spellcheck="false"
              autocomplete="off"
            />
          </label>
        </div>
        <p class="mt-2 text-13" data-testid="preview-result">
          <span v-if="preview" class="text-text">{{
            $t('servers.rules.result', { name: preview.name, n: preview.rule })
          }}</span>
          <span v-else class="text-text-muted">{{ $t('servers.rules.noMatch') }}</span>
        </p>
      </div>

      <div>
        <p class="mb-1 text-13 font-medium text-text">{{ $t('servers.rules.matched') }}</p>
        <ul v-if="matches.length" class="flex flex-col gap-1 text-13 text-text-muted">
          <li v-for="m in matches" :key="m.group" class="font-mono">
            {{
              $t('servers.rules.matchedRow', {
                group: m.group,
                instances: m.instances,
                servers: m.servers.join(', '),
              })
            }}
          </li>
        </ul>
        <p v-else class="text-13 text-text-subtle">{{ $t('servers.rules.none') }}</p>
      </div>
    </div>
  </section>
</template>
