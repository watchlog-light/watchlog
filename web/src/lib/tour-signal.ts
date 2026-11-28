// SPDX-License-Identifier: AGPL-3.0-only
// The demo banner's "Replay the 30-second tour" (1.3.0, ADR-246): a counter the guided tour
// watches. It lives outside the tour's own chunk, which only the demo ever loads.
import { ref } from 'vue';

export const tourReplays = ref(0);

export function replayTour(): void {
  tourReplays.value++;
}
