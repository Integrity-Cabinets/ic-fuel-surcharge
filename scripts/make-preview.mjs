#!/usr/bin/env node
// Builds widget/preview.html: the banner filled with SAMPLE data so you can see
// the layout by double-clicking the file. Nothing here touches live data.
//   node scripts/make-preview.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'preview-data');
const now = '2026-11-16T18:00:00Z';
await rm(dir, { recursive: true, force: true });
await main(['--data-dir', dir, '--fixture', path.join(ROOT, 'tests/fixtures/eia-sample.json'), '--now', now], {});
const records = JSON.parse(await readFile(path.join(dir, 'fuel-surcharge.json'), 'utf8')).records;
const lead = JSON.parse(await readFile(path.join(ROOT, 'data/lead-times.json'), 'utf8'));
const banner = await readFile(path.join(ROOT, 'widget/fuel-surcharge-banner.html'), 'utf8');

const ann = { announcements: [{ text: 'SAMPLE ANNOUNCEMENT: Our offices will be closed Thursday and Friday, November 26 and 27.', showFrom: '2026-11-16', showThrough: '2026-11-27' }] };
const states = [
  ['Normal week, with an announcement', { now, records, lead, ann }],
  ['The following week: lead times have rolled forward 7 days; rate pending (update missed or diesel above the chart)', { now: '2026-11-25T18:00:00Z', records, lead }],
  ['No rate has ever been published; lead-times file unreadable', { now, records: [], lead: false }],
];
const frames = states.map(([title, demo]) => {
  const doc = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:24px 16px;background:#3a2a1c linear-gradient(160deg,#4a3524,#2a1d13)"><script>window.IC_FUEL_DEMO=${JSON.stringify(demo).replace(/</g, '\\u003c')}<\/script>${banner}</body>`;
  return `<h2>${title}</h2><iframe title="${title}" srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
}).join('\n');
await writeFile(path.join(ROOT, 'widget/preview.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DEMO - Fuel surcharge banner preview</title>
<style>body{font:15px/1.5 Arial,sans-serif;margin:24px;background:#f4f1ec;color:#222}h1{font-size:20px}h2{font-size:14px;margin:24px 0 6px}iframe{width:100%;height:380px;border:1px solid #bbb}@media(max-width:760px){iframe{height:680px}}p{max-width:60em}</style>
<h1>DEMO preview: sample data, not a live rate</h1>
<p>These panels use the sample file in tests/fixtures. They show how the banner looks in each situation. Narrow the window to see the phone layout.</p>
${frames}
`);
await rm(dir, { recursive: true, force: true });
console.log('Wrote widget/preview.html');
