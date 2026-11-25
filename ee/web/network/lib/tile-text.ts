// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// A device tile in words (ADR-235): one wording for the device's page and for the map's side
// panel, so a recorder reads "Recording", "16 / 16" and "about 12 days" in both. A tile exists
// only for what the device reports (lib/device-view.ts); nothing here writes "–" for a fact
// the device's kind can't have.
import { pct, uptimeText } from './format';
import type { TileSpec } from './device-view';

export interface TileText {
  key: TileSpec['key'];
  label: string;
  value: string;
  sub: string;
  /** A sentence, not a number: set smaller. */
  small?: boolean;
}

type T = (key: string, values?: Record<string, unknown>, count?: number) => string;

const num = (v: unknown) => (typeof v === 'number' ? v : null);

export function tileText(t: T, x: TileSpec): TileText {
  const label = t(`netDevice.tiles.${x.key}`);
  const runtime = (sec: number) =>
    sec >= 3600
      ? t('netDevice.tiles.hoursMinutes', {
          h: Math.floor(sec / 3600),
          m: Math.round((sec % 3600) / 60),
        })
      : t('netDevice.tiles.minutes', { m: Math.round(sec / 60) });
  switch (x.key) {
    case 'cpu':
    case 'memory':
      return { key: x.key, label, value: pct(num(x.value)), sub: '' };
    case 'temperature':
      return {
        key: x.key,
        label,
        value: `${Math.round(num(x.value) ?? 0)} °C`,
        sub: x.extra != null ? t('netDevice.tiles.limit', { c: x.extra }) : '',
      };
    case 'ports':
      return {
        key: x.key,
        label,
        value: `${x.value} / ${x.of}`,
        sub: t('netDevice.tiles.portsSub'),
      };
    case 'power':
    case 'fans':
      return { key: x.key, label, value: `${x.value} / ${x.of}`, sub: t('netDevice.tiles.ok') };
    case 'poe':
      return {
        key: x.key,
        label,
        value: `${Math.round(num(x.value) ?? 0)} W`,
        sub: t('netDevice.tiles.poeSub'),
      };
    case 'routes':
      return { key: x.key, label, value: String(x.value), sub: String(x.extra ?? '') };
    case 'clients':
      return {
        key: x.key,
        label,
        value: x.value == null ? '–' : String(x.value),
        sub: t('netDevice.tiles.clientsSub'),
      };
    case 'radios':
      return {
        key: x.key,
        label,
        value: x.value == null ? '–' : String(x.value),
        sub: '',
        small: true,
      };
    case 'weak':
      return {
        key: x.key,
        label,
        value: x.value == null ? '–' : String(x.value),
        sub: t('netDevice.tiles.weakSub', { dbm: x.extra ?? -75 }),
      };
    case 'charge':
    case 'load':
      return {
        key: x.key,
        label,
        value: x.value == null ? '–' : `${Math.round(num(x.value) ?? 0)}%`,
        sub: '',
      };
    case 'runtime':
      return {
        key: x.key,
        label,
        value: x.value == null ? '–' : runtime(num(x.value) ?? 0),
        sub: '',
      };
    case 'recording':
      return {
        key: x.key,
        label,
        value:
          x.value === true
            ? t('netDevice.tiles.recordingYes')
            : x.value === false
              ? t('netDevice.tiles.recordingNo')
              : t('netDevice.tiles.recordingUnknown'),
        sub: '',
        small: true,
      };
    case 'cameras':
      return {
        key: x.key,
        label,
        value: `${x.value} / ${x.of}`,
        sub: t('netDevice.tiles.camerasSub'),
      };
    case 'daysLeft': {
      // Never "0 days": under a day is said in words, and before an hour of its write rate
      // exists the tile says it is calculating.
      if (x.value === 'full')
        return { key: x.key, label, value: t('netDevice.tiles.full'), sub: '', small: true };
      if (x.value === 'calculating')
        return {
          key: x.key,
          label,
          value: t('netDevice.tiles.calculating'),
          sub: t('netDevice.tiles.calculatingSub'),
          small: true,
        };
      const days = num(x.value);
      if (days == null) return { key: x.key, label, value: '–', sub: '' };
      if (days < 1)
        return { key: x.key, label, value: t('netDevice.tiles.underDay'), sub: '', small: true };
      const n = Math.floor(days);
      return { key: x.key, label, value: t('netDevice.tiles.days', { n }, n), sub: '' };
    }
    case 'uptime':
      return { key: x.key, label, value: uptimeText(num(x.value)), sub: '' };
  }
}
