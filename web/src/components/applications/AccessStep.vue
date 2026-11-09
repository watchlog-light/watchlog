<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CheckCircle2, CircleAlert, Loader2, TriangleAlert } from '@lucide/vue';
import type { CreateProbeRequest, CreateProbeResponse, Probe } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import TextField from '@/components/ui/TextField.vue';
import {
  accessOptions,
  serviceName,
  type AccessMethod,
  type ConnectTarget,
} from '@/lib/applications';

// How WatchLog logs in to a service, and the test that proves it (ADR-134): nothing to
// set up, a user WatchLog generates with the exact command to run once, an existing
// user, or a Secret (Kubernetes) or file (Docker) WatchLog only references. Each choice
// starts a probe the collector tries every 5 s for 15 minutes; this polls it every 5 s
// and "Check now" asks for a try at once. Used by the connect and settings drawers.
const props = defineProps<{ service: ConnectTarget; integrationId?: string }>();
const emit = defineEmits<{ probe: [probe: Probe | null] }>();
const { t } = useI18n();

const options = computed(() => accessOptions(props.service.type));
const method = ref<AccessMethod>(options.value[0]!);
const username = ref('');
const password = ref('');
const secretName = ref('');
const secretKey = ref('password');
const file = ref('');
const k8s = computed(() => props.service.cluster.kind === 'kubernetes');

const probe = ref<Probe | null>(null);
const command = ref<string | null>(null);
const commands = ref<string[]>([]);
const mount = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
function poll() {
  stopPolling();
  timer = setInterval(async () => {
    if (!probe.value || probe.value.status !== 'pending') return stopPolling();
    try {
      probe.value = (await api<{ probe: Probe }>(`/applications/probes/${probe.value.id}`)).probe;
      emit('probe', probe.value);
    } catch {
      // the next tick tries again
    }
  }, 5000);
}
onBeforeUnmount(stopPolling);

function body(): CreateProbeRequest {
  const access: CreateProbeRequest['access'] = { method: method.value };
  if (method.value === 'entered')
    Object.assign(access, { username: username.value, password: password.value });
  if (method.value === 'reference') {
    if (username.value) access.username = username.value;
    if (k8s.value) access.secret = { name: secretName.value.trim(), key: secretKey.value.trim() };
    else access.file = file.value.trim();
  }
  return {
    clusterId: props.service.cluster.id,
    type: props.service.type as CreateProbeRequest['type'],
    target: props.service.target,
    ...(props.service.collectorHost ? { collectorHost: props.service.collectorHost } : {}),
    ...(props.integrationId ? { integrationId: props.integrationId } : {}),
    access,
  };
}

async function start() {
  busy.value = true;
  error.value = null;
  try {
    const res = await api<CreateProbeResponse>('/applications/probes', {
      method: 'POST',
      body: body(),
    });
    probe.value = res.probe;
    command.value = res.command ?? null;
    commands.value = res.commands ?? [];
    mount.value = res.mount ?? null;
    // The password is in the command only; it isn't kept in this form.
    password.value = '';
    emit('probe', res.probe);
    poll();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function checkNow() {
  if (!probe.value) return;
  busy.value = true;
  try {
    probe.value = (
      await api<{ probe: Probe }>(`/applications/probes/${probe.value.id}/check`, {
        method: 'POST',
      })
    ).probe;
    emit('probe', probe.value);
    poll();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function choose(m: AccessMethod) {
  method.value = m;
  probe.value = null;
  command.value = null;
  commands.value = [];
  mount.value = null;
  error.value = null;
  stopPolling();
  emit('probe', null);
  if (m === 'none') void start();
}
onMounted(() => {
  if (method.value === 'none') void start();
});
watch(
  () => props.service,
  () => choose(options.value[0]!),
);

const canTest = computed(() => {
  if (method.value === 'entered') return !!username.value && !!password.value;
  if (method.value === 'reference')
    return k8s.value ? !!secretName.value && !!secretKey.value : !!file.value;
  return true;
});
const facts = computed(() =>
  Object.entries(probe.value?.result?.facts ?? {})
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · '),
);
const statusText = computed(() => {
  const p = probe.value;
  if (!p) return '';
  if (p.status === 'ok') {
    const what = `${serviceName(props.service.type)}${p.result?.version ? ` ${p.result.version}` : ''}`;
    return (
      t('applications.access.ok', { service: what }) + (facts.value ? ` · ${facts.value}` : '')
    );
  }
  if (p.status === 'failed')
    return t('applications.access.failed', { error: p.result?.error ?? '—' });
  return p.result?.error
    ? t('applications.access.retrying', { error: p.result.error, n: p.attempts })
    : t('applications.access.trying');
});
</script>

<template>
  <section class="flex flex-col gap-3" data-testid="access-step">
    <h3 class="text-14 font-semibold text-text">{{ $t('applications.access.title') }}</h3>
    <div
      v-if="options.length > 1"
      role="radiogroup"
      :aria-label="$t('applications.access.title')"
      class="flex flex-col gap-2"
    >
      <label
        v-for="o in options"
        :key="o"
        :class="[
          'flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5',
          method === o ? 'border-border-strong bg-surface-2' : 'border-border hover:bg-surface-2',
        ]"
        :data-access="o"
      >
        <input
          type="radio"
          name="access"
          class="mt-1"
          :checked="method === o"
          @change="choose(o)"
        />
        <span class="flex flex-col gap-0.5">
          <span class="text-13 font-medium text-text">
            {{ $t(`applications.access.${o}.label`) }}
            <span v-if="o === 'generated'" class="ml-1 text-12 font-normal text-ok">{{
              $t('applications.access.recommended')
            }}</span>
          </span>
          <span class="text-12 text-text-muted">{{
            $t(`applications.access.${o}.${o === 'reference' ? (k8s ? 'k8s' : 'docker') : 'hint'}`)
          }}</span>
        </span>
      </label>
    </div>

    <div v-if="method === 'entered'" class="grid gap-3 sm:grid-cols-2">
      <TextField
        v-model="username"
        :label="$t('applications.access.username')"
        autocomplete="off"
      />
      <TextField
        v-model="password"
        type="password"
        :label="$t('applications.access.password')"
        autocomplete="new-password"
      />
    </div>
    <div v-else-if="method === 'reference'" class="grid gap-3 sm:grid-cols-2">
      <TextField
        v-model="username"
        :label="$t('applications.access.usernameOptional')"
        autocomplete="off"
      />
      <template v-if="k8s">
        <TextField v-model="secretName" :label="$t('applications.access.secretName')" />
        <TextField v-model="secretKey" :label="$t('applications.access.secretKey')" />
      </template>
      <TextField
        v-else
        v-model="file"
        :label="$t('applications.access.file')"
        :hint="$t('applications.access.fileHint')"
      />
    </div>

    <div v-if="method !== 'none' && !probe" class="flex justify-start">
      <BaseButton
        variant="secondary"
        :loading="busy"
        :disabled="!canTest"
        data-testid="access-start"
        @click="start"
      >
        {{
          method === 'generated'
            ? $t('applications.access.makeCommand')
            : $t('applications.access.test')
        }}
      </BaseButton>
    </div>

    <div v-if="command" class="flex flex-col gap-1.5" data-testid="access-command">
      <p class="text-13 text-text-muted">{{ $t('applications.access.runOnce') }}</p>
      <CodeBlock :code="command" :label="$t('applications.access.commandLabel')" />
      <p class="text-12 text-text-subtle">{{ $t('applications.access.shownOnce') }}</p>
    </div>
    <div v-if="commands.length" class="flex flex-col gap-1.5" data-testid="access-commands">
      <p class="text-13 text-text-muted">
        {{ k8s ? $t('applications.access.grantSecret') : $t('applications.access.writeFile') }}
      </p>
      <CodeBlock :code="commands.join('\n')" :label="$t('applications.access.commandLabel')" />
      <template v-if="mount">
        <p class="text-13 text-text-muted">{{ $t('applications.access.mount') }}</p>
        <CodeBlock :code="mount" :label="$t('applications.access.commandLabel')" />
      </template>
    </div>

    <p v-if="error" role="alert" class="text-13 text-critical">{{ error }}</p>
    <div
      v-if="probe"
      :class="[
        'flex flex-wrap items-center gap-2.5 rounded-control border px-3 py-2.5 text-13',
        probe.status === 'ok'
          ? 'border-ok/40 bg-ok/5 text-text'
          : probe.status === 'failed'
            ? 'border-critical/40 bg-critical/5 text-text'
            : 'border-border bg-surface-2 text-text-muted',
      ]"
      role="status"
      data-testid="probe-status"
      :data-status="probe.status"
    >
      <CheckCircle2
        v-if="probe.status === 'ok'"
        class="size-4 shrink-0 text-ok"
        aria-hidden="true"
      />
      <CircleAlert
        v-else-if="probe.status === 'failed'"
        class="size-4 shrink-0 text-critical"
        aria-hidden="true"
      />
      <Loader2 v-else class="size-4 shrink-0 animate-spin" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ statusText }}</span>
      <BaseButton
        v-if="probe.status !== 'ok'"
        variant="secondary"
        :loading="busy"
        data-testid="check-now"
        @click="checkNow"
      >
        {{
          probe.status === 'failed'
            ? $t('applications.access.checkAgain')
            : $t('applications.access.checkNow')
        }}
      </BaseButton>
    </div>
    <p
      v-if="probe?.result?.excess?.length"
      class="flex items-start gap-2 text-13 text-warning"
      data-testid="excess"
    >
      <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {{ $t('applications.access.excess', { privileges: probe.result.excess.join(', ') }) }}
    </p>
  </section>
</template>
