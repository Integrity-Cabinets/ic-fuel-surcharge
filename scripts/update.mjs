#!/usr/bin/env node
// Weekly fuel-surcharge update for Integrity Cabinets.
//
// What it does each time it runs:
//   1. Reads the surcharge chart (config/surcharge-config.json) and checks it.
//   2. Asks EIA for the latest U.S. weekly on-highway diesel prices.
//   3. Adds a record for this week and/or next week if one is due and missing.
//   4. Writes data/status.json so staff can see what happened.
//
// It never changes a week that is already recorded, so running it twice is harmless.
//
// Usage:
//   node scripts/update.mjs                       (live: needs EIA_API_KEY)
//   node scripts/update.mjs --fixture FILE        (offline preview with sample data)
//   node scripts/update.mjs --manual-week 2026-11-23 --manual-percent 7.25 --note "Set by Derek: diesel above chart"
// Optional: --data-dir DIR   --now 2026-11-16T12:00:00Z (testing only)

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig, validateEiaRows, planUpdate, buildManualRecord, weekStartFor } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EIA_ENDPOINT = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`Could not read ${path.basename(file)}: ${err.message}`); }
}

async function writeJsonSafely(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, file); // swap in one step so a crash never leaves a half-written file
}

/** Fetch recent weekly prices from EIA. Retries a few times, then gives up. The key is never logged. */
export async function fetchEiaRows({ apiKey, seriesId, fetchImpl = fetch, attempts = 3, timeoutMs = 20000, waitMs = 3000 }) {
  const url = new URL(EIA_ENDPOINT);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', 'weekly');
  url.searchParams.set('data[0]', 'value');
  url.searchParams.set('facets[series][]', seriesId);
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '8');
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`EIA rejected the API key (HTTP ${res.status}).`), { final: true });
      if (!res.ok) throw new Error(`EIA answered HTTP ${res.status}.`);
      const body = await res.json();
      const rows = body && body.response && body.response.data;
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('EIA answered without any price rows.');
      return rows;
    } catch (err) {
      lastError = err.name === 'AbortError' ? `EIA did not answer within ${timeoutMs / 1000} seconds.` : err.message;
      if (err.final) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs * attempt));
    } finally { clearTimeout(timer); }
  }
  throw new Error(`Could not get prices from EIA: ${lastError}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const dataDir = path.resolve(args['data-dir'] || path.join(ROOT, 'data'));
  const dataFile = path.join(dataDir, 'fuel-surcharge.json');
  const statusFile = path.join(dataDir, 'status.json');
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('--now is not a valid date.');

  const previousStatus = await readJson(statusFile, {});
  const status = {
    lastRunAt: now.toISOString(),
    lastSuccessAt: previousStatus.lastSuccessAt || null,
    ok: false,
    mode: args.fixture ? 'DEMO (sample data, not live)' : 'live',
    currentWeek: null,
    currentWeekHasRate: false,
    nextWeekHasRate: false,
    recordsAdded: [],
    alerts: [],
  };
  let data;
  try {
    const cfg = validateConfig(await readJson(path.join(ROOT, 'config', 'surcharge-config.json')));
    data = await readJson(dataFile, { schemaVersion: 1, timezone: cfg.timezone, records: [] });
    if (!Array.isArray(data.records)) throw new Error('fuel-surcharge.json has no records list.');
    const current = weekStartFor(now, cfg.timezone);
    status.currentWeek = current;

    const manualWeek = args['manual-week'] || env.MANUAL_WEEK;
    let created = [];
    if (manualWeek) {
      created = [buildManualRecord({ weekStart: manualWeek, percentText: args['manual-percent'] || env.MANUAL_PERCENT, note: args.note || env.MANUAL_NOTE, records: data.records, cfg, now })];
    } else {
      let rows;
      if (args.fixture) {
        rows = (await readJson(path.resolve(args.fixture))).response.data;
      } else {
        const apiKey = env.EIA_API_KEY;
        if (!apiKey || /your-eia-api-key/i.test(apiKey)) throw new Error('EIA_API_KEY is not set. Add it as a GitHub secret (or in a local .env file).');
        rows = await fetchEiaRows({ apiKey, seriesId: cfg.benchmark.seriesId });
      }
      const { observations, problems } = validateEiaRows(rows, cfg, now);
      problems.forEach((message) => status.alerts.push({ level: 'warning', message }));
      if (observations.size === 0) throw new Error('EIA returned no usable prices.');
      status.latestEiaFigureSeen = [...observations.keys()].sort().pop();
      const plan = planUpdate({ now, observations, records: data.records, cfg, retrievedAt: now.toISOString() });
      created = plan.created;
      status.alerts.push(...plan.alerts);
    }

    if (created.length) {
      // Re-read just before saving so a second run that finished first is respected.
      const latest = await readJson(dataFile, data);
      const taken = new Set(latest.records.map((r) => r.weekStart));
      const fresh = created.filter((r) => !taken.has(r.weekStart));
      if (fresh.length) {
        latest.records = [...latest.records, ...fresh].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
        await writeJsonSafely(dataFile, latest);
      }
      data = latest;
      status.recordsAdded = fresh.map((r) => `${r.weekStart}: ${r.surchargePercent}%`);
    }
    status.ok = !status.alerts.some((a) => a.level === 'error');
    if (status.ok) status.lastSuccessAt = now.toISOString();
  } catch (err) {
    status.alerts.push({ level: 'error', message: err.message });
  }

  if (data && status.currentWeek) {
    const weeks = new Set(data.records.map((r) => r.weekStart));
    status.currentWeekHasRate = weeks.has(status.currentWeek);
    const d = new Date(`${status.currentWeek}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7);
    status.nextWeekHasRate = weeks.has(d.toISOString().slice(0, 10));
  }
  await writeJsonSafely(statusFile, status);

  for (const a of status.alerts) console.log(`[${a.level.toUpperCase()}] ${a.message}`);
  if (status.recordsAdded.length) console.log(`Recorded: ${status.recordsAdded.join('; ')}`);
  console.log(status.ok ? 'Finished: OK.' : 'Finished: NEEDS ATTENTION. No rate was changed or invented; see alerts above.');
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((s) => { process.exitCode = s.ok ? 0 : 1; }, (err) => { console.error(`[ERROR] ${err.message}`); process.exitCode = 1; });
}
