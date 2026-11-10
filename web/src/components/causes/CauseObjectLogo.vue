<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { CauseObject } from '@watchlog/api-types';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { ServiceLogo, SERVICE_LOGO_URL } from '@/components/ui/serviceLogos';

// The logo in front of a step's object: the monitored service's for an application, else
// the platform's (Kubernetes or Docker). Decorative: the kind is written next to it.
defineProps<{ object: CauseObject }>();
</script>

<template>
  <ServiceLogo
    v-if="object.kind === 'application' && object.type && SERVICE_LOGO_URL[object.type]"
    :type="object.type"
    class="size-4 shrink-0"
  />
  <component :is="KIND_LOGO[object.platform]" v-else class="size-4 shrink-0" />
</template>
