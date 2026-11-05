<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleHelp } from '@lucide/vue';
import EmptyState from '@/components/ui/EmptyState.vue';
</script>

<template>
  <EmptyState
    :icon="CircleHelp"
    :title="$t('empty.notFound.title')"
    :description="$t('empty.notFound.description')"
    :action-label="$t('empty.notFound.action')"
    action-to="/"
  />
</template>
