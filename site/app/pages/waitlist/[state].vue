<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Where the waitlist service sends people: after a form post without JavaScript, and
// from the links in its email (confirm, unsubscribe).
const STATES: Record<string, { title: string; text: string; ok: boolean }> = {
  'check-inbox': {
    title: 'Check your inbox',
    text: 'We sent you a link to confirm your address. Until you confirm, we will not email you again.',
    ok: true,
  },
  confirmed: {
    title: "You're on the list",
    text: "Thanks for confirming. We'll email you once, when WatchLog Cloud opens. Every email has an unsubscribe link.",
    ok: true,
  },
  'link-expired': {
    title: 'This link has expired',
    text: 'Confirmation links work once and for 7 days. Sign up again and we will send a new one.',
    ok: false,
  },
  unsubscribed: {
    title: "You're unsubscribed",
    text: 'Your address is removed from the waitlist. We will not email you again.',
    ok: true,
  },
  error: {
    title: 'That did not work',
    text: 'Check the address and try again, or wait a few minutes if you tried several times.',
    ok: false,
  },
};

const key = String(useRoute().params.state);
const state = STATES[key];
if (!state) throw createError({ statusCode: 404, statusMessage: 'Page not found' });
usePage({ title: state.title, description: state.text, path: `/waitlist/${key}/` });
useHead({ meta: [{ name: 'robots', content: 'noindex' }] });
</script>

<template>
  <div v-if="state" class="not-found">
    <div class="in">
      <span class="kicker">WatchLog Cloud waitlist</span>
      <h1>{{ state.title }}</h1>
      <p>{{ state.text }}</p>
      <div class="ctas">
        <a v-if="!state.ok" class="btn primary" href="/#cloud">Sign up again</a>
        <a class="btn ghost" href="/">Back to the home page</a>
      </div>
    </div>
  </div>
</template>
