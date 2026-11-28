<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { formatValue } from '@/lib/units';
import { SEVERITY_TEXT, type PanelOf } from '@/lib/panels';
import PanelLink from './PanelLink.vue';

// Who blocks whom (1.2, ADR-245): the root blocker first, each session it blocks indented
// under it, with its client (linking to its workload or container), what it does ("idle in
// a transaction, holds the lock", "waits on a lock"), for how long, its transaction's age
// and its statement's normalised text. A list, so a screen reader reads the levels.
defineProps<{ panel: PanelOf<'tree'> }>();
</script>

<template>
  <ol class="flex flex-col text-13" data-testid="lock-tree">
    <li
      v-for="n in panel.nodes"
      :key="n.id"
      class="flex flex-col gap-1 border-t border-border py-2.5 first:border-t-0"
      :style="{ paddingLeft: `${Math.min(n.depth, 6) * 1.5}rem` }"
      :aria-level="n.depth + 1"
      data-testid="tree-node"
    >
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span v-if="n.depth > 0" class="text-text-subtle" aria-hidden="true">└</span>
        <span class="font-mono" :class="n.severity ? SEVERITY_TEXT[n.severity] : 'text-text'">
          <PanelLink v-if="n.link" :link="n.link">{{ n.name }}</PanelLink>
          <template v-else>{{ n.name }}</template>
        </span>
        <span :class="n.severity ? SEVERITY_TEXT[n.severity] : 'text-text-muted'">{{
          $t(n.state.key, n.state.values ?? {})
        }}</span>
        <span class="text-text-muted tabular-nums">{{
          $t('integrations.db.panels.tree.for', { d: formatValue(n.seconds, 'seconds') })
        }}</span>
        <span v-if="n.xact" class="text-text-subtle tabular-nums">{{
          $t('integrations.db.panels.tree.xact', { d: formatValue(n.xact, 'seconds') })
        }}</span>
      </div>
      <p v-if="n.query" class="truncate pl-0 font-mono text-12 text-text-muted" :title="n.query">
        {{ n.query }}
      </p>
    </li>
  </ol>
</template>
