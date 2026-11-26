<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { CircleAlert, CircleCheck, LoaderCircle } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import { LINKS } from '@/lib/links';
import { authLabel, privLabel } from '../../lib/snmp';
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
  /** An SNMPv3 profile with authentication: "Find what works" can try its protocols (1.0.4). */
  canFind?: boolean;
}>();
const emit = defineEmits<{ use: [found: { authProto: string; privProto: string }] }>();
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
/** Waiting longer than a 1.0.2 collector takes: an older one answers with its next round. */
const slow = ref(false);
const SLOW_MS = 8000;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
watch(running, (on) => {
  clearTimeout(slowTimer);
  slow.value = false;
  if (on) slowTimer = setTimeout(() => (slow.value = true), SLOW_MS);
});
const result = ref<CredentialTest | null>(null);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let run = 0;
onBeforeUnmount(() => {
  run++;
  clearTimeout(timer);
  clearTimeout(slowTimer);
});

const addressOk = computed(() => /^[A-Za-z0-9.:_-]{1,253}$/.test(address.value.trim()));
const cannot = computed(() => {
  if (!options.value.length) return t('netAdd.test.noPoller');
  if (props.problem) return props.problem;
  if (!addressOk.value) return address.value.trim() ? t('netAdd.test.badAddress') : '';
  return '';
});

/** The test was "Find what works": its result offers the protocols that answered. */
const finding = ref(false);
/** Where the last test ran: an old collector's message names it. */
const ranOn = ref('');

async function test(find = false) {
  error.value = '';
  result.value = null;
  finding.value = find;
  if (cannot.value || !from.value || !address.value.trim()) {
    error.value = cannot.value || t('netAdd.test.needAddress');
    return;
  }
  const cut = from.value.indexOf('/');
  ranOn.value = options.value.find((o) => o.value === from.value)?.label ?? '';
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
      ...(find ? { find: true } : {}),
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
  if (r.outcome === 'collector_old')
    return t('netAdd.test.outcome.collector_old', {
      server: ranOn.value || t('netAdd.test.thisPoller'),
      what: r.collector || '',
    });
  if (r.outcome === 'error')
    return t('netAdd.test.outcome.error', { detail: r.detail || t('netAdd.test.failed') });
  return t(`netAdd.test.outcome.${r.outcome}`, { address: r.address });
});
/** "Find what works" answered: which protocols, and how many combinations were tried. */
const foundLine = computed(() => {
  const f = result.value?.found;
  if (!finding.value || !f) return '';
  const what =
    f.privProto === 'NONE'
      ? authLabel(f.authProto)
      : t('netAdd.test.find.pair', { auth: authLabel(f.authProto), priv: privLabel(f.privProto) });
  const n = result.value?.tried ?? 1;
  return t('netAdd.test.find.answered', { what, n }, n);
});
/** Nothing answered any combination: say how many were tried. */
const triedLine = computed(() =>
  finding.value && result.value && result.value.outcome !== 'answered' && result.value.tried
    ? t('netAdd.test.find.none', { n: result.value.tried })
    : '',
);
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
      <BaseButton
        variant="secondary"
        :loading="running && !finding"
        :disabled="running && finding"
        data-testid="cred-test-run"
        @click="test()"
      >
        {{ $t('netAdd.test.run') }}
      </BaseButton>
    </div>
    <div v-if="canFind" class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <BaseButton
        variant="ghost"
        :loading="running && finding"
        :disabled="running && !finding"
        data-testid="cred-test-find"
        @click="test(true)"
      >
        {{ $t('netAdd.test.find.run') }}
      </BaseButton>
      <span class="text-12 text-text-muted">{{ $t('netAdd.test.find.hint') }}</span>
    </div>
    <p
      v-if="running"
      class="flex items-center gap-2 text-13 text-text-muted"
      role="status"
      data-testid="cred-test-running"
    >
      <LoaderCircle class="size-4 shrink-0 animate-spin" aria-hidden="true" />
      <span class="min-w-0"
        >{{ $t('netAdd.test.running') }}
        <span v-if="slow" data-testid="cred-test-slow">{{ $t('netAdd.test.slow') }}</span></span
      >
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
      <span class="min-w-0 break-words"
        >{{ sentence }}
        <a
          v-if="result.outcome === 'collector_old'"
          :href="LINKS.collectorUpdate"
          target="_blank"
          rel="noopener"
          class="underline underline-offset-2"
          data-testid="cred-test-update-link"
          >{{ $t('netAdd.test.howUpdate') }}</a
        ></span
      >
    </p>
    <div
      v-if="!running && foundLine"
      class="flex flex-wrap items-center gap-x-3 gap-y-2 text-13 text-text"
      data-testid="cred-test-found"
    >
      <span class="min-w-0">{{ foundLine }}</span>
      <BaseButton data-testid="cred-test-use" @click="result?.found && emit('use', result.found)">
        {{ $t('netAdd.test.find.use') }}
      </BaseButton>
    </div>
    <p
      v-else-if="!running && triedLine"
      class="text-12 text-text-muted"
      data-testid="cred-test-tried"
    >
      {{ triedLine }}
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
