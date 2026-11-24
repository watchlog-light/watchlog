// SPDX-License-Identifier: AGPL-3.0-only
// The kinds the network module's events are stored with (ADR-233, events/record.ts): a switch
// port, or a whole device. What changed and probable cause read them; the Events list shows
// them like any other.
export const NETWORK_EVENT_KINDS = ['NetworkPort', 'NetworkDevice'];
