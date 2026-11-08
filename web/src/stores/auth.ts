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

export const useAuthStore = defineStore('auth', () => {
  const user = ref<CurrentUser | null>(null);
  const setupRequired = ref(false);
  /** A read-only public demo (ADR-122): passwordless entry, every change refused. */
  const demoMode = ref(false);
  /** The demo's public read-only MCP token (ADR-130), offered on Settings → API tokens. */
  const demoMcpToken = ref<string | null>(null);
  const loaded = ref(false);
  /** Whether the UI offers changes: not to viewers, and never in the demo. */
  const canManage = computed(() => user.value?.role !== 'viewer' && !demoMode.value);
  let pending: Promise<void> | null = null;

  async function load(): Promise<void> {
    const status = await api<SetupStatus>('/setup');
    setupRequired.value = status.required;
    demoMode.value = status.demoMode;
    demoMcpToken.value = (status.demoMode && status.demoMcpToken) || null;
    user.value = null;
    if (!status.required) {
      try {
        user.value = (await api<UserEnvelope>('/me')).user;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) throw err;
      }
    }
    loaded.value = true;
  }

  /** Loads setup and session state once; retried on the next call if it failed. */
  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function login(request: LoginRequest): Promise<void> {
    user.value = (await api<UserEnvelope>('/auth/login', { method: 'POST', body: request })).user;
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
      await api<void>('/auth/logout', { method: 'POST' });
    } finally {
      user.value = null;
    }
  }

  /** Forgets the user locally, e.g. after the session expired. */
  function clear(): void {
    user.value = null;
  }

  return {
    user,
    setupRequired,
    demoMode,
    demoMcpToken,
    canManage,
    loaded,
    ensureLoaded,
    login,
    enterDemo,
    completeSetup,
    logout,
    clear,
  };
});
