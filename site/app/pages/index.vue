<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { site, siteMeta } from '../../site.config';

// The landing page, after the approved design. Every number is measured in the acceptance
// runs; change them only with a new measurement.
usePage({ description: siteMeta.description, path: '/' });

const MEASURED = {
  agentMemory: '~20 MB',
  firstMetrics: 'first metrics 21 s after install (measured)',
  agentCpu: '0.16 % of a core per node under load',
  defaultRules: 15,
  stackMemory: '~450 MB',
  stackNote: 'RAM for the whole stack, 3-node test cluster',
};

const faq: [string, string][] = [
  [
    'Is it really free?',
    'Yes. WatchLog Community is AGPL-3.0 and complete for one cluster. Paid plans will add hosting, more clusters, longer history and organisation features. Nothing that is free today will become paid.',
  ],
  [
    'What data leaves my cluster?',
    'When you self-host, nothing leaves your infrastructure: agents send metrics, Kubernetes object summaries and events to your own WatchLog server. Secrets, environment variables and payloads are never read, and the software sends nothing to us.',
  ],
  [
    'Which kernels support the service map?',
    'Linux 5.8 or newer with BTF, which covers current Ubuntu, Debian, RHEL and managed Kubernetes images. On older kernels everything else works and the map shows topology only.',
  ],
  [
    'How is it different from Coroot or Netdata?',
    'Coroot is the closest: an eBPF service map plus tracing, logs, profiling and SLOs, free under Apache-2.0. Netdata collects far more metrics, every second, across hundreds of integrations. WatchLog is narrower on purpose: fixed Kubernetes and Docker views, a service map and alerts that work on day one, with a lighter node agent. If you need tracing or per-second metrics, they are the better choice.',
  ],
  [
    'Can I run it in an air-gapped network?',
    'Community runs fully self-hosted: mirror the images and the chart into your own registry. A documented air-gapped install with an offline licence is planned for the Enterprise edition.',
  ],
  [
    'Which alert channels are supported?',
    'Slack, Telegram, email (your SMTP server) and signed webhooks today; Teams, Discord, PagerDuty and Opsgenie are planned.',
  ],
];

const waitlistOpen = site.cloudWaitlist && site.waitlistAction !== '';

useHead({
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'SoftwareApplication',
            name: siteMeta.name,
            description: siteMeta.description,
            url: site.url,
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Linux, Kubernetes, Docker',
            softwareVersion: site.version,
            license: 'https://www.gnu.org/licenses/agpl-3.0.html',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          },
          {
            '@type': 'FAQPage',
            mainEntity: faq.map(([q, a]) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: { '@type': 'Answer', text: a },
            })),
          },
        ],
      }),
    },
  ],
});
</script>

<template>
  <div>
    <header id="top" class="hero">
      <div class="in">
        <div class="hgrid">
          <div>
            <span class="badge"
              ><b>v{{ site.version.replace(/\.0$/, '') }}</b
              >Free &amp; open source · AGPL-3.0</span
            >
            <h1>
              {{ siteMeta.headline }} <em>{{ siteMeta.headlineAccent }}</em>
            </h1>
            <p class="sub">{{ siteMeta.subheadline }}</p>
            <div class="ctas">
              <a class="btn primary" href="#install">Get started free →</a>
              <RepoButton variant="button" />
            </div>
          </div>
          <InstallTerminal />
        </div>
        <div class="shot">
          <ScreenshotFrame
            shot="overview"
            label="watchlog · overview"
            alt="WatchLog overview: cluster health, KPIs with sparklines, resources chart and the problems that need attention"
            sizes="(max-width: 1160px) 100vw, 1120px"
            eager
          />
        </div>
      </div>
    </header>

    <div class="trust">
      <ul class="in">
        <li>Open source (AGPL-3.0)</li>
        <li>Read-only agent, two capabilities</li>
        <li>Self-host in one command</li>
        <li>Built with eBPF</li>
        <li>{{ MEASURED.agentMemory }} per node</li>
      </ul>
    </div>

    <section id="features" class="s">
      <div class="in">
        <span class="kicker">Why WatchLog</span>
        <h2>The answers you need, without assembling a stack.</h2>
        <p class="lead">
          Which pod is restarting? Which node is out of memory? Why can service A not reach service
          B? WatchLog answers these on day one.
        </p>
        <div class="pillars">
          <div class="pill">
            <span class="ic" aria-hidden="true"
              ><svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="m4 17 6-6-6-6M12 19h8" /></svg
            ></span>
            <h3>One-command install</h3>
            <p>
              A Helm chart or one <span class="mono">docker run</span>. No exporters, no PromQL, no
              dashboards to wire up.
            </p>
            <span class="num">{{ MEASURED.firstMetrics }}</span>
          </div>
          <div class="pill">
            <span class="ic" aria-hidden="true"
              ><svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle cx="5" cy="12" r="2.5" />
                <circle cx="19" cy="5" r="2.5" />
                <circle cx="19" cy="19" r="2.5" />
                <path d="m7.2 11 9.5-5M7.2 13l9.5 5" /></svg
            ></span>
            <h3>Service map from real traffic</h3>
            <p>
              eBPF sees every TCP connection: who talks to whom, failures and latency. No sidecars,
              no code changes.
            </p>
            <span class="num">{{ MEASURED.agentCpu }}</span>
          </div>
          <div class="pill">
            <span class="ic" aria-hidden="true"
              ><svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
                /></svg
            ></span>
            <h3>Alerts that work on day one</h3>
            <p>
              CrashLoopBackOff, OOMKilled, node pressure, disk full and more, enabled by default. To
              Slack, Telegram, email or webhook.
            </p>
            <span class="num">{{ MEASURED.defaultRules }} default rules</span>
          </div>
        </div>

        <div class="feat">
          <div class="txt">
            <span class="kicker">Service map</span>
            <h3>See who talks to whom, live.</h3>
            <p>
              Every connection between your workloads, with connections per second, failed
              connections and connect latency. Failing edges light up with the reason.
            </p>
            <ul>
              <li>Grouped by namespace, with external dependencies by DNS name</li>
              <li>Click any edge for its history and the related alert</li>
              <li>Falls back to topology when eBPF isn't available</li>
            </ul>
          </div>
          <ScreenshotFrame
            shot="service-map"
            label="service map"
            alt="WatchLog service map with live connections between workloads"
            sizes="(max-width: 900px) 100vw, 660px"
          />
        </div>
        <div class="feat rev">
          <div class="txt">
            <span class="kicker">Workloads &amp; pods</span>
            <h3>Restart reasons, not just restart counts.</h3>
            <p>
              Every workload grouped by namespace, with usage against requests and limits, and the
              reason a pod is failing in plain words.
            </p>
            <ul>
              <li>OOMKilled, exit codes and crash loops explained</li>
              <li>Usage bars with request and limit markers</li>
              <li>Change markers for every rollout on every chart</li>
            </ul>
          </div>
          <ScreenshotFrame
            shot="workloads"
            label="workloads"
            alt="WatchLog workloads page grouped by namespace"
            sizes="(max-width: 900px) 100vw, 660px"
          />
        </div>
      </div>
    </section>

    <section class="s tight" aria-labelledby="compare-title">
      <div class="in">
        <span class="kicker">Honest comparison</span>
        <h2 id="compare-title">Why not just Prometheus + Grafana?</h2>
        <p class="lead">
          It's a great stack if you have the time to build and own it. WatchLog is for teams who'd
          rather not.
        </p>
        <div class="tblw">
          <table>
            <thead>
              <tr>
                <td></td>
                <th scope="col">Prometheus + Grafana (DIY)</th>
                <th scope="col" class="wl">WatchLog</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Setup</th>
                <td>Hours: exporters, scrape configs, dashboards</td>
                <td class="wl">One command, ~5 minutes</td>
              </tr>
              <tr>
                <th scope="row">Maintenance</th>
                <td>Dashboards and rules you own forever</td>
                <td class="wl">Opinionated views, upgraded with the chart</td>
              </tr>
              <tr>
                <th scope="row">Service map</th>
                <td><span class="n" aria-hidden="true">✕</span> Needs a service mesh or tracing</td>
                <td class="wl">
                  <span class="y" aria-hidden="true">✓</span> From eBPF, no code changes
                </td>
              </tr>
              <tr>
                <th scope="row">Default alerts</th>
                <td>Write and tune them yourself</td>
                <td class="wl">
                  <span class="y" aria-hidden="true">✓</span> {{ MEASURED.defaultRules }} rules on
                  install
                </td>
              </tr>
              <tr>
                <th scope="row">Query language</th>
                <td>PromQL</td>
                <td class="wl">None needed</td>
              </tr>
              <tr>
                <th scope="row">Flexibility</th>
                <td>Unlimited, any metric, any dashboard</td>
                <td class="wl">Fixed views (custom dashboards aren't a goal)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="how" class="s tight">
      <div class="in">
        <span class="kicker">How it works</span>
        <h2>Install, see data, get alerted.</h2>
        <ol class="steps">
          <li class="step">
            <span class="num">01</span>
            <h3>Install the agent</h3>
            <p>
              A DaemonSet reads cgroups, the kubelet and eBPF on each node. One cluster-agent
              watches the Kubernetes API, read-only.
            </p>
          </li>
          <li class="step">
            <span class="num">02</span>
            <h3>Data arrives</h3>
            <p>
              Agents push over HTTPS to your WatchLog server: VictoriaMetrics for metrics,
              PostgreSQL for everything else. Nothing connects into your cluster.
            </p>
          </li>
          <li class="step">
            <span class="num">03</span>
            <h3>Get alerted</h3>
            <p>
              Default rules fire on real problems with a plain-language reason, a chart and a link.
              Grouped, so one broken cluster is one message.
            </p>
          </li>
        </ol>
      </div>
    </section>

    <section id="security" class="s tight">
      <div class="in">
        <span class="kicker">Security</span>
        <h2>What the agent can and can't see.</h2>
        <p class="lead">
          It's open source, so you don't have to take our word for it. Every permission is
          documented with the reason it's needed.
        </p>
        <div class="sec">
          <div class="col can">
            <h3><span class="ok-mark" aria-hidden="true">✓</span> Can</h3>
            <ul>
              <li>Read node, pod and container resource usage</li>
              <li>Watch Kubernetes objects and events (read-only)</li>
              <li>See TCP connection metadata and DNS names via eBPF</li>
              <li>Use only the BPF and PERFMON capabilities</li>
            </ul>
          </div>
          <div class="col cant">
            <h3><span class="no-mark" aria-hidden="true">✕</span> Can't</h3>
            <ul>
              <li>Read Secrets, ConfigMaps or environment variables</li>
              <li>Read request payloads or decrypt TLS</li>
              <li>Execute commands or change anything in your cluster</li>
              <li>Accept inbound connections from outside</li>
            </ul>
          </div>
        </div>
        <a class="more" href="/security/">Everything the agent can access →</a>
      </div>
    </section>

    <section class="s tight" aria-labelledby="oss-title">
      <div class="in">
        <div class="oss">
          <div>
            <h2 id="oss-title" class="big">Free and open source. Self-host it in one command.</h2>
            <p>
              WatchLog Community is complete for one cluster: monitoring, the service map and
              alerting are never paywalled.
              <template v-if="site.repoPublic"
                >If it saves you time, a GitHub star helps more people find it.</template
              >
              <template v-else>The source code and the first release are coming soon.</template>
            </p>
            <div class="ctas">
              <RepoButton variant="button" />
              <a class="btn ghost" href="/docs/">Read the docs</a>
            </div>
          </div>
          <dl class="facts">
            <div>
              <dt>license</dt>
              <dd>AGPL-3.0</dd>
            </div>
            <div>
              <dt>{{ MEASURED.stackNote }}</dt>
              <dd>{{ MEASURED.stackMemory }}</dd>
            </div>
            <div>
              <dt>agent memory per node</dt>
              <dd>{{ MEASURED.agentMemory }}</dd>
            </div>
            <div>
              <dt>images, signed at release</dt>
              <dd>amd64 · arm64</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>

    <section id="cloud" class="s tight">
      <div class="in">
        <span class="kicker">Editions</span>
        <h2>Self-host today. Cloud is coming.</h2>
        <div class="cloud">
          <div class="plan on">
            <h3>
              Community
              <span class="tag">{{ site.repoPublic ? 'available now' : 'coming soon' }}</span>
            </h3>
            <div class="price">Free<small> · forever</small></div>
            <ul>
              <li>One cluster or Docker fleet, unlimited nodes</li>
              <li>Service map, alerts, all dashboards</li>
              <li>Your servers, your data</li>
            </ul>
            <a v-if="site.repoPublic" class="btn primary bottom" href="#install">Install now</a>
            <span v-else class="soon-pill bottom">Open-source release coming soon</span>
          </div>
          <div class="plan">
            <h3>WatchLog Cloud <span class="tag later">coming soon</span></h3>
            <div class="price">$1<small> / node / month · free up to 5 nodes</small></div>
            <ul>
              <li>Nothing to host or upgrade</li>
              <li>Multiple clusters, 30-day history</li>
              <li>Anomaly detection that learns your cluster</li>
            </ul>
            <form
              class="wait"
              :action="waitlistOpen ? site.waitlistAction : undefined"
              method="post"
              aria-describedby="wait-note"
              data-waitlist
            >
              <input
                type="email"
                name="email"
                required
                maxlength="254"
                autocomplete="email"
                placeholder="you@company.com"
                aria-label="Email for the Cloud waitlist"
                :disabled="!waitlistOpen"
              />
              <!-- For bots only: people never see or fill this field. -->
              <div class="hp" aria-hidden="true">
                <label
                  >Leave this empty
                  <input type="text" name="website" tabindex="-1" autocomplete="off"
                /></label>
              </div>
              <!-- Filled from the page's UTM parameters and referrer by js/site.js. -->
              <input type="hidden" name="utm_source" />
              <input type="hidden" name="utm_medium" />
              <input type="hidden" name="utm_campaign" />
              <input type="hidden" name="referrer" />
              <button class="btn" type="submit" :disabled="!waitlistOpen">Join the waitlist</button>
            </form>
            <p id="wait-note" class="wait-note" role="status" aria-live="polite">
              <template v-if="waitlistOpen">
                One email when Cloud opens; nothing else. See the
                <a href="/legal/privacy/#the-cloud-waitlist">privacy policy</a>.
              </template>
              <template v-else>The waitlist opens soon.</template>
            </p>
          </div>
        </div>
      </div>
    </section>

    <section id="faq" class="s tight">
      <div class="in">
        <span class="kicker">FAQ</span>
        <h2>Questions</h2>
        <div class="faq">
          <details v-for="[q, a] in faq" :key="q">
            <summary>{{ q }}</summary>
            <p>{{ a }}</p>
          </details>
        </div>
      </div>
    </section>

    <section class="final" aria-labelledby="final-title">
      <div class="in">
        <h2 id="final-title">
          {{
            site.repoPublic
              ? 'Install WatchLog in the next five minutes.'
              : 'Open-source release coming soon.'
          }}
        </h2>
        <div class="ctas">
          <a v-if="site.repoPublic" class="btn primary" href="#install">Get started free →</a>
          <a v-else class="btn primary" href="/docs/">Read the docs →</a>
          <RepoButton v-if="site.repoPublic" variant="button" />
        </div>
      </div>
    </section>
  </div>
</template>
