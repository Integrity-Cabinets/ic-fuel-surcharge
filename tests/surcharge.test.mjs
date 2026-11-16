import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateConfig, lookupSurcharge, parseThousandths, roundToCents, formatHundredths,
  startOfDayInZone, weekStartFor, validateEiaRows, planUpdate, buildManualRecord,
} from '../scripts/lib.mjs';
import { main, fetchEiaRows } from '../scripts/update.mjs';

const rawCfg = JSON.parse(await readFile(new URL('../config/surcharge-config.json', import.meta.url), 'utf8'));
const cfg = validateConfig(rawCfg);
const pct = (price) => { const r = lookupSurcharge(cfg, parseThousandths(price)); return r.status === 'ok' ? formatHundredths(r.percentHundredths) : r.status; };
const obs = (o) => new Map(Object.entries(o).map(([d, p]) => [d, parseThousandths(p)]));
const plan = (now, o, records = []) => planUpdate({ now: new Date(now), observations: obs(o), records, cfg, retrievedAt: now });

test('chart: 28 tiers, every tier top and bottom lands where the printed chart says', () => {
  assert.equal(cfg.tiers.length, 28);
  cfg.tiers.forEach((t, i) => {
    const want = formatHundredths((i + 1) * 25);
    assert.equal(pct(formatHundredths(t.minCents)), want);
    assert.equal(pct(formatHundredths(t.maxCents)), want);
  });
  assert.equal(pct('3.00'), '0.25'); assert.equal(pct('3.25'), '0.25'); assert.equal(pct('3.26'), '0.50');
  assert.equal(pct('6.50'), '3.50'); assert.equal(pct('6.51'), '3.75'); assert.equal(pct('10.00'), '7.00');
});

test('precision: three-decimal prices round to the cent (half up) before the chart is read', () => {
  assert.equal(roundToCents(6254), 625); assert.equal(roundToCents(6255), 626);
  assert.equal(pct('6.254'), '3.25');
  assert.equal(pct('6.255'), '3.50');
  assert.equal(pct('6.292'), '3.50'); // EIA Nov 2, 2026 -> matches the Nov 9 Dealer Update
  assert.equal(pct('6.127'), '3.25');
  assert.equal(parseThousandths(6.127), 6127); // number form, no float drift
  assert.equal(parseThousandths('6.1'), 6100);
  for (const bad of [null, '', 'abc', '-1', '0', '6.1275', NaN, 0, -3, 6.12759]) assert.equal(parseThousandths(bad), null);
});

test('out of range: 0% below $3.00, flagged (no rate) above $10.00', () => {
  assert.equal(pct('2.994'), '0.00');
  assert.equal(pct('2.995'), '0.25'); // rounds to $3.00
  assert.equal(pct('10.004'), '7.00'); // rounds to $10.00
  assert.equal(pct('10.005'), 'above_range');
  assert.equal(pct('12.000'), 'above_range');
});

test('config check: catches gaps, overlaps, missing rates and an unstated 0% tier', () => {
  const clone = () => JSON.parse(JSON.stringify(rawCfg));
  let c = clone(); c.tiers[3].min = '3.77'; assert.throws(() => validateConfig(c), /Gap/);
  c = clone(); c.tiers[3].min = '3.75'; assert.throws(() => validateConfig(c), /overlaps/);
  c = clone(); delete c.tiers[5].percent; assert.throws(() => validateConfig(c), /percent/);
  c = clone(); c.tiers[5].percent = 1.5; assert.throws(() => validateConfig(c), /two decimals/);
  c = clone(); c.tiers[5].percent = '1.25'; assert.throws(() => validateConfig(c), /not higher/);
  c = clone(); delete c.belowRange; assert.throws(() => validateConfig(c), /never assumed/);
  c = clone(); c.tiers = []; assert.throws(() => validateConfig(c), /empty/);
});

test('Monday cutoff and daylight saving: midnight Central is found correctly all year', () => {
  const tz = 'America/Chicago';
  assert.equal(startOfDayInZone('2026-03-02', tz).toISOString(), '2026-03-02T06:00:00.000Z'); // CST
  assert.equal(startOfDayInZone('2026-03-09', tz).toISOString(), '2026-03-09T05:00:00.000Z'); // day after clocks spring forward
  assert.equal(startOfDayInZone('2026-10-26', tz).toISOString(), '2026-10-26T05:00:00.000Z'); // CDT
  assert.equal(startOfDayInZone('2026-11-02', tz).toISOString(), '2026-11-02T06:00:00.000Z'); // day after clocks fall back
  assert.equal(weekStartFor(new Date('2026-11-16T05:59:59Z'), tz), '2026-11-09'); // Sunday 11:59:59 p.m. Central
  assert.equal(weekStartFor(new Date('2026-11-16T06:00:00Z'), tz), '2026-11-16'); // Monday 12:00 a.m. Central
  assert.equal(weekStartFor(new Date('2026-03-09T04:59:59Z'), tz), '2026-03-02');
  assert.equal(weekStartFor(new Date('2026-03-09T05:00:00Z'), tz), '2026-03-09');
  // The week containing a clock change is 167 or 169 hours long, never a fixed 168.
  const r = plan('2026-03-04T18:00:00Z', { '2026-02-23': '4.000', '2026-03-02': '4.100' });
  const wk = r.created.find((x) => x.weekStart === '2026-03-09');
  assert.equal(wk.effectiveStart, '2026-03-09T05:00:00.000Z');
  assert.equal(wk.effectiveEnd, '2026-03-16T05:00:00.000Z');
  const cur = r.created.find((x) => x.weekStart === '2026-03-02');
  assert.equal((Date.parse(cur.effectiveEnd) - Date.parse(cur.effectiveStart)) / 3600000, 167);
});

test('Tuesday arrival: new EIA figure is stored for NEXT Monday and leaves this week alone', () => {
  const thisWeek = plan('2026-11-16T12:00:00Z', { '2026-11-02': '6.292', '2026-11-09': '6.127' }).created;
  assert.deepEqual(thisWeek.map((r) => [r.weekStart, r.surchargePercent]), [['2026-11-16', '3.25']]);
  // Tuesday: the figure dated Nov 16 arrives, and falls in a different tier.
  const tue = plan('2026-11-17T17:00:00Z', { '2026-11-09': '6.127', '2026-11-16': '6.300' }, thisWeek);
  assert.deepEqual(tue.created.map((r) => [r.weekStart, r.surchargePercent, r.benchmark.observationDate]), [['2026-11-23', '3.50', '2026-11-16']]);
  assert.deepEqual(tue.alerts, []);
  assert.equal(thisWeek[0].surchargePercent, '3.25');
  assert.equal(thisWeek[0].benchmark.observationDate, '2026-11-09');
});

test('late run: a job delayed to Wednesday still uses last week\'s figure, not Tuesday\'s new one', () => {
  const prior = plan('2026-11-10T17:00:00Z', { '2026-10-26': '6.352', '2026-11-02': '6.292' }).created; // only week of Nov 9
  const late = plan('2026-11-18T17:00:00Z', { '2026-11-02': '6.292', '2026-11-09': '6.127', '2026-11-16': '6.600' }, prior);
  const cur = late.created.find((r) => r.weekStart === '2026-11-16');
  assert.equal(cur.benchmark.observationDate, '2026-11-09');
  assert.equal(cur.surchargePercent, '3.25');
  assert.ok(late.alerts.some((a) => a.level === 'warning' && /late/.test(a.message)));
});

test('duplicate runs and EIA revisions never change a recorded week', () => {
  const first = plan('2026-11-17T17:00:00Z', { '2026-11-09': '6.127', '2026-11-16': '6.300' }).created;
  assert.equal(first.length, 2);
  const again = plan('2026-11-17T17:05:00Z', { '2026-11-09': '6.127', '2026-11-16': '6.300' }, first);
  assert.deepEqual(again.created, []);
  const revised = plan('2026-11-19T17:00:00Z', { '2026-11-09': '6.900', '2026-11-16': '7.900' }, first);
  assert.deepEqual(revised.created, []);
});

test('missing data: nothing invented; stale or absent figures are flagged', () => {
  // Mid-week, next figure not yet out: normal, no alert, nothing created.
  const base = plan('2026-11-16T12:00:00Z', { '2026-11-09': '6.127' }).created;
  const tue = plan('2026-11-17T12:00:00Z', { '2026-11-09': '6.127' }, base);
  assert.deepEqual(tue, { created: [], alerts: [] });
  // Thursday and still not out: overdue alert.
  const thu = plan('2026-11-19T12:00:00Z', { '2026-11-09': '6.127' }, base);
  assert.deepEqual(thu.created, []);
  assert.ok(thu.alerts.some((a) => a.level === 'error' && /overdue/.test(a.message)));
  // EIA skipped a week entirely: the new week uses the last figure that was public, and says so.
  const skipped = plan('2026-11-23T12:00:00Z', { '2026-11-09': '6.127' }, base);
  assert.equal(skipped.created[0].weekStart, '2026-11-23');
  assert.equal(skipped.created[0].benchmark.observationDate, '2026-11-09');
  assert.match(skipped.created[0].notes[0], /not available/);
  assert.ok(skipped.alerts.some((a) => a.level === 'error'));
  // Above the chart: no record, flagged.
  const high = plan('2026-11-23T12:00:00Z', { '2026-11-16': '10.250' }, base);
  assert.deepEqual(high.created, []);
  assert.ok(high.alerts.some((a) => /above the top/.test(a.message)));
  assert.ok(high.alerts.some((a) => /pending/.test(a.message)));
});

test('EIA answer checking: wrong series, units, dates and bad numbers are rejected', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const ok = { period: '2026-11-09', series: 'EMD_EPD2D_PTE_NUS_DPG', value: '6.127', units: '$/GAL' };
  const rows = [
    ok,
    { ...ok, period: '2026-11-02', series: 'EMD_EPD2D_PTE_R10_DPG' }, // regional
    { ...ok, period: '2026-10-26', series: 'EMM_EPMR_PTE_NUS_DPG' },  // gasoline
    { ...ok, period: '2026-10-19', units: '$/BBL' },
    { ...ok, period: '2026-10-12', value: null },
    { ...ok, period: '2026-10-05', value: '0' },
    { ...ok, period: '2026-09-28', value: '-4.1' },
    { ...ok, period: '2026-11-23' },                                   // future
    { ...ok, period: '2026-11-10' },                                   // not a Monday
    { ...ok, period: 'soon' },
    { ...ok, period: '2026-09-21', value: '61.270' },                  // implausible
  ];
  const { observations, problems } = validateEiaRows(rows, cfg, now);
  assert.deepEqual([...observations], [['2026-11-09', 6127]]);
  assert.equal(problems.length, 10);
});

test('feed failure: bounded retries, then an error; saved rates untouched; no false success', async () => {
  let calls = 0;
  const failing = async () => { calls++; throw new Error('network down'); };
  await assert.rejects(fetchEiaRows({ apiKey: 'k', seriesId: 'S', fetchImpl: failing, attempts: 3, waitMs: 1 }), /Could not get prices/);
  assert.equal(calls, 3);
  const badKey = async () => ({ ok: false, status: 403 });
  await assert.rejects(fetchEiaRows({ apiKey: 'k', seriesId: 'S', fetchImpl: badKey, waitMs: 1 }), /rejected the API key/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'icfs-'));
  const fixture = new URL('./fixtures/eia-sample.json', import.meta.url).pathname;
  const quiet = console.log; console.log = () => {};
  try {
    const a = await main(['--data-dir', dir, '--fixture', fixture, '--now', '2026-11-16T12:00:00Z'], {});
    assert.equal(a.ok, true);
    const before = await readFile(path.join(dir, 'fuel-surcharge.json'), 'utf8');
    assert.equal(JSON.parse(before).records.length, 1);
    // Same run again: nothing changes.
    await main(['--data-dir', dir, '--fixture', fixture, '--now', '2026-11-16T12:10:00Z'], {});
    assert.equal(await readFile(path.join(dir, 'fuel-surcharge.json'), 'utf8'), before);
    // Live run with no key: fails loudly, keeps the saved rate, keeps the old success time.
    const b = await main(['--data-dir', dir, '--now', '2026-11-17T12:00:00Z'], {});
    assert.equal(b.ok, false);
    assert.equal(b.lastSuccessAt, '2026-11-16T12:10:00.000Z');
    assert.equal(b.currentWeekHasRate, true);
    assert.match(b.alerts[0].message, /EIA_API_KEY/);
    assert.equal(await readFile(path.join(dir, 'fuel-surcharge.json'), 'utf8'), before);
    // Empty / garbage feed: fails, nothing saved.
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ response: { data: [{ period: '2026-11-16', series: 'X', value: null }] } }));
    const c = await main(['--data-dir', dir, '--fixture', bad, '--now', '2026-11-17T12:00:00Z'], {});
    assert.equal(c.ok, false);
    assert.equal(await readFile(path.join(dir, 'fuel-surcharge.json'), 'utf8'), before);
  } finally { console.log = quiet; }
});

test('manual entry: fills an empty week only, with a note, never overwrites', () => {
  const now = new Date('2026-11-23T15:00:00Z');
  const rec = buildManualRecord({ weekStart: '2026-11-23', percentText: '7.25', note: 'Set by Derek, diesel above chart', records: [], cfg, now });
  assert.equal(rec.surchargePercent, '7.25'); assert.equal(rec.method, 'manual'); assert.equal(rec.benchmark, null);
  assert.throws(() => buildManualRecord({ weekStart: '2026-11-23', percentText: '7.25', note: 'x', records: [rec], cfg, now }), /never overwritten/);
  assert.throws(() => buildManualRecord({ weekStart: '2026-11-24', percentText: '7.25', note: 'x', records: [], cfg, now }), /Monday/);
  assert.throws(() => buildManualRecord({ weekStart: '2026-11-23', percentText: '7.25', note: '', records: [], cfg, now }), /note/);
  assert.throws(() => buildManualRecord({ weekStart: '2026-11-23', percentText: '725', note: 'x', records: [], cfg, now }), /two decimals/);
});
