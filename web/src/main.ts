// SPDX-License-Identifier: AGPL-3.0-only
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/main.css';

import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { setUnauthorizedHandler } from './api/client';
import App from './App.vue';
import { createAppI18n } from './i18n';
import { createAppRouter } from './router';
import { useAuthStore } from './stores/auth';
import { useClustersStore } from './stores/clusters';

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

createApp(App).use(pinia).use(router).use(createAppI18n()).mount('#app');
