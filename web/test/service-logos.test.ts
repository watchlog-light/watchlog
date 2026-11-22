// SPDX-License-Identifier: AGPL-3.0-only
// One-colour logos follow the theme's text colour (ADR-229): Kafka's white mark was invisible on
// a light page. Coloured logos stay images in their brand colours.
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import { MONO_LOGOS, SERVICE_LOGO_URL, ServiceLogo } from '@/components/ui/serviceLogos';

describe('ServiceLogo', () => {
  it('draws Kafka in the text colour through a mask', () => {
    const w = mount({ render: () => h(ServiceLogo, { type: 'kafka', class: 'size-8' }) });
    const el = w.get('[data-logo="kafka"]');
    expect(el.element.tagName).toBe('SPAN');
    expect(el.classes()).toEqual(expect.arrayContaining(['bg-current', 'text-text', 'size-8']));
    expect(el.attributes('style')).toContain('mask');
  });

  it('keeps every other logo as an image', () => {
    for (const type of Object.keys(SERVICE_LOGO_URL).filter((t) => !MONO_LOGOS.has(t))) {
      const w = mount({ render: () => h(ServiceLogo, { type }) });
      expect(w.get(`[data-logo="${type}"]`).element.tagName).toBe('IMG');
    }
  });
});
