<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { site } from '../../site.config';

// The hero's install panel. Tabs are radio buttons (CSS shows the checked panel) and
// the output lines are staged with CSS delays, so neither needs a script; the copy
// button does (public/js/site.js), and stays hidden without it. Commands match
// docs/site/install.md. While the repository is private: a release note, no commands.
type Line = { kind: 'c' | 'cmd'; text: string; tool?: string };
const v = site.version;
const COMMANDS: Record<'helm' | 'docker', Line[]> = {
  helm: [
    { kind: 'c', text: '# Kubernetes · server and agents in namespace watchlog' },
    { kind: 'cmd', tool: 'kubectl', text: ' create namespace watchlog' },
    { kind: 'cmd', tool: 'kubectl', text: ' label namespace watchlog \\' },
    { kind: 'cmd', text: '  pod-security.kubernetes.io/enforce=privileged' },
    { kind: 'cmd', tool: 'helm', text: ' install watchlog \\' },
    { kind: 'cmd', text: '  oci://ghcr.io/watchlog-light/charts/watchlog \\' },
    { kind: 'cmd', text: `  -n watchlog --version ${v}` },
  ],
  docker: [
    { kind: 'c', text: '# Docker host · server, with a password and key in .env' },
    { kind: 'cmd', tool: 'curl', text: ' -fsSLO https://watchlog.io/compose.yaml' },
    {
      kind: 'cmd',
      tool: 'printf',
      text: " 'WATCHLOG_DB_PASSWORD=%s\\nWATCHLOG_SECRET_KEY=%s\\n' \\",
    },
    { kind: 'cmd', text: '  "$(openssl rand -hex 16)" "$(openssl rand -base64 32)" > .env' },
    { kind: 'cmd', tool: 'docker', text: ' compose up -d' },
    { kind: 'c', text: '# then copy the agent command from Settings → Clusters' },
  ],
};
const OUTPUT: Record<'helm' | 'docker', [string, string][]> = {
  helm: [
    ['0:04', 'namespace/watchlog created'],
    ['0:31', '✓ server ready · open the setup code link'],
    ['0:52', '✓ agent connected on 3 nodes'],
    ['1:12', '✓ first metrics received'],
    ['1:14', '✓ eBPF network monitoring: enabled'],
  ],
  docker: [
    ['0:09', '✓ backend, web, database started'],
    ['0:38', '✓ agent connected on db-01'],
    ['0:58', '✓ first metrics received'],
  ],
};
const tabs = [
  ['helm', 'Helm'],
  ['docker', 'Docker'],
] as const;
</script>

<template>
  <div id="install" class="term">
    <template v-if="site.repoPublic">
      <div class="bar">
        <i></i><i></i><i></i>
        <fieldset class="tabs">
          <legend class="sr-only">Install method</legend>
          <template v-for="([key, label], i) in tabs" :key="key">
            <input :id="`tab-${key}`" type="radio" name="install" :value="key" :checked="i === 0" />
            <label :for="`tab-${key}`">{{ label }}</label>
          </template>
        </fieldset>
        <button class="copy" type="button" data-copy hidden>Copy</button>
      </div>
      <div v-for="[key] in tabs" :key="key" :class="['panel', key]">
        <pre
          :data-cmd="key"
        ><template v-for="(l, i) in COMMANDS[key]" :key="i"><span v-if="l.kind === 'c'" class="c">{{ l.text }}</span><template v-else><span v-if="l.tool" class="p">{{ l.tool }}</span>{{ l.text }}</template>{{ i < COMMANDS[key].length - 1 ? '\n' : '' }}</template></pre>
        <div class="out" aria-label="Example output">
          <div v-for="([t, m], i) in OUTPUT[key]" :key="t" :class="`d${i}`">
            <span class="t">{{ t }}</span
            ><span :class="{ g: m.startsWith('✓') }">{{ m }}</span>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="bar" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="soon-body">
        <div><strong>Open-source release coming soon.</strong></div>
        <div>WatchLog {{ site.version }} · AGPL-3.0</div>
        <div>A Helm chart for Kubernetes, one docker run per Docker host.</div>
        <div>The install commands appear here on release day.</div>
      </div>
    </template>
  </div>
</template>
