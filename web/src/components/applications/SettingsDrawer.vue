<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Application, ApplicationAccess, Probe } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import AccessStep from '@/components/applications/AccessStep.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useLoader } from '@/composables/useLoader';
import { accessOptions, type ConnectTarget } from '@/lib/applications';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

// A service's settings (ADR-133, ADR-140): its access as "set by … on …, last verified …"
// (never the password), the switches, and the log of who did what. Owners and Admins can
// change the access through the same test as the connect drawer, pause it, switch query
// text, or stop monitoring it; Viewers read.
const props = defineProps<{ app: Application }>();
const emit = defineEmits<{ changed: [] }>();
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const toast = useToastStore();

const data = useLoader(() => api<ApplicationAccess>(`/applications/${props.app.id}/access`));
onMounted(data.load);
const changing = ref(false);
const probe = ref<Probe | null>(null);
const saving = ref(false);

const target = computed<ConnectTarget>(() => ({
  cluster: props.app.cluster,
  type: props.app.type,
  name: props.app.name,
  version: props.app.version,
  image: null,
  port: null,
  host: props.app.where.host,
  group: props.app.where.group,
  target: props.app.target,
}));
const hasUser = computed(() => accessOptions(props.app.type).some((o) => o !== 'none'));

async function run(fn: () => Promise<unknown>, done: string) {
  saving.value = true;
  try {
    await fn();
    toast.show(done);
    await data.load();
    emit('changed');
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    saving.value = false;
  }
}
const saveAccess = () =>
  run(async () => {
    await api(`/applications/${props.app.id}/access`, {
      method: 'PUT',
      body: { probeId: probe.value!.id },
    });
    changing.value = false;
    probe.value = null;
  }, t('applications.settings.accessSaved'));
const removeAccess = () =>
  run(
    () => api(`/applications/${props.app.id}/access`, { method: 'DELETE' }),
    t('applications.settings.accessRemoved'),
  );
const patch = (body: { paused?: boolean; queryText?: boolean }) =>
  run(
    () => api(`/applications/${props.app.id}`, { method: 'PATCH', body }),
    t('applications.settings.saved'),
  );
async function remove() {
  saving.value = true;
  try {
    await api(`/applications/${props.app.id}`, { method: 'DELETE' });
    toast.show(t('applications.settings.removed', { name: props.app.name }));
    open.value = false;
    await router.push({ name: 'applications' });
  } catch (err) {
    toast.show(err instanceof ApiError ? err.message : String(err), 'warning');
  } finally {
    saving.value = false;
  }
}
const access = computed(() => data.data.value?.access ?? null);
const settings = computed(() => data.data.value?.settings);
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="$t('applications.settings.title', { name: app.name })"
    size="lg"
  >
    <div v-if="data.data.value" class="flex flex-col gap-5" data-testid="settings-drawer">
      <section v-if="hasUser" class="flex flex-col gap-2">
        <h3 class="text-14 font-semibold text-text">{{ $t('applications.settings.access') }}</h3>
        <p class="text-13 text-text-muted" data-testid="access-summary">
          <template v-if="access">
            {{
              $t(`applications.settings.method.${access.method}`, {
                user: access.username ?? '—',
                where: access.reference?.secret
                  ? `${access.reference.secret.namespace}/${access.reference.secret.name}`
                  : (access.reference?.file ?? ''),
              })
            }}
            ·
            {{
              $t('applications.settings.setBy', {
                name: access.setBy ?? '—',
                at: formatDateTime(access.setAt),
              })
            }}
            ·
            {{
              access.verifiedAt
                ? $t('applications.settings.verified', { at: formatDateTime(access.verifiedAt) })
                : $t('applications.settings.notVerified')
            }}
          </template>
          <template v-else>{{ $t('applications.settings.noAccess') }}</template>
        </p>
        <template v-if="auth.canManage">
          <div v-if="!changing" class="flex flex-wrap gap-2">
            <BaseButton variant="secondary" data-testid="change-access" @click="changing = true">{{
              $t('applications.settings.change')
            }}</BaseButton>
            <BaseButton
              v-if="access"
              variant="secondary"
              :loading="saving"
              data-testid="remove-access"
              @click="removeAccess"
              >{{ $t('applications.settings.removeAccess') }}</BaseButton
            >
          </div>
          <div v-else class="flex flex-col gap-3 rounded-card border border-border p-3.5">
            <AccessStep :service="target" :integration-id="app.id" @probe="(p) => (probe = p)" />
            <div class="flex justify-end gap-2">
              <BaseButton variant="secondary" @click="changing = false">{{
                $t('common.cancel')
              }}</BaseButton>
              <BaseButton
                :disabled="!probe"
                :loading="saving"
                data-testid="save-access"
                @click="saveAccess"
                >{{ $t('common.save') }}</BaseButton
              >
            </div>
          </div>
        </template>
      </section>

      <section v-if="settings" class="flex flex-col gap-3">
        <h3 class="text-14 font-semibold text-text">{{ $t('applications.settings.switches') }}</h3>
        <label class="flex items-start justify-between gap-4">
          <span class="flex flex-col gap-0.5">
            <span class="text-13 font-medium text-text">{{
              $t('applications.settings.paused')
            }}</span>
            <span class="text-12 text-text-muted">{{
              $t('applications.settings.pausedHint')
            }}</span>
          </span>
          <ToggleSwitch
            v-if="auth.canManage"
            :model-value="settings.paused"
            data-testid="paused"
            @update:model-value="(v: boolean) => patch({ paused: v })"
          />
          <span v-else class="text-13 text-text-muted">{{
            settings.paused ? $t('applications.settings.on') : $t('applications.settings.off')
          }}</span>
        </label>
        <label v-if="app.type === 'postgres'" class="flex items-start justify-between gap-4">
          <span class="flex flex-col gap-0.5">
            <span class="text-13 font-medium text-text">{{
              $t('applications.monitor.queryText')
            }}</span>
            <span class="text-12 text-text-muted">{{
              $t('applications.monitor.queryTextHint')
            }}</span>
          </span>
          <ToggleSwitch
            v-if="auth.canManage"
            :model-value="settings.queryText"
            @update:model-value="(v: boolean) => patch({ queryText: v })"
          />
          <span v-else class="text-13 text-text-muted">{{
            settings.queryText ? $t('applications.settings.on') : $t('applications.settings.off')
          }}</span>
        </label>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-14 font-semibold text-text">{{ $t('applications.settings.log') }}</h3>
        <p v-if="data.data.value.events.length === 0" class="text-13 text-text-subtle">
          {{ $t('applications.settings.logEmpty') }}
        </p>
        <ul v-else class="flex flex-col divide-y divide-border text-13" data-testid="events">
          <li
            v-for="(e, i) in data.data.value.events"
            :key="i"
            class="flex flex-wrap justify-between gap-2 py-2"
          >
            <span class="text-text">
              {{ $t(`applications.settings.action.${e.action}`) }}
              <span v-if="e.user" class="text-text-muted">· {{ e.user }}</span>
            </span>
            <span class="text-12 text-text-muted"
              >{{ formatDateTime(e.at) }}<template v-if="e.ip"> · {{ e.ip }}</template></span
            >
          </li>
        </ul>
      </section>

      <div v-if="auth.canManage" class="flex justify-between gap-2 border-t border-border pt-4">
        <BaseButton
          variant="danger"
          :loading="saving"
          data-testid="remove-service"
          @click="remove"
          >{{ $t('applications.settings.remove') }}</BaseButton
        >
        <BaseButton variant="secondary" @click="open = false">{{ $t('common.close') }}</BaseButton>
      </div>
    </div>
  </ModalDialog>
</template>
