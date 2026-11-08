// SPDX-License-Identifier: AGPL-3.0-only
// The MCP tools of v0.2 (ADR-128), in the order clients list them: the usual path of an
// investigation, from the clusters to one object's facts.
import { explainAlertTool, listAlertsTool } from './alerts.js';
import { listClustersTool } from './clusters.js';
import type { ToolDef } from './common.js';
import { getEventsTool, getRecentChangesTool } from './events.js';
import { queryMetricTool } from './metrics.js';
import { getNodeTool } from './nodes.js';
import { getPodTool } from './pods.js';
import { getProblemsTool } from './problems.js';
import { getServiceMapTool } from './servicemap.js';
import { getWorkloadTool } from './workloads.js';

export type { ToolContext, ToolDef } from './common.js';

export const TOOLS: ToolDef[] = [
  listClustersTool,
  getProblemsTool,
  listAlertsTool,
  explainAlertTool,
  getWorkloadTool,
  getPodTool,
  getNodeTool,
  getServiceMapTool,
  getEventsTool,
  getRecentChangesTool,
  queryMetricTool,
];
