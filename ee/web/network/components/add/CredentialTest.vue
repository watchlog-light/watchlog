<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { CircleAlert, CircleCheck, LoaderCircle } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import {
  networkApi,
  type Credential,
  type CredentialTest,
  type PollerChoice,
  type TestOutcome,
} from '../../api';

// "Test against an address" (1.0.2): one device is read with the profile's values as typed,
// through a poller, before anything is saved. It says in plain words what happened: the
// device answered (its name and model), the user or key is wrong, nothing answered, or the
// certificate isn't the one pinned for that address. Read-only, one address, with discovery's
// limits.
const props = defineProps<{
  pollers: PollerChoice[];
  /** The poller chosen in step 1, when there is one. */
  poller: { clusterId: string; host: string } | null;
  protocol: 'snmp' | 'routeros' | 'dahua';
  values: () => { settings: Credential['settings']; secret: Record<string, string> };
  /** What is still missing in the form, in its own words; '' when it can be tried. */
  problem: string;
  credentialId?: string | undefined;
}>();
const { t } = useI18n();

const address = ref('');
const options = computed<ComboboxOption[]>(() =>
  props.pollers.flatMap<ComboboxOption>((p) =>
    p.kind === 'kubernetes'
      ? p.hosts[0]?.collector
        ? [{ value: `${p.clusterId}/`, label: p.name, description: t('netAdd.poller.kubernetes') }]
        : []
      : p.hosts
          .filter((h) => h.collector)
          .map((h) => ({ value: `${p.clusterId}/${h.host}`, label: h.host, group: p.name })),
  ),
);
const from = ref<string | null>(null);
watch(
  [() => props.poller, options],
  () => {
    const chosen = props.poller ? `${props.poller.clusterId}/${props.poller.host}` : null;
    if (chosen && options.value.some((o) => o.value === chosen)) from.value = chosen;
    else if (!from.value || !options.value.some((o) => o.value === from.value))
      from.value = options.value[0]?.value ?? null;
  },
  { immediate: true },
);

const running = ref(false);
const result = ref<CredentialTest | null>(null);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let run = 0;
onBeforeUnmount(() => {
  run++;
  clearTimeout(timer);
});

const addressOk = computed(() => /^[A-Za-z0-9.:_-]{1,253}$/.test(address.value.trim()));
const cannot = computed(() => {
  if (!options.value.length) return t('netAdd.test.noPoller');
  if (props.problem) return props.problem;
  if (!addressOk.value) return address.value.trim() ? t('netAdd.test.badAddress') : '';
  return '';
});

async function test() {
  error.value = '';
  result.value = null;
  if (cannot.value || !from.value || !address.value.trim()) {
    error.value = cannot.value || t('netAdd.test.needAddress');
    return;
  }
  const cut = from.value.indexOf('/');
  const mine = ++run;
  running.value = true;
  try {
    const { settings, secret } = props.values();
    const { id } = await networkApi.testCredential({
      clusterId: from.value.slice(0, cut),
      host: from.value.slice(cut + 1),
      address: address.value.trim(),
      protocol: props.protocol,
      settings,
      secret,
      ...(props.credentialId ? { credentialId: props.credentialId } : {}),
    });
    // The poller picks it up at once; its answer is asked for until it is there.
    const poll = async () => {
      if (mine !== run) return;
      try {
        const r = await networkApi.credentialTest(id);
        if (mine !== run) return;
        if (r.done) {
          result.value = r;
          running.value = false;
        } else timer = setTimeout(() => void poll(), 1200);
      } catch (err) {
        if (mine !== run) return;
        error.value = err instanceof Error ? err.message : t('netAdd.test.failed');
        running.value = false;
      }
    };
    await poll();
  } catch (err) {
    if (mine !== run) return;
    error.value = err instanceof Error ? err.message : t('netAdd.test.failed');
    running.value = false;
  }
}

const tone = (o: TestOutcome | undefined) => (o === 'answered' ? 'ok' : 'bad');
const sentence = computed(() => {
  const r = result.value;
  if (!r?.outcome) return '';
  if (r.outcome === 'answered') {
    const what = [r.name, [r.vendor, r.model].filter(Boolean).join(' ')].filter(Boolean);
    return what.length
      ? t('netAdd.test.outcome.answeredAs', { address: r.address, device: what.join(', ') })
      : t('netAdd.test.outcome.answered', { address: r.address });
  }
  if (r.outcome === 'refused') return t(`netAdd.test.outcome.refused.${props.protocol}`);
  if (r.outcome === 'error')
    return t('netAdd.test.outcome.error', { detail: r.detail || t('netAdd.test.failed') });
  return t(`netAdd.test.outcome.${r.outcome}`, { address: r.address });
});
</script>

<template>
  <fieldset
    class="flex flex-col gap-3 rounded-control border border-border bg-surface-1 p-3"
    data-testid="cred-test"
  >
    <legend class="px-1 text-13 font-medium text-text">{{ $t('netAdd.test.title') }}</legend>
    <p class="text-12 text-text-muted">{{ $t('netAdd.test.intro') }}</p>
    <div class="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <TextField
        v-model="address"
        :label="$t('netAdd.test.address')"
        placeholder="10.0.10.2"
        autocomplete="off"
        :maxlength="253"
        data-testid="cred-test-address"
        @keydown.enter.prevent="test"
      />
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="text-13 font-medium text-text">{{ $t('netAdd.test.from') }}</span>
        <ComboBox
          v-model="from"
          :options="options"
          :label="$t('netAdd.test.from')"
          :placeholder="$t('netAdd.test.noPollerShort')"
          :disabled="!options.length"
          testid="cred-test-poller"
        />
      </div>
      <BaseButton variant="secondary" :loading="running" data-testid="cred-test-run" @click="test">
        {{ $t('netAdd.test.run') }}
      </BaseButton>
    </div>
    <p
      v-if="running"
      class="flex items-center gap-2 text-13 text-text-muted"
      role="status"
      data-testid="cred-test-running"
    >
      <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{{ $t('netAdd.test.running') }}
    </p>
    <p
      v-else-if="result"
      class="flex items-start gap-2 text-13"
      :class="tone(result.outcome) === 'ok' ? 'text-ok-text' : 'text-critical-text'"
      role="status"
      data-testid="cred-test-result"
      :data-outcome="result.outcome"
    >
      <CircleCheck
        v-if="tone(result.outcome) === 'ok'"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <CircleAlert v-else class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{{ sentence }}</span>
    </p>
    <p
      v-else-if="error"
      class="text-13 text-critical-text"
      role="alert"
      data-testid="cred-test-error"
    >
      {{ error }}
    </p>
  </fieldset>
</template>
