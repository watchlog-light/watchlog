<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { repoLink } from '../../site.config';

// A GitHub link once the repository is public; until then a note, never a link.
const props = defineProps<{ variant: 'nav' | 'button' }>();
const href = repoLink();
</script>

<template>
  <template v-if="href">
    <a v-if="props.variant === 'nav'" class="star" :href="href" rel="noopener">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path
          d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"
        />
      </svg>
      Star on GitHub
    </a>
    <a v-else class="btn ghost" :href="href" rel="noopener">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path
          d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"
        />
      </svg>
      Star on GitHub
    </a>
  </template>
  <span
    v-else
    :class="['soon-pill', { small: props.variant === 'nav', 'nav-soon': props.variant === 'nav' }]"
  >
    Open-source release coming soon
  </span>
</template>
