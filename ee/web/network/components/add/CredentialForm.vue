<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { TriangleAlert } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import { networkApi, type Credential } from '../../api';

// A new read-only credential profile (ADR-233): SNMPv3 by default (SHA-256 and AES, authPriv),
// v2c with its clear-text warning, or RouterOS over REST, API-SSL, or the plain API only with
// "allow unencrypted on this network". Keys are write-only: never shown again.
const emit = defineEmits<{ created: [id: string]; cancel: [] }>();
const { t } = useI18n();

const name = ref('');
const protocol = ref<'snmp' | 'routeros'>('snmp');
const version = ref<'3' | '2c'>('3');
const user = ref('');
const authProto = ref('SHA256');
const privProto = ref('AES');
const authKey = ref('');
const privKey = ref('');
const community = ref('');
const password = ref('');
const transport = ref<'rest' | 'api-ssl' | 'api'>('rest');
const allowPlain = ref(false);

const AUTH = ['SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'];
const PRIV = ['AES', 'AES192', 'AES256'];

const problem = computed(() => {
  if (!name.value.trim()) return t('netAdd.cred.needName');
  if (protocol.value === 'snmp') {
    if (version.value === '3') {
      if (!user.value.trim()) return t('netAdd.cred.needUser');
      if (authKey.value.length < 8 || privKey.value.length < 8) return t('netAdd.cred.needKeys');
    } else if (!community.value) return t('netAdd.cred.needCommunity');
  } else {
    if (!user.value.trim()) return t('netAdd.cred.needUser');
    if (!password.value) return t('netAdd.cred.needPassword');
    if (transport.value === 'api' && !allowPlain.value) return t('netAdd.cred.needAllowPlain');
  }
  return '';
});

const saving = ref(false);
const error = ref('');
const tried = ref(false);
async function save() {
  tried.value = true;
  if (problem.value) return;
  let settings: Credential['settings'];
  let secret: Record<string, string>;
  if (protocol.value === 'snmp') {
    settings =
      version.value === '3'
        ? {
            version: '3',
            user: user.value.trim(),
            authProto: authProto.value,
            privProto: privProto.value,
          }
        : { version: '2c' };
    secret =
      version.value === '3'
        ? { authKey: authKey.value, privKey: privKey.value }
        : { community: community.value };
  } else {
    settings = {
      user: user.value.trim(),
      transport: transport.value,
      allowPlain: transport.value === 'api' && allowPlain.value,
    };
    secret = { password: password.value };
  }
  saving.value = true;
  error.value = '';
  try {
    const r = await networkApi.createCredential({
      name: name.value.trim(),
      protocol: protocol.value,
      settings,
      secret,
    });
    authKey.value = privKey.value = community.value = password.value = '';
    emit('created', r.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('netAdd.cred.failed');
  } finally {
    saving.value = false;
  }
}

const select =
  'h-9 rounded-control border border-border bg-surface-3 px-3 text-14 text-text focus:border-border-strong max-lg:h-11 max-md:text-16';
</script>

<template>
  <form
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-2 p-4"
    data-testid="cred-form"
    @submit.prevent="save"
  >
    <div class="grid gap-3 sm:grid-cols-2">
      <TextField
        v-model="name"
        :label="$t('netAdd.cred.name')"
        :placeholder="$t('netAdd.cred.namePlaceholder')"
        :maxlength="64"
      />
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-13 font-medium text-text">
          {{ $t('netAdd.cred.protocol') }}
        </legend>
        <div class="flex flex-wrap gap-4 text-13 text-text">
          <label class="inline-flex items-center gap-2 max-lg:min-h-11"
            ><input v-model="protocol" type="radio" value="snmp" class="size-4 accent-primary" />{{
              $t('netAdd.cred.snmp')
            }}</label
          >
          <label class="inline-flex items-center gap-2 max-lg:min-h-11"
            ><input
              v-model="protocol"
              type="radio"
              value="routeros"
              class="size-4 accent-primary"
            />{{ $t('netAdd.cred.routeros') }}</label
          >
        </div>
      </fieldset>
    </div>

    <template v-if="protocol === 'snmp'">
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-13 font-medium text-text">
          {{ $t('netAdd.cred.version') }}
        </legend>
        <div class="flex flex-wrap gap-4 text-13 text-text">
          <label class="inline-flex items-center gap-2 max-lg:min-h-11"
            ><input v-model="version" type="radio" value="3" class="size-4 accent-primary" />{{
              $t('netAdd.cred.v3')
            }}</label
          >
          <label class="inline-flex items-center gap-2 max-lg:min-h-11"
            ><input v-model="version" type="radio" value="2c" class="size-4 accent-primary" />{{
              $t('netAdd.cred.v2c')
            }}</label
          >
        </div>
      </fieldset>
      <div v-if="version === '3'" class="grid gap-3 sm:grid-cols-2">
        <TextField
          v-model="user"
          :label="$t('netAdd.cred.user')"
          autocomplete="off"
          :maxlength="64"
        />
        <div class="hidden sm:block" />
        <div class="flex flex-col gap-1.5">
          <label for="cred-auth" class="text-13 font-medium text-text">{{
            $t('netAdd.cred.authProto')
          }}</label>
          <select id="cred-auth" v-model="authProto" :class="select">
            <option v-for="a in AUTH" :key="a" :value="a">
              {{ a === 'SHA' ? 'SHA-1' : a.replace('SHA', 'SHA-') }}
            </option>
          </select>
        </div>
        <TextField
          v-model="authKey"
          type="password"
          autocomplete="new-password"
          :label="$t('netAdd.cred.authKey')"
          :hint="$t('netAdd.cred.keyHint')"
          :maxlength="128"
        />
        <div class="flex flex-col gap-1.5">
          <label for="cred-priv" class="text-13 font-medium text-text">{{
            $t('netAdd.cred.privProto')
          }}</label>
          <select id="cred-priv" v-model="privProto" :class="select">
            <option v-for="p in PRIV" :key="p" :value="p">
              {{ p === 'AES' ? 'AES-128' : p.replace('AES', 'AES-') }}
            </option>
          </select>
        </div>
        <TextField
          v-model="privKey"
          type="password"
          autocomplete="new-password"
          :label="$t('netAdd.cred.privKey')"
          :hint="$t('netAdd.cred.keyHint')"
          :maxlength="128"
        />
      </div>
      <div v-else class="flex flex-col gap-3">
        <TextField
          v-model="community"
          type="password"
          autocomplete="new-password"
          :label="$t('netAdd.cred.community')"
          :maxlength="128"
        />
        <p
          class="flex items-start gap-2 rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-13 text-text"
          role="note"
          data-testid="cred-v2c-note"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden="true" />{{
            $t('netAdd.cred.v2cNote')
          }}
        </p>
      </div>
    </template>

    <template v-else>
      <div class="grid gap-3 sm:grid-cols-2">
        <TextField
          v-model="user"
          :label="$t('netAdd.cred.user')"
          autocomplete="off"
          :maxlength="64"
        />
        <TextField
          v-model="password"
          type="password"
          autocomplete="new-password"
          :label="$t('netAdd.cred.password')"
          :maxlength="128"
        />
      </div>
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1.5 text-13 font-medium text-text">
          {{ $t('netAdd.cred.transport') }}
        </legend>
        <div class="flex flex-col gap-2 text-13 text-text">
          <label
            v-for="tr in ['rest', 'api-ssl', 'api'] as const"
            :key="tr"
            class="inline-flex items-start gap-2 max-lg:min-h-11 max-lg:items-center"
          >
            <input
              v-model="transport"
              type="radio"
              :value="tr"
              class="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span class="flex flex-col">
              <span>{{ $t(`netAdd.cred.transports.${tr}`) }}</span>
              <span class="text-12 text-text-muted">{{
                $t(`netAdd.cred.transportsHint.${tr}`)
              }}</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div
        v-if="transport === 'api'"
        class="flex flex-col gap-2 rounded-control border border-warning/40 bg-warning/10 px-3 py-2"
        data-testid="cred-plain-warning"
      >
        <p class="flex items-start gap-2 text-13 text-text" role="note">
          <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden="true" />{{
            $t('netAdd.cred.plainWarning')
          }}
        </p>
        <label class="inline-flex items-center gap-2 text-13 text-text max-lg:min-h-11">
          <input v-model="allowPlain" type="checkbox" class="size-4 accent-primary" />{{
            $t('netAdd.cred.allowPlain')
          }}
        </label>
      </div>
    </template>

    <p class="text-12 text-text-subtle">{{ $t('netAdd.cred.stored') }}</p>
    <p v-if="error || (tried && problem)" class="text-13 text-critical-text" role="alert">
      {{ error || problem }}
    </p>
    <div class="flex flex-wrap gap-2">
      <BaseButton type="submit" :loading="saving">{{ $t('netAdd.cred.save') }}</BaseButton>
      <BaseButton variant="secondary" @click="emit('cancel')">{{ $t('common.cancel') }}</BaseButton>
    </div>
  </form>
</template>
