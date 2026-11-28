// SPDX-License-Identifier: AGPL-3.0-only
// The guided tour's story (1.3.0, ADR-246): for the side the visitor picked, the first story
// of the demo's configuration (in its order) whose failure is open now with a Likely cause;
// if none is, the story marked as the fallback (a failure that never heals). Live data only:
// a story is an open alert the demo really has, never a recording.

export type TourKind = 'kubernetes' | 'server';

/** A story as the demo's configuration gives it (GET /demo/tour). */
export interface TourStory {
  id: string;
  kind: TourKind;
  /** The alert rule's key or, for rules without one, its name. */
  rules: string[];
  labels: Record<string, string>;
  fallback: boolean;
}

/** An open alert as the alerts list gives it (only what the choice reads). */
export interface OpenAlert {
  id: string;
  title: string;
  cluster: { id: string; kind: string; name: string };
  rule: { key: string | null; name: string };
  labels: Record<string, string>;
  startedAt: string;
  firedAt: string | null;
}

/** The chosen story, with the alert it tells and how sure its cause is. */
export interface ChosenStory {
  story: TourStory;
  alert: OpenAlert;
  cause: 'likely' | 'possible' | 'none' | null;
}

const sameKind = (story: TourStory, alert: OpenAlert) =>
  alert.cluster.kind === (story.kind === 'server' ? 'server' : 'kubernetes');

/** Whether an open alert is this story's failure: its rule, its side and every label. */
export function storyMatches(story: TourStory, alert: OpenAlert): boolean {
  if (!sameKind(story, alert)) return false;
  if (!story.rules.some((r) => r === alert.rule.key || r === alert.rule.name)) return false;
  return Object.entries(story.labels).every(([k, v]) => alert.labels[k] === v);
}

/** The oldest open alert of a story (the one the welcome line can say is open longest). */
function openAlertOf(story: TourStory, alerts: OpenAlert[]): OpenAlert | null {
  const mine = alerts.filter((a) => storyMatches(story, a));
  mine.sort((a, b) => Date.parse(a.firedAt ?? a.startedAt) - Date.parse(b.firedAt ?? b.startedAt));
  return mine[0] ?? null;
}

/**
 * The story to tell on one side: the first in the configuration's order that is open with a
 * Likely cause (`causes` by alert id, from All clusters' list), else the first fallback that
 * is open, whatever its cause says. Null when nothing on that side can be shown.
 */
export function chooseStory(
  stories: TourStory[],
  kind: TourKind,
  alerts: OpenAlert[],
  causes: ReadonlyMap<string, 'likely' | 'possible' | 'none'>,
): ChosenStory | null {
  const mine = stories.filter((s) => s.kind === kind);
  for (const story of mine) {
    const alert = openAlertOf(story, alerts);
    if (alert && causes.get(alert.id) === 'likely') return { story, alert, cause: 'likely' };
  }
  for (const story of mine.filter((s) => s.fallback)) {
    const alert = openAlertOf(story, alerts);
    if (alert) return { story, alert, cause: causes.get(alert.id) ?? null };
  }
  return null;
}

/**
 * The stories offered at the end ("Or see another one"): those the configuration lists, open
 * now, other than the one just told. A story that isn't open is left out, never linked empty.
 */
export function anotherStories(
  stories: TourStory[],
  another: string[],
  current: string | null,
  alerts: OpenAlert[],
  causes: ReadonlyMap<string, 'likely' | 'possible' | 'none'>,
): ChosenStory[] {
  const out: ChosenStory[] = [];
  for (const id of another) {
    if (id === current) continue;
    const story = stories.find((s) => s.id === id);
    const alert = story ? openAlertOf(story, alerts) : null;
    if (story && alert) out.push({ story, alert, cause: causes.get(alert.id) ?? null });
  }
  return out;
}
