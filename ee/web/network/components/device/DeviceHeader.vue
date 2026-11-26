<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ArrowLeft, ShieldAlert } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import BaseButton from '@/components/ui/BaseButton.vue';
import { LINKS } from '@/lib/links';
import { since } from '@/lib/time';
import { useAuthStore } from '@/stores/auth';
import { networkApi, type DeviceDetail } from '../../api';
import { withValue } from '../../lib/device-view';
import { statusTone, uptimeText } from '../../lib/format';
import KindIcon from '../KindIcon.vue';
import StrengthMark from '../StrengthMark.vue';

// A device's name, state and facts (ADR-233); a RouterOS device or a recorder whose certificate
// changed says so first, with "Accept" for Owners.
const props = defineProps<{ detail: DeviceDetail }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();
const d = computed(() => props.detail.device);

const TONES = {
  ok: 'bg-ok/15 text-ok-text',
  warning: 'bg-warning/15 text-warning-text',
  critical: 'bg-critical/15 text-critical-text',
  neutral: 'bg-surface-3 text-text-muted',
} as const;
// The pill is the device's own state (0.17.1): open alerts are a chip of their own beside it, not
// an amber "Up" (the map's ring and the lists still mix them in).
const tone = computed(() => TONES[statusTone(d.value.status)]);

const facts = computed(() => {
  const v = d.value;
  const poller = v.poller.host ? `${v.poller.name} · ${v.poller.host}` : v.poller.name;
  // A fact with no value isn't shown (1.0.0): a recorder reports no uptime, an access point
  // read through its controller no serial; "Uptime –" said nothing.
  const rows: {
    label: string;
    value: string | null;
    mono?: boolean;
    strength?: 'older' | 'plain' | null;
  }[] = [
    {
      label: t('netDevice.facts.model'),
      value: [v.vendor, v.model].filter(Boolean).join(' ') || null,
    },
    { label: t('netDevice.facts.firmware'), value: v.firmware || null, mono: true },
    { label: t('netDevice.facts.serial'), value: v.serial || null, mono: true },
    { label: t('netDevice.facts.uptime'), value: v.uptimeS != null ? uptimeText(v.uptimeS) : null },
    { label: t('netDevice.facts.address'), value: v.address, mono: true },
    { label: t('netDevice.facts.poller'), value: poller },
    // An access point read through its controller has no profile of its own.
    ...(v.managedAp && v.parentId
      ? []
      : [
          {
            label: t('netDevice.facts.profile'),
            value: v.credential
              ? t('netDevice.facts.profileValue', {
                  name: v.credential.name,
                  protocol: t(`net.protocol.${v.credential.protocol}`),
                })
              : null,
            // MD5 or DES, or no SNMPv3 privacy: a small mark beside it (1.0.4).
            strength: v.credential?.strength ?? null,
          },
        ]),
    {
      label: t('netDevice.facts.polled'),
      value: v.polledAt ? t('netDevice.ago', { t: since(v.polledAt) }) : t('netDevice.facts.never'),
    },
  ];
  if (v.managedAp)
    rows.push({
      label: t('netDevice.facts.readVia'),
      value: v.parentName
        ? t('netDevice.facts.readViaValue', { name: v.parentName })
        : t('net.protocol.capsman'),
    });
  if (v.location) rows.push({ label: t('netDevice.facts.location'), value: v.location });
  return withValue(rows);
});

/** Its collector is older than 1.0.4 and can't read its profile: said in words, with a link. */
const olderCollector = computed(() => {
  const what = d.value.olderCollector;
  if (!what) return '';
  const p = d.value.poller;
  const server = p.kind === 'kubernetes' ? p.name : p.host || p.name;
  return t('netAdd.test.outcome.collector_old', { server, what });
});
/** A QNAP that can't be read (1.0.4): a new profile for it is SHA with DES. */
const qnapHint = computed(
  () =>
    auth.canManage &&
    /qnap/i.test(d.value.vendor) &&
    d.value.status !== 'ok' &&
    d.value.protocol === 'snmp' &&
    !d.value.olderCollector,
);

const routerOs = computed(() => d.value.protocol === 'routeros');
const update = computed(() => {
  const u = d.value.update;
  if (!routerOs.value || !u) return null;
  const newer = !!u.latest && !!u.installed && u.latest !== u.installed;
  return { ...u, newer };
});

// RouterOS and recorders over HTTPS pin their certificate.
const certChanged = computed(
  () => (routerOs.value || d.value.protocol === 'dahua') && d.value.status === 'cert_changed',
);
const isOwner = computed(() => auth.user?.role === 'owner' && auth.canManage);
// An accept made by mistake (1.0.2): an Owner pins the certificate from before again.
const canUndo = computed(() => !!d.value.certUndo && !certChanged.value);
const undoing = ref(false);
const undoError = ref('');
async function undoAccept() {
  undoing.value = true;
  undoError.value = '';
  try {
    await networkApi.restoreCertificate(d.value.id);
    emit('changed');
  } catch (err) {
    undoError.value = err instanceof Error ? err.message : t('netDevice.cert.failed');
  } finally {
    undoing.value = false;
  }
}
const accepting = ref(false);
const acceptError = ref('');
async function accept() {
  accepting.value = true;
  acceptError.value = '';
  try {
    await networkApi.acceptCertificate(d.value.id);
    emit('changed');
  } catch (err) {
    acceptError.value = err instanceof Error ? err.message : t('netDevice.cert.failed');
  } finally {
    accepting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <RouterLink
      :to="{ name: 'network-devices' }"
      class="inline-flex w-fit items-center gap-1.5 text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{ $t('netDevice.back') }}
    </RouterLink>

    <section
      v-if="canUndo"
      class="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-1 p-4"
      data-testid="cert-accepted"
    >
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="text-14 font-semibold text-text">{{ $t('netDevice.cert.acceptedTitle') }}</h2>
        <p class="max-w-prose text-13 text-text-muted">{{ $t('netDevice.cert.acceptedBody') }}</p>
        <p v-if="undoError" class="text-13 text-critical-text" role="alert">{{ undoError }}</p>
      </div>
      <BaseButton
        v-if="isOwner"
        variant="secondary"
        :loading="undoing"
        data-testid="cert-undo"
        @click="undoAccept"
      >
        {{ $t('netDevice.cert.undo') }}
      </BaseButton>
      <span v-else class="text-13 text-text-muted">{{ $t('netDevice.cert.ownerOnly') }}</span>
    </section>
    <section
      v-if="certChanged"
      role="alert"
      class="flex flex-col gap-3 rounded-card border border-critical bg-critical/10 p-4"
      data-testid="cert-changed"
    >
      <div class="flex items-start gap-3">
        <ShieldAlert class="mt-0.5 size-5 shrink-0 text-critical-text" aria-hidden="true" />
        <div class="flex min-w-0 flex-col gap-1">
          <h2 class="text-14 font-semibold text-text">{{ $t('netDevice.cert.title') }}</h2>
          <p class="text-13 text-text-muted">{{ $t('netDevice.cert.body') }}</p>
          <dl v-if="d.certificate" class="mt-1 grid gap-1 text-12 text-text-muted">
            <div v-if="d.certificate.pinned" class="flex flex-wrap gap-x-2">
              <dt>{{ $t('netDevice.cert.pinned') }}</dt>
              <dd class="font-mono break-all text-text">{{ d.certificate.pinned }}</dd>
            </div>
            <div v-if="d.certificate.seen" class="flex flex-wrap gap-x-2">
              <dt>{{ $t('netDevice.cert.seen') }}</dt>
              <dd class="font-mono break-all text-text">{{ d.certificate.seen }}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3 sm:pl-8">
        <BaseButton v-if="isOwner" :loading="accepting" data-testid="cert-accept" @click="accept">
          {{ $t('netDevice.cert.accept') }}
        </BaseButton>
        <p v-else class="text-13 text-text-muted">{{ $t('netDevice.cert.ownerOnly') }}</p>
        <p v-if="acceptError" class="text-13 text-critical-text" role="alert">{{ acceptError }}</p>
      </div>
    </section>

    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KindIcon :kind="d.kind" class="size-6 shrink-0 text-text-muted" />
        <h2 class="min-w-0 font-mono text-24 font-medium break-all text-text">{{ d.name }}</h2>
        <span
          class="inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-12 font-semibold"
          :class="tone"
          data-testid="device-status"
          >{{ $t(`net.status.${d.status}`) }}</span
        >
        <span
          v-if="d.openAlerts > 0"
          class="inline-flex h-6 shrink-0 items-center rounded-full bg-warning/15 px-2.5 text-12 font-semibold text-warning-text"
          data-testid="device-open-alerts"
          >{{ $t('netDevice.openAlerts', d.openAlerts) }}</span
        >
        <span class="text-13 text-text-muted">{{ $t(`net.kind.${d.kind}`) }}</span>
      </div>
      <p
        v-if="olderCollector"
        class="text-13 text-critical-text"
        data-testid="device-old-collector"
      >
        {{ olderCollector }}
        <a
          :href="LINKS.collectorUpdate"
          target="_blank"
          rel="noopener"
          class="underline underline-offset-2"
          >{{ $t('netAdd.test.howUpdate') }}</a
        >
      </p>
      <p v-else-if="d.error && d.status !== 'ok'" class="text-13 text-critical-text">
        {{ d.error }}
      </p>
      <p v-if="qnapHint" class="text-13 text-text-muted" data-testid="device-qnap-hint">
        {{ $t('netDevice.qnapHint') }}
        <RouterLink
          :to="{ name: 'network-add', query: { new: 'qnap' } }"
          class="text-primary underline underline-offset-2"
          >{{ $t('netAdd.guide.qnap.make') }}</RouterLink
        >
      </p>
      <p v-if="update" class="text-13 text-text-muted" data-testid="device-update">
        <span class="font-mono text-text">RouterOS {{ update.installed ?? '–' }}</span>
        <template v-if="update.newer">
          ·
          <span class="text-warning-text">{{
            $t('netDevice.update.available', {
              latest: update.latest,
              channel: update.channel ?? '–',
            })
          }}</span>
        </template>
        <template v-else-if="update.latest">
          · {{ $t('netDevice.update.current', { channel: update.channel ?? '–' }) }}
        </template>
      </p>
    </div>

    <dl
      class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 gap-y-3 rounded-card border border-border bg-surface-1 px-4 py-3"
      data-testid="device-facts"
    >
      <div v-for="f in facts" :key="f.label" class="flex min-w-0 flex-col gap-0.5">
        <dt class="text-11 tracking-[0.08em] text-text-subtle uppercase">{{ f.label }}</dt>
        <dd
          class="flex flex-wrap items-center gap-x-2 gap-y-1 text-13 break-words text-text"
          :class="f.mono ? 'font-mono' : ''"
        >
          <span class="min-w-0 break-words">{{ f.value }}</span>
          <StrengthMark v-if="f.strength" :strength="f.strength" />
        </dd>
      </div>
    </dl>
  </div>
</template>
