// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TooltipHint from '@/components/ui/TooltipHint.vue';

describe('TooltipHint', () => {
  it('takes no layout space while hidden, so it cannot widen the page', () => {
    // An `invisible` tooltip still counted toward the scroll width: a badge at the
    // right edge of the node page gave the page a horizontal scrollbar.
    const w = mount(TooltipHint, { props: { text: 'Why' }, slots: { default: 'badge' } });
    const tip = w.get('[role="tooltip"]');
    expect(tip.classes()).toContain('hidden');
    expect(tip.classes()).not.toContain('invisible');
    expect(tip.classes()).toContain('left-0');
    expect(w.get('[tabindex="0"]').attributes('aria-describedby')).toBe(tip.attributes('id'));
  });

  it('opens leftwards for triggers at the right edge', () => {
    const w = mount(TooltipHint, { props: { text: 'Why', align: 'end' }, slots: { default: 'b' } });
    expect(w.get('[role="tooltip"]').classes()).toContain('right-0');
  });
});
