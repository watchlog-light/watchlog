// SPDX-License-Identifier: AGPL-3.0-only
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/main.css';

import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { setReadOnlyHandler, setRestrictedHandler, setUnauthorizedHandler } from './api/client';
import App from './App.vue';
import { createAppI18n } from './i18n';
import { createAppRouter, GATE_ROUTE } from './router';
import { useAuthStore } from './stores/auth';
import { useClustersStore } from './stores/clusters';
import { useToastStore } from './stores/toast';

const pinia = createPinia();
const auth = () => useAuthStore(pinia);
const router = createAppRouter(auth, () => useClustersStore(pinia));

// An expired or revoked session sends the user back to sign-in.
setUnauthorizedHandler(() => {
  if (!auth().user) return; // not signed in yet: the router guard handles it
  auth().clear();
  const current = router.currentRoute.value;
  if (!current.meta.public) {
    void router.push({ name: 'login', query: { redirect: current.fullPath } });
  }
});

// Cloud (ADR-175): a request refused until the account sets up 2FA or verifies its email
// sends the user to the page that lifts that gate.
setRestrictedHandler(async () => {
  if (!auth().user) return;
  await auth().loadAccount();
  const gate = auth().restriction;
  if (gate && router.currentRoute.value.name !== GATE_ROUTE[gate]) {
    void router.replace({ name: GATE_ROUTE[gate] });
  }
});

const i18n = createAppI18n();
// The read-only demo refused a change (ADR-122): say so wherever it happened.
setReadOnlyHandler(() => useToastStore(pinia).show(i18n.global.t('demo.readOnly'), 'warning'));

createApp(App).use(pinia).use(router).use(i18n).mount('#app');
