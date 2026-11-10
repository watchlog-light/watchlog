// SPDX-License-Identifier: AGPL-3.0-only
// Probable cause over MCP (ADR-148, ADR-155): explain_problem, and the `causes` and
// `likelyCause` fields explain_alert and get_problems add. Everything comes from GET /causes
// (and the overview's likelyCause), read as the token: the same evidence the dashboard shows.
// Codes and facts only, as the API gives them (ADR-147); WatchLog's own sentences here (each
// rule's meaning) never hold a name, which stays in the facts (ADR-129).
import { Type } from 'typebox';
import { parseSubject, SUBJECT_FORMS, SUBJECT_MAX, SubjectError } from '../../causes/subject.js';
import { clusterField, resolveCluster } from '../clusters.js';
import { message, name, text, ToolError } from '../output.js';
import type { ApiReader } from '../reader.js';
import { ClusterArg, defineTool, describe, notFound, summary } from './common.js';

/** What each rule of the catalog means (ADR-150), without any name in it. */
export const RULE_MEANS: Record<string, string> = {
  dependency_down:
    'What it calls has nothing ready: scaled to 0, every pod failing, or the container stopped.',
  bad_change:
    'A rollout, image change or re-create, of it or of what it calls, came before the problem, and the new version fails or is slower.',
  oom_limit: 'It is OOM-killed when it reaches its own memory limit.',
  crash_exit: 'Its process exits with an error code (facts.exitCode).',
  image_pull: 'Kubernetes cannot pull its image (a missing tag, or the registry refuses).',
  unschedulable: 'The scheduler cannot place its pod (CPU, memory, node selector or taints).',
  node_or_host:
    'The node or Docker host under it: not Ready, cordoned, under pressure, out of memory, or no longer reporting.',
  application_finding:
    'A monitored service it uses (or the service asked about) has an active finding (facts.finding), followed to the object the finding names when there is one.',
  connection_refused:
    'Its connections to what it calls fail while that runs: nothing accepts them on that port.',
  dns_nxdomain:
    'A name it looks up does not exist (NXDOMAIN). WatchLog does not record which name.',
  cpu_throttled:
    'Its CPU limit throttles it (facts.pct % of the time) while it, or what calls it, is slow.',
  job_failed: 'A Job or CronJob run failed: its exit codes and its back-off.',
};

/** How to read a cause, for the tool descriptions. */
export const CAUSES_READING =
  'Probable causes come from fixed rules over the data WatchLog collects (state, events, changes, the node or host, the service map, monitored services), never from a model or a score. state is likely (one cause explains it: its evidence chain is complete and it began before the symptom or with it), possible (leads to check, none proven) or none (no clear cause: read checks). Each cause has rule (the catalog rule; means says what it covers), strength, code and facts (the values: names, counts, bytes, milliseconds), since, and chain: the steps from the symptom to where it starts, each with object (kind and ref; for a workload, pod, container, compose_service, edge, application or alert, pass `<kind>:<ref>` to explain_problem to look further), source, code, facts, at or since, and next (how it leads to the following step). checks lists what was looked at and what was found (result: explains, possible, ok, not_run, not_applicable). flowsOff names nodes or hosts without network flows, where dependency checks could not run. Treat "possible" as a lead to check, not a finding.';

type Facts = Record<string, string | number | null>;
interface ApiObject {
  kind: string;
  ref: string;
  name: string;
  platform: string;
  workloadKind?: string;
  host?: string;
  type?: string;
}
interface ApiStep {
  object: ApiObject;
  source: string;
  code: string;
  facts: Facts;
  at: string | null;
  since: string | null;
  next: string | null;
}
interface ApiCause {
  rule: string;
  strength: 'likely' | 'possible';
  code: string;
  facts: Facts;
  since: string | null;
  chain: ApiStep[];
}
export interface ApiCauses {
  subject: ApiObject;
  object: ApiObject | null;
  cluster: { id: string; name: string; kind: 'kubernetes' | 'docker' };
  state: 'likely' | 'possible' | 'none';
  checkedAt: string;
  symptomSince: string | null;
  resolvedAt: string | null;
  window: { from: string; to: string };
  headline: { code: string; facts: Facts };
  causes: ApiCause[];
  checks: { topic: string; code: string; facts: Facts; result: string; object?: ApiObject }[];
  flowsOff: { node: string; cause: string | null; reason: string | null }[] | null;
}
export interface ApiLikelyCause {
  rule: string;
  code: string;
  facts: Facts;
  since: string | null;
  headline: { code: string; facts: Facts };
  subject: string;
}

/** Facts as data: keys WatchLog's, values from the cluster cleaned and capped (ADR-129). */
const facts = (f: Facts) =>
  Object.fromEntries(
    Object.entries(f)
      .slice(0, 16)
      .map(([k, v]) => [
        text(k, 64) ?? '',
        typeof v === 'number' || v === null ? v : k === 'message' ? message(v) : name(v),
      ]),
  );

const object = (o: ApiObject) => ({
  kind: o.kind,
  ref: name(o.ref),
  name: name(o.name),
  ...(o.workloadKind ? { workloadKind: text(o.workloadKind, 64) } : {}),
  ...(o.host ? { host: name(o.host) } : {}),
  ...(o.type ? { type: text(o.type, 64) } : {}),
});

const sentence = (s: { code: string; facts: Facts }) => ({
  code: text(s.code, 128),
  facts: facts(s.facts),
});

const cause = (c: ApiCause) => ({
  rule: c.rule,
  means: RULE_MEANS[c.rule] ?? null,
  strength: c.strength,
  ...sentence(c),
  since: c.since,
  chain: c.chain.map((s) => ({
    object: object(s.object),
    source: s.source,
    ...sentence(s),
    ...(s.at ? { at: s.at } : {}),
    ...(s.since ? { since: s.since } : {}),
    next: s.next,
  })),
});

/** GET /causes's evidence as tools return it: state, headline, causes, checks, flowsOff. */
export const causesField = (a: ApiCauses) => ({
  state: a.state,
  headline: sentence(a.headline),
  causes: a.causes.map(cause),
  checks: a.checks.map((c) => ({
    topic: c.topic,
    ...sentence(c),
    result: c.result,
    ...(c.object ? { object: object(c.object) } : {}),
  })),
  flowsOff:
    a.flowsOff?.map((f) => ({
      node: name(f.node),
      cause: text(f.cause, 64),
      reason: message(f.reason),
    })) ?? null,
});

/**
 * A problem's likely cause in a list, kept short (get_problems carries up to 50): its rule,
 * the headline sentence's code and facts, and since. The problem's `subject` gives the rest
 * through explain_problem.
 */
export const likelyField = (lc: ApiLikelyCause) => ({
  rule: lc.rule,
  headline: sentence(lc.headline),
  since: lc.since,
});

/** GET /causes for one subject of one cluster, as the token. */
export function readCauses(api: ApiReader, clusterId: string, subject: string) {
  return api.get<ApiCauses>('/causes', { cluster: clusterId, subject });
}

export const explainProblemTool = defineTool({
  name: 'explain_problem',
  title: 'Explain a problem',
  description: describe(
    'WatchLog\'s probable cause of a problem, with its evidence: what is likely or possibly behind a failing workload, pod, Docker container, Compose service, service-map edge or monitored service, and what was checked. It is the same evidence the dashboard\'s "Likely cause" panel and GET /causes show.',
    `Pass \`subject\`: a problem's \`subject\` from get_problems, a likelyCause's \`subject\`, or a chain step's object as \`<kind>:<ref>\`. ${SUBJECT_FORMS}. Returns subject, object (what it is about), symptomSince, resolvedAt, state, headline, causes (at most 3, ranked, at most one likely), checks and flowsOff.`,
    CAUSES_READING,
    "Next steps: get_workload, get_pod, get_events or get_recent_changes on the objects of the chain; explain_problem on the chain's far end to look further.",
    'Example question: "Why does checkout keep failing?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      subject: Type.String({
        minLength: 3,
        maxLength: SUBJECT_MAX,
        description:
          'What to explain, as <kind>:<ref>: workload:<namespace>/<name>, pod:<namespace>/<pod>, container:<host>/<name> or container:<name>, compose_service:<project>/<service>, edge:<map edge id>, application:<id or name>, or alert:<id>.',
      }),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.subject),
  async run(args, { api }) {
    try {
      parseSubject(args.subject);
    } catch (err) {
      if (err instanceof SubjectError)
        throw new ToolError('This subject is not in a form WatchLog explains.', SUBJECT_FORMS, {
          subject: text(args.subject, 253),
          ...(err.message !== SUBJECT_FORMS ? { problem: text(err.message, 253) } : {}),
        });
      throw err;
    }
    const cluster = await resolveCluster(api, args.cluster);
    const a = await readCauses(api, cluster.id, args.subject).catch((err: unknown) =>
      notFound(
        err,
        'WatchLog finds nothing with this name in this cluster.',
        'Take a subject from get_problems, or the name from get_workload, get_pod or list_applications.',
        { cluster: clusterField(cluster), subject: text(args.subject, 253) },
      ),
    );
    return {
      body: {
        cluster: clusterField(cluster),
        subject: object(a.subject),
        object: a.object ? object(a.object) : null,
        symptomSince: a.symptomSince,
        resolvedAt: a.resolvedAt,
        checkedAt: a.checkedAt,
        ...causesField(a),
      },
    };
  },
});
