// SPDX-License-Identifier: AGPL-3.0-only
// The MCP tools (ADR-128; the services of v0.3, ADR-135; probable cause, ADR-148; egress, ADR-189; What changed, ADR-202), in the order clients list them: the usual path of an
// investigation, from the clusters to one object's facts.
import { explainAlertTool, listAlertsTool } from './alerts.js';
import { getApplicationTool, listApplicationsTool } from './applications.js';
import { explainProblemTool } from './causes.js';
import { listClustersTool } from './clusters.js';
import type { ToolDef } from './common.js';
import { getEgressTool, getExpectedDestinationsTool, getNewDestinationsTool } from './egress.js';
import { getEventsTool, getRecentChangesTool } from './events.js';
import { queryMetricTool } from './metrics.js';
import { getNodeTool } from './nodes.js';
import { getContainerLogsTool } from './logs.js';
import { getPodTool } from './pods.js';
import { getProblemsTool } from './problems.js';
import { getRightSizingTool } from './rightsizing.js';
import { getServiceMapTool } from './servicemap.js';
import { getWhatChangedTool } from './whatchanged.js';
import { getWorkloadTool } from './workloads.js';

export type { ToolContext, ToolDef } from './common.js';

export const TOOLS: ToolDef[] = [
  listClustersTool,
  getProblemsTool,
  listAlertsTool,
  explainAlertTool,
  explainProblemTool,
  getWorkloadTool,
  getPodTool,
  getContainerLogsTool,
  getRightSizingTool,
  getNodeTool,
  listApplicationsTool,
  getApplicationTool,
  getServiceMapTool,
  getEgressTool,
  getNewDestinationsTool,
  getExpectedDestinationsTool,
  getEventsTool,
  getRecentChangesTool,
  getWhatChangedTool,
  queryMetricTool,
];

/** Tools only Cloud and the live demo register (ADR-202): Community's list is unchanged. */
export const WHAT_CHANGED_TOOLS: ReadonlySet<string> = new Set([getWhatChangedTool.name]);

/** The tools this installation registers: without What changed's in Community. */
export const toolsFor = (whatChanged: boolean): ToolDef[] =>
  whatChanged ? TOOLS : TOOLS.filter((t) => !WHAT_CHANGED_TOOLS.has(t.name));
