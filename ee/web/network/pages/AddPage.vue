<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { Cctv, Info, Lock, Plus, Search } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import BaseButton from '@/components/ui/BaseButton.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import TextField from '@/components/ui/TextField.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useAuthStore } from '@/stores/auth';
import { networkApi, type Credential, type Found, type PollerChoice } from '../api';
import CredentialForm from '../components/add/CredentialForm.vue';
import FoundList from '../components/add/FoundList.vue';
import PollerStep from '../components/add/PollerStep.vue';
import SetupCommands from '../components/add/SetupCommands.vue';
import NetworkTabs from '../components/NetworkTabs.vue';

// Adding network devices (ADR-233): (1) the place that polls them, (2) read-only credential
// profiles, (3) the addresses to start from, (4) what was found, each tested, (5) add the picked
// ones. Owners and Admins; others see a note. Recorders (Dahua's HTTP API, ADR-234) don't
// announce themselves: they are added by address with a recorder profile, without discovery;
// CAPsMAN's access points come with their controller.
const auth = useAuthStore();
const router = useRouter();
const { t } = useI18n();

const pollers = ref<PollerChoice[]>([]);
const credentials = ref<Credential[]>([]);
const loading = ref(true);
const loadError = ref('');
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [p, c] = await Promise.all([networkApi.pollers(), networkApi.credentials()]);
    pollers.value = p.pollers;
    credentials.value = c.credentials;
    if (!poller.value) {
      // One place that can poll: picked already.
      const ready = p.pollers.flatMap((x) =>
        x.hosts.filter((h) => h.collector).map((h) => ({ clusterId: x.clusterId, host: h.host })),
      );
      if (ready.length === 1) poller.value = ready[0]!;
    }
    if (!chosen.value.length)
      chosen.value = c.credentials
        .filter(discoverable)
        .slice(0, MAX_PROFILES)
        .map((x) => x.id);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : t('netAdd.loadError');
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  if (auth.canManage) void load();
});

// Step 1
const poller = ref<{ clusterId: string; host: string } | null>(null);

// Step 2
const MAX_PROFILES = 8;
/** Profiles discovery can try: SNMP and RouterOS; a recorder's is used by address only. */
const discoverable = (c: Credential) => c.protocol !== 'dahua';
const recorderProfiles = computed(() => credentials.value.filter((c) => !discoverable(c)));
const chosen = ref<string[]>([]);
const creating = ref(false);
function toggleProfile(id: string, on: boolean) {
  chosen.value = on
    ? [...chosen.value, id].slice(0, MAX_PROFILES)
    : chosen.value.filter((x) => x !== id);
}
async function created(id: string) {
  creating.value = false;
  const c = await networkApi.credentials();
  credentials.value = c.credentials;
  const made = c.credentials.find((x) => x.id === id);
  if (made && !discoverable(made)) {
    recorderProfile.value = id;
    return;
  }
  if (!chosen.value.includes(id)) chosen.value = [...chosen.value, id].slice(-MAX_PROFILES);
}
function describe(c: Credential): string {
  const s = c.settings;
  if (c.protocol === 'dahua') {
    return t('netAdd.cred.describeDahua', {
      user: s.user ?? '–',
      scheme: s.https === false ? 'HTTP' : 'HTTPS',
      port: s.port ?? (s.https === false ? 80 : 443),
    });
  }
  if (c.protocol === 'routeros') {
    return t('netAdd.cred.describeRouteros', {
      user: s.user ?? '–',
      transport: t(`netAdd.cred.transports.${s.transport ?? 'rest'}`),
    });
  }
  return s.version === '2c'
    ? t('netAdd.cred.describeV2c')
    : t('netAdd.cred.describeV3', {
        user: s.user ?? '–',
        auth: s.authProto ?? 'SHA',
        priv: s.privProto ?? 'AES',
      });
}

// Step 3
const seedsText = ref('');
const cidr = ref('');
const neighbours = ref(true);
const ADDRESS = /^[A-Za-z0-9.:_-]+$/;
const seeds = computed(() =>
  seedsText.value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);
const badSeed = computed(() => seeds.value.find((s) => s.length > 253 || !ADDRESS.test(s)) ?? null);
const rangeProblem = computed(() => {
  const r = cidr.value.trim();
  if (!r) return '';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(r);
  if (!m || m.slice(1, 5).some((p) => Number(p) > 255))
    return t('netAdd.find.rangeBad', { range: r });
  if (Number(m[5]) < 24 || Number(m[5]) > 32) return t('netAdd.find.rangeWide', { range: r });
  return '';
});
const findProblem = computed(() => {
  if (!poller.value) return t('netAdd.find.needPoller');
  if (!chosen.value.length) return t('netAdd.find.needProfile');
  if (!seeds.value.length && !cidr.value.trim()) return t('netAdd.find.needAddress');
  if (seeds.value.length > 64) return t('netAdd.find.tooMany');
  if (badSeed.value) return t('netAdd.find.badAddress', { address: badSeed.value });
  return rangeProblem.value;
});

const discoveryId = ref<string | null>(null);
const done = ref(false);
const expired = ref(false);
const found = ref<Found[]>([]);
const finding = ref(false);
const findError = ref('');
const picked = ref<string[]>([]);
const seen = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
});

async function find() {
  if (findProblem.value || !poller.value) return;
  clearTimeout(timer);
  finding.value = true;
  findError.value = '';
  found.value = [];
  picked.value = [];
  seen.clear();
  done.value = false;
  expired.value = false;
  try {
    const r = await networkApi.discover({
      clusterId: poller.value.clusterId,
      host: poller.value.host,
      seeds: seeds.value,
      ...(cidr.value.trim() ? { range: cidr.value.trim() } : {}),
      neighbours: neighbours.value,
      credentialIds: chosen.value,
    });
    discoveryId.value = r.id;
    await poll(r.id);
  } catch (err) {
    findError.value = err instanceof Error ? err.message : t('netAdd.find.failed');
  } finally {
    finding.value = false;
  }
}

// Every 2 s until the poller says it's done (or the discovery expired); stops on leaving.
async function poll(id: string) {
  if (!alive || id !== discoveryId.value) return;
  try {
    const r = await networkApi.discovery(id);
    if (!alive || id !== discoveryId.value) return;
    found.value = r.found;
    done.value = r.done;
    expired.value = r.expired;
    // New answers are picked once; what the user unticks stays unticked.
    const fresh = r.found.filter((f) => !seen.has(f.address));
    for (const f of fresh) seen.add(f.address);
    const add = fresh.filter((f) => f.answered && !f.added).map((f) => f.address);
    if (add.length) picked.value = [...new Set([...picked.value, ...add])];
  } catch (err) {
    findError.value = err instanceof Error ? err.message : t('netAdd.find.failed');
  }
  if (!done.value && alive && id === discoveryId.value)
    timer = setTimeout(() => void poll(id), 2000);
}

// Step 5
const toAdd = computed(() =>
  found.value.filter((f) => !f.added && picked.value.includes(f.address)),
);
const PROFILE = /^[a-z0-9-]{0,64}$/;
const adding = ref(false);
const addError = ref('');
const skipped = ref<{ address: string; reason: string }[]>([]);
function fallbackCredential(f: Found): string | undefined {
  const own = credentials.value.filter((c) => chosen.value.includes(c.id));
  return (own.find((c) => c.protocol === (f.protocol ?? 'snmp')) ?? own[0])?.id;
}
async function add() {
  if (!poller.value || !toAdd.value.length) return;
  adding.value = true;
  addError.value = '';
  skipped.value = [];
  try {
    const devices = toAdd.value.flatMap((f) => {
      const credentialId = f.credential || fallbackCredential(f);
      if (!credentialId) return [];
      return [
        {
          address: f.address,
          credentialId,
          ...(f.name ? { name: f.name.slice(0, 253) } : {}),
          ...(f.profile && PROFILE.test(f.profile) ? { profile: f.profile } : {}),
        },
      ];
    });
    const r = await networkApi.addDevices({
      clusterId: poller.value.clusterId,
      host: poller.value.host,
      devices,
    });
    if (r.added.length) {
      await router.push({ name: 'network-devices' });
      return;
    }
    skipped.value = r.skipped;
    addError.value = t('netAdd.add.noneAdded');
  } catch (err) {
    addError.value = err instanceof Error ? err.message : t('netAdd.add.failed');
  } finally {
    adding.value = false;
  }
}

watch(poller, () => {
  // Another place polls from elsewhere: what it finds may differ.
  discoveryId.value = null;
  clearTimeout(timer);
});

// Recorders, by address with a recorder profile (no discovery).
const recorderText = ref('');
const recorderProfile = ref('');
watch(
  recorderProfiles,
  (list) => {
    if (!list.some((c) => c.id === recorderProfile.value))
      recorderProfile.value = list[0]?.id ?? '';
  },
  { immediate: true },
);
const recorderAddresses = computed(() =>
  recorderText.value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);
const recorderProblem = computed(() => {
  if (!poller.value) return t('netAdd.find.needPoller');
  if (!recorderAddresses.value.length) return t('netAdd.find.needAddress');
  if (recorderAddresses.value.length > 64) return t('netAdd.find.tooMany');
  const bad = recorderAddresses.value.find((s) => s.length > 253 || !ADDRESS.test(s));
  if (bad) return t('netAdd.find.badAddress', { address: bad });
  if (!recorderProfile.value) return t('netAdd.recorders.needProfile');
  return '';
});
const addingRecorders = ref(false);
const recorderError = ref('');
const recorderSkipped = ref<{ address: string; reason: string }[]>([]);
async function addRecorders() {
  if (recorderProblem.value || !poller.value) return;
  addingRecorders.value = true;
  recorderError.value = '';
  recorderSkipped.value = [];
  try {
    const r = await networkApi.addDevices({
      clusterId: poller.value.clusterId,
      host: poller.value.host,
      devices: recorderAddresses.value.map((address) => ({
        address,
        credentialId: recorderProfile.value,
      })),
    });
    if (r.added.length) {
      await router.push({ name: 'network-devices' });
      return;
    }
    recorderSkipped.value = r.skipped;
    recorderError.value = t('netAdd.add.noneAdded');
  } catch (err) {
    recorderError.value = err instanceof Error ? err.message : t('netAdd.add.failed');
  } finally {
    addingRecorders.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1200px] min-w-0 flex-col gap-4 p-6 max-md:p-4">
    <NetworkTabs />
    <div class="flex flex-col gap-1">
      <h2 class="text-20 font-semibold text-text">{{ $t('netAdd.title') }}</h2>
      <p class="text-14 text-text-muted">{{ $t('netAdd.readOnly') }}</p>
    </div>

    <section
      v-if="!auth.canManage"
      class="flex items-start gap-3 rounded-card border border-border bg-surface-1 p-4 text-13 text-text-muted"
      data-testid="add-viewer-note"
    >
      <Lock class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ $t('netAdd.viewer') }}
    </section>

    <template v-else-if="loading">
      <SkeletonChart framed />
    </template>
    <ErrorState v-else-if="loadError" :message="loadError" @retry="load" />

    <template v-else>
      <!-- 1 -->
      <section
        class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4 sm:p-5"
        aria-labelledby="s1"
      >
        <h3 id="s1" class="text-16 font-semibold text-text">
          <span class="mr-2 font-mono text-primary">1</span>{{ $t('netAdd.poller.title') }}
        </h3>
        <p class="text-14 text-text-muted">{{ $t('netAdd.poller.intro') }}</p>
        <PollerStep v-model="poller" :pollers="pollers" />
      </section>

      <!-- 2 -->
      <section
        class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4 sm:p-5"
        aria-labelledby="s2"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 id="s2" class="text-16 font-semibold text-text">
            <span class="mr-2 font-mono text-primary">2</span>{{ $t('netAdd.cred.title') }}
          </h3>
          <BaseButton
            v-if="!creating"
            variant="secondary"
            data-testid="cred-new"
            @click="creating = true"
          >
            <Plus class="size-4" aria-hidden="true" />{{ $t('netAdd.cred.new') }}
          </BaseButton>
        </div>
        <p class="text-14 text-text-muted">{{ $t('netAdd.cred.intro', { n: MAX_PROFILES }) }}</p>
        <p v-if="!credentials.length && !creating" class="text-13 text-text-muted">
          {{ $t('netAdd.cred.none') }}
        </p>
        <ul v-if="credentials.length" class="grid gap-2 md:grid-cols-2">
          <li v-for="c in credentials" :key="c.id">
            <label
              class="flex cursor-pointer items-center gap-3 rounded-card border bg-surface-2 px-4 py-3"
              :class="chosen.includes(c.id) ? 'border-primary' : 'border-border'"
            >
              <Cctv
                v-if="!discoverable(c)"
                class="size-[18px] shrink-0 text-text-muted"
                aria-hidden="true"
              />
              <input
                v-else
                type="checkbox"
                class="size-[18px] shrink-0 accent-primary"
                :checked="chosen.includes(c.id)"
                :disabled="!chosen.includes(c.id) && chosen.length >= MAX_PROFILES"
                @change="toggleProfile(c.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="text-14 font-medium break-all text-text">{{ c.name }}</span>
                <span class="text-12 text-text-muted">{{ describe(c) }}</span>
                <span v-if="!discoverable(c)" class="text-12 text-text-subtle">{{
                  $t('netAdd.cred.byAddress')
                }}</span>
              </span>
              <span v-if="c.usedBy" class="shrink-0 text-12 text-text-subtle">{{
                $t('netAdd.cred.usedBy', { n: c.usedBy }, c.usedBy)
              }}</span>
            </label>
          </li>
        </ul>
        <CredentialForm v-if="creating" @created="created" @cancel="creating = false" />
        <details
          class="group rounded-card border border-border bg-surface-2 px-4 py-2"
          data-testid="setup-details"
        >
          <summary
            class="flex min-h-9 cursor-pointer items-center text-13 max-lg:min-h-11 text-text-muted hover:text-text"
          >
            {{ $t('netAdd.setup.title') }}
          </summary>
          <div class="pt-2 pb-2">
            <SetupCommands :credentials="credentials" :preferred="chosen" />
          </div>
        </details>
      </section>

      <!-- 3 -->
      <section
        class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4 sm:p-5"
        aria-labelledby="s3"
      >
        <h3 id="s3" class="text-16 font-semibold text-text">
          <span class="mr-2 font-mono text-primary">3</span>{{ $t('netAdd.find.title') }}
        </h3>
        <p class="text-14 text-text-muted">{{ $t('netAdd.find.intro') }}</p>
        <div class="grid gap-3 md:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <label for="add-seeds" class="text-13 font-medium text-text">{{
              $t('netAdd.find.seeds')
            }}</label>
            <textarea
              id="add-seeds"
              v-model="seedsText"
              rows="4"
              class="rounded-control border border-border bg-surface-3 px-3 py-2 font-mono text-14 text-text placeholder:text-text-subtle focus:border-border-strong max-md:text-16"
              placeholder="10.0.10.1&#10;10.0.10.2"
              data-testid="add-seeds"
            />
            <p class="text-12 text-text-muted">{{ $t('netAdd.find.seedsHint') }}</p>
          </div>
          <div class="flex flex-col gap-3">
            <TextField
              v-model="cidr"
              :label="$t('netAdd.find.range')"
              :hint="$t('netAdd.find.rangeHint')"
              :error="rangeProblem || undefined"
              placeholder="10.0.10.0/24"
              :maxlength="64"
            />
            <ToggleSwitch v-model="neighbours" class="max-lg:min-h-11">{{
              $t('netAdd.find.neighbours')
            }}</ToggleSwitch>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <BaseButton
            :loading="finding"
            :disabled="!!findProblem"
            data-testid="add-find"
            @click="find"
          >
            <Search class="size-4" aria-hidden="true" />{{ $t('netAdd.find.start') }}
          </BaseButton>
          <span v-if="findProblem && (seedsText || cidr)" class="text-13 text-text-muted">{{
            findProblem
          }}</span>
        </div>
        <p v-if="findError" class="text-13 text-critical-text" role="alert">{{ findError }}</p>
        <p
          class="flex items-start gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-13 text-text-muted"
          role="note"
          data-testid="add-capsman-note"
        >
          <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ $t('netAdd.capsman') }}
        </p>

        <div
          class="flex flex-col gap-3 border-t border-border pt-4"
          data-testid="add-recorders"
          role="group"
          aria-labelledby="s3-rec"
        >
          <h4 id="s3-rec" class="text-14 font-semibold text-text">
            {{ $t('netAdd.recorders.title') }}
          </h4>
          <p class="text-13 text-text-muted">{{ $t('netAdd.recorders.intro') }}</p>
          <p v-if="!recorderProfiles.length" class="text-13 text-text-muted">
            {{ $t('netAdd.recorders.noProfile') }}
          </p>
          <template v-else>
            <div class="grid gap-3 md:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <label for="add-recorders" class="text-13 font-medium text-text">{{
                  $t('netAdd.find.seeds')
                }}</label>
                <textarea
                  id="add-recorders"
                  v-model="recorderText"
                  rows="3"
                  class="rounded-control border border-border bg-surface-3 px-3 py-2 font-mono text-14 text-text placeholder:text-text-subtle focus:border-border-strong max-md:text-16"
                  placeholder="10.0.30.21"
                  data-testid="add-recorder-addresses"
                />
                <p class="text-12 text-text-muted">{{ $t('netAdd.find.seedsHint') }}</p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="add-recorder-profile" class="text-13 font-medium text-text">{{
                  $t('netAdd.recorders.profile')
                }}</label>
                <select
                  id="add-recorder-profile"
                  v-model="recorderProfile"
                  class="h-9 rounded-control border border-border bg-surface-3 px-3 text-14 text-text max-lg:h-11 max-md:text-16"
                  data-testid="add-recorder-profile"
                >
                  <option v-for="c in recorderProfiles" :key="c.id" :value="c.id">
                    {{ c.name }}
                  </option>
                </select>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <BaseButton
                :loading="addingRecorders"
                :disabled="!!recorderProblem"
                data-testid="add-recorders-submit"
                @click="addRecorders"
              >
                <Plus class="size-4" aria-hidden="true" />{{
                  $t(
                    'netAdd.recorders.button',
                    { n: recorderAddresses.length },
                    recorderAddresses.length,
                  )
                }}
              </BaseButton>
              <span v-if="recorderProblem && recorderText" class="text-13 text-text-muted">{{
                recorderProblem
              }}</span>
            </div>
            <p v-if="recorderError" class="text-13 text-critical-text" role="alert">
              {{ recorderError }}
            </p>
            <ul v-if="recorderSkipped.length" class="text-13 text-text-muted">
              <li v-for="x in recorderSkipped" :key="x.address">
                <span class="font-mono">{{ x.address }}</span> · {{ x.reason }}
              </li>
            </ul>
          </template>
        </div>
      </section>

      <!-- 4 -->
      <section
        v-if="discoveryId"
        class="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface-1 p-4 sm:p-5"
        aria-labelledby="s4"
      >
        <h3 id="s4" class="text-16 font-semibold text-text">
          <span class="mr-2 font-mono text-primary">4</span>{{ $t('netAdd.found.title') }}
        </h3>
        <p
          class="text-14 text-text-muted"
          role="status"
          aria-live="polite"
          data-testid="found-status"
        >
          <template v-if="expired">{{
            $t('netAdd.found.expired', { n: found.length }, found.length)
          }}</template>
          <template v-else-if="done">{{
            $t('netAdd.found.done', { n: found.length }, found.length)
          }}</template>
          <template v-else>{{
            $t('netAdd.found.searching', { n: found.length }, found.length)
          }}</template>
        </p>
        <FoundList v-if="found.length" v-model="picked" :found="found" :credentials="credentials" />
      </section>

      <!-- 5 -->
      <section
        v-if="discoveryId"
        class="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-1 p-4 sm:p-5"
        aria-labelledby="s5"
      >
        <div class="flex min-w-0 flex-col gap-1">
          <h3 id="s5" class="text-16 font-semibold text-text">
            <span class="mr-2 font-mono text-primary">5</span
            >{{ $t('netAdd.add.title', { n: toAdd.length }, toAdd.length) }}
          </h3>
          <p class="text-14 text-text-muted">{{ $t('netAdd.add.after') }}</p>
          <p v-if="addError" class="text-13 text-critical-text" role="alert">{{ addError }}</p>
          <ul v-if="skipped.length" class="text-13 text-text-muted">
            <li v-for="s in skipped" :key="s.address">
              <span class="font-mono">{{ s.address }}</span> · {{ s.reason }}
            </li>
          </ul>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="secondary" @click="router.push({ name: 'network-devices' })">{{
            $t('common.cancel')
          }}</BaseButton>
          <BaseButton
            :loading="adding"
            :disabled="!toAdd.length"
            data-testid="add-submit"
            @click="add"
          >
            {{ $t('netAdd.add.button', { n: toAdd.length }, toAdd.length) }}
          </BaseButton>
        </div>
      </section>
    </template>
  </div>
</template>
