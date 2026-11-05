// SPDX-License-Identifier: AGPL-3.0-only
// Fails when a series has a gap: no two consecutive samples may be further apart than
// --max-gap seconds within [--from, --to] (Phase 1 acceptance #3, ADR-037).
//   node check-gaps.mjs --vm http://127.0.0.1:8428 --match 'watchlog_node_load1{host="h"}' \
//     --from 1793400000 --to 1793401000 --max-gap 22.5
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    vm: { type: 'string', default: 'http://127.0.0.1:8428' },
    match: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'max-gap': { type: 'string', default: '22.5' },
  },
});
if (!values.match || !values.from || !values.to) {
  console.error(
    'usage: check-gaps.mjs --match <selector> --from <unix s> --to <unix s> [--vm url] [--max-gap s]',
  );
  process.exit(2);
}
const from = Number(values.from) * 1000;
const to = Number(values.to) * 1000;
const maxGapMs = Number(values['max-gap']) * 1000;

await fetch(`${values.vm}/internal/force_flush`).catch(() => {});
const url = new URL('/api/v1/export', values.vm);
url.searchParams.set('match[]', values.match);
url.searchParams.set('start', String(from / 1000));
url.searchParams.set('end', String(to / 1000));
const res = await fetch(url);
if (!res.ok) {
  console.error(`export failed: ${res.status} ${await res.text()}`);
  process.exit(2);
}
const series = (await res.text())
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (series.length === 0) {
  console.error(`FAIL: no series match ${values.match}`);
  process.exit(1);
}

let failed = false;
for (const s of series) {
  const ts = s.timestamps.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const gaps = [];
  let maxGap = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    maxGap = Math.max(maxGap, gap);
    if (gap > maxGapMs)
      gaps.push(
        `${new Date(ts[i - 1]).toISOString()} → ${new Date(ts[i]).toISOString()} (${gap / 1000}s)`,
      );
  }
  const edgeGaps = [ts[0] - from, to - ts.at(-1)].filter((g) => g > maxGapMs);
  const labels = JSON.stringify(s.metric);
  console.log(`${labels}: ${ts.length} samples, max gap ${maxGap / 1000}s`);
  for (const g of gaps) console.log(`  GAP ${g}`);
  if (edgeGaps.length)
    console.log(`  GAP at window edge: ${edgeGaps.map((g) => g / 1000 + 's').join(', ')}`);
  if (gaps.length || edgeGaps.length || ts.length < 2) failed = true;
}
console.log(failed ? 'FAIL: data was lost' : 'PASS: no gaps');
process.exit(failed ? 1 : 0);
