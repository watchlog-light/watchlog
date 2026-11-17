// SPDX-License-Identifier: AGPL-3.0-only
// PHP-FPM in the dashboard (ADR-212): its name, logo, alert metrics and page strings.
import { describe, expect, it } from 'vitest';
import { SERVICE_LOGO_URL } from '@/components/ui/serviceLogos';
import { createAppI18n } from '@/i18n';
import { serviceMetrics } from '@/lib/alerts';
import { familyOf, serviceName } from '@/lib/applications';

describe('PHP-FPM', () => {
  it('has a name, a family, a logo and its alert metrics', () => {
    expect(serviceName('php-fpm')).toBe('PHP-FPM');
    expect(familyOf('php-fpm')).toBe('proxies');
    expect(SERVICE_LOGO_URL['php-fpm']).toBeTruthy();
    expect(serviceMetrics('php-fpm').map((m) => m.key)).toContain(
      'php-fpm.max_children_reached.increase',
    );
  });

  it("resolves its strings, the key's hyphen included", () => {
    const { t, te } = createAppI18n().global;
    expect(te('integrations.php-fpm.panels.summary')).toBe(true);
    expect(t('integrations.php-fpm.missing.overview')).toContain('pm.status_path');
    expect(t('integrations.reasons.phpfpm_max_children', { times: 3, queue: 4 })).toContain(
      'busy 3 times',
    );
    expect(t('metricNames.php-fpm_listen_queue')).toBe('PHP-FPM requests waiting');
  });
});
