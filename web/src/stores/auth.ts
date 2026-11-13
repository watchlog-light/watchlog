// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CurrentUser,
  DemoSessionResponse,
  LoginRequest,
  SetupRequest,
  SetupStatus,
  UserEnvelope,
} from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, ApiError } from '@/api/client';
import {
  cloudApi,
  fetchCloudConfig,
  type Account,
  type CloudConfig,
  type SupportCurrent,
} from '@/api/cloud';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<CurrentUser | null>(null);
  const setupRequired = ref(false);
  /** A read-only public demo (ADR-122): passwordless entry, every change refused. */
  const demoMode = ref(false);
  /** The demo's public read-only MCP token (ADR-130), offered on Settings → API tokens. */
  const demoMcpToken = ref<string | null>(null);
  /** Email is set up: "Forgot your password?" emails a link (ADR-140). */
  const smtp = ref(false);
  const loaded = ref(false);
  /** Cloud's sign-up config (ADR-175); null in Community, where every Cloud page stays hidden. */
  const cloud = ref<CloudConfig | null>(null);
  const isCloud = computed(() => cloud.value !== null);
  /** Cloud: the signed-in account (verification, 2FA, identities, the gate). */
  const account = ref<Account | null>(null);
  /** Cloud: a WatchLog staff member's read-only support session (ADR-179), or null. */
  const support = ref<SupportCurrent | null>(null);
  /** Cloud: what the account must do before anything else (ADR-175 gates). */
  const restriction = computed(() => account.value?.restriction ?? null);
  /** Whether the UI offers changes: not to viewers, and never in the demo. */
  const canManage = computed(
    () => user.value?.role !== 'viewer' && !demoMode.value && !support.value,
  );
  let pending: Promise<void> | null = null;

  async function load(): Promise<void> {
    const [status, config] = await Promise.all([api<SetupStatus>('/setup'), fetchCloudConfig()]);
    cloud.value = config;
    // Cloud signs people up; the installation's first-run setup isn't offered there.
    setupRequired.value = status.required && !config;
    demoMode.value = status.demoMode;
    demoMcpToken.value = (status.demoMode && status.demoMcpToken) || null;
    smtp.value = status.smtp;
    user.value = null;
    account.value = null;
    support.value = null;
    if (!setupRequired.value) {
      try {
        user.value = (await api<UserEnvelope>('/me')).user;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) throw err;
      }
    }
    if (user.value && config) {
      // Support mode has no account of its own: the banner's facts instead.
      support.value = await cloudApi.supportCurrent().catch(() => null);
      if (!support.value) await loadAccount();
    }
    loaded.value = true;
  }

  /** Cloud: reloads the account (after verifying, turning 2FA on, linking). */
  async function loadAccount(): Promise<void> {
    if (!cloud.value || support.value) return;
    try {
      account.value = await cloudApi.account();
    } catch {
      // The pages still work; the gates are enforced by the backend anyway.
      account.value = null;
    }
  }

  /** Loads setup and session state once; retried on the next call if it failed. */
  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  }

  /** Signs in; Cloud answers `mfa` when the account has 2FA on (the code is asked next). */
  async function login(request: LoginRequest): Promise<'signed-in' | 'mfa'> {
    const res = await api<UserEnvelope | { mfaRequired: true }>('/auth/login', {
      method: 'POST',
      body: request,
    });
    if ('mfaRequired' in res) return 'mfa';
    await signedIn(res.user);
    return 'signed-in';
  }

  /** A sign-in finished elsewhere (the 2FA step, an invite, sign-up). */
  async function signedIn(next: CurrentUser): Promise<void> {
    user.value = next;
    await loadAccount();
  }

  /** Starts a read-only demo session (demo mode only). */
  async function enterDemo(): Promise<void> {
    user.value = (await api<DemoSessionResponse>('/demo/session', { method: 'POST' })).user;
  }

  async function completeSetup(request: SetupRequest): Promise<void> {
    user.value = (await api<UserEnvelope>('/setup', { method: 'POST', body: request })).user;
    setupRequired.value = false;
  }

  async function logout(): Promise<void> {
    try {
      // Support mode (ADR-179): signing out leaves it (the session ends for good).
      if (support.value) await cloudApi.leaveSupport();
      else await api<void>('/auth/logout', { method: 'POST' });
    } finally {
      support.value = null;
      user.value = null;
      account.value = null;
    }
  }

  /** Forgets the user locally, e.g. after the session expired. */
  function clear(): void {
    user.value = null;
    account.value = null;
  }

  return {
    user,
    setupRequired,
    demoMode,
    demoMcpToken,
    smtp,
    canManage,
    loaded,
    cloud,
    isCloud,
    account,
    support,
    restriction,
    loadAccount,
    signedIn,
    ensureLoaded,
    /** Reloads the session (a role changed). */
    reload: load,
    login,
    enterDemo,
    completeSetup,
    logout,
    clear,
  };
});
