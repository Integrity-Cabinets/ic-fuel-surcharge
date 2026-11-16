// Pure calculation rules for the Integrity Cabinets fuel surcharge.
// No network or file access here, so every rule can be tested directly.
//
// Money is handled as whole numbers (thousandths of a dollar, cents, and
// hundredths of a percent) so there is never a floating-point rounding surprise.

// ---------- number parsing / formatting ----------

/** "6.127" or 6.127 -> 6127 (thousandths of a dollar). Returns null if unsuitable. */
export function parseThousandths(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const t = Math.round(value * 1000);
    if (Math.abs(value * 1000 - t) > 1e-6) return null; // more than 3 decimals
    return t > 0 ? t : null;
  }
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!m) return null;
  const t = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  return t > 0 ? t : null;
}

/** Round thousandths to whole cents, half up: 6254 -> 625, 6255 -> 626. */
export function roundToCents(thousandths) {
  return Math.floor((thousandths + 5) / 10);
}

export const formatThousandths = (t) => `${Math.floor(t / 1000)}.${String(t % 1000).padStart(3, '0')}`;
export const formatHundredths = (h) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;

function parseHundredthsStrict(text, what) {
  if (typeof text !== 'string' || !/^\d+\.\d{2}$/.test(text)) {
    throw new Error(`${what} must be written with exactly two decimals in quotes, e.g. "3.25" (got ${JSON.stringify(text)})`);
  }
  const [a, b] = text.split('.');
  return Number(a) * 100 + Number(b);
}

// ---------- surcharge chart ----------

/** Checks the chart for typos, gaps and overlaps. Throws a plain-language error if anything is off. */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Configuration is empty or unreadable.');
  if (!raw.configVersion) throw new Error('configVersion is missing.');
  if (!raw.timezone) throw new Error('timezone is missing.');
  if (raw.rounding !== 'nearest-cent-half-up') throw new Error('rounding must be "nearest-cent-half-up".');
  if (raw.aboveRange !== 'hold-and-flag') throw new Error('aboveRange must be "hold-and-flag".');
  if (!raw.belowRange || raw.belowRange.percent === undefined) {
    throw new Error('belowRange.percent must be stated explicitly (a 0% rate is never assumed).');
  }
  if (!raw.benchmark || !raw.benchmark.seriesId || !raw.benchmark.units) throw new Error('benchmark.seriesId and benchmark.units are required.');
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) throw new Error('tiers list is empty.');

  const tiers = raw.tiers.map((t, i) => {
    const row = `Tier ${i + 1}`;
    const minCents = parseHundredthsStrict(t.min, `${row} min`);
    const maxCents = parseHundredthsStrict(t.max, `${row} max`);
    const percentHundredths = parseHundredthsStrict(t.percent, `${row} percent`);
    if (minCents > maxCents) throw new Error(`${row}: min $${t.min} is above max $${t.max}.`);
    return { minCents, maxCents, percentHundredths };
  });
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1], cur = tiers[i];
    if (cur.minCents <= prev.maxCents) throw new Error(`Tier ${i + 1} overlaps tier ${i} (starts at or below $${formatHundredths(prev.maxCents)}).`);
    if (cur.minCents !== prev.maxCents + 1) throw new Error(`Gap between tier ${i} and tier ${i + 1}: nothing covers $${formatHundredths(prev.maxCents + 1)}.`);
    if (cur.percentHundredths <= prev.percentHundredths) throw new Error(`Tier ${i + 1} percent is not higher than tier ${i}.`);
  }
  const belowPercentHundredths = parseHundredthsStrict(raw.belowRange.percent, 'belowRange.percent');
  if (belowPercentHundredths >= tiers[0].percentHundredths) throw new Error('belowRange.percent must be lower than the first tier.');
  return {
    configVersion: String(raw.configVersion),
    timezone: raw.timezone,
    benchmark: raw.benchmark,
    belowPercentHundredths,
    tiers,
  };
}

/**
 * Find the surcharge for an EIA price given in thousandths of a dollar.
 * Returns { status: 'ok', percentHundredths, cents } or { status: 'above_range', cents }.
 */
export function lookupSurcharge(cfg, thousandths) {
  const cents = roundToCents(thousandths);
  if (cents < cfg.tiers[0].minCents) return { status: 'ok', percentHundredths: cfg.belowPercentHundredths, cents };
  const tier = cfg.tiers.find((t) => cents >= t.minCents && cents <= t.maxCents);
  if (!tier) return { status: 'above_range', cents };
  return { status: 'ok', percentHundredths: tier.percentHundredths, cents };
}

// ---------- calendar (daylight-saving aware) ----------

const isDateText = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export { isDateText };

export function addDays(dateText, n) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 1 = Monday ... 6 = Saturday, for a plain calendar date. */
export const weekdayOf = (dateText) => new Date(`${dateText}T00:00:00Z`).getUTCDay();

function zoneParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** The calendar date it currently is in the business time zone. */
export const localDate = (instant, timeZone) => zoneParts(instant, timeZone).date;

/** The exact moment a calendar date begins (12:00 a.m.) in the business time zone. */
export function startOfDayInZone(dateText, timeZone) {
  let guess = Date.parse(`${dateText}T00:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(new Date(guess), timeZone);
    const shownAsUtc = Date.parse(`${p.date}T00:00:00Z`) + ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
    const diff = shownAsUtc - Date.parse(`${dateText}T00:00:00Z`);
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

/** The Monday that starts the surcharge week containing this moment. */
export function weekStartFor(instant, timeZone) {
  const today = localDate(instant, timeZone);
  return addDays(today, -((weekdayOf(today) + 6) % 7));
}

// ---------- EIA response checking ----------

/**
 * Checks each row from EIA. Returns { observations: Map(date -> thousandths), problems: [text] }.
 * Anything that is not exactly the U.S. weekly on-highway diesel series in $/gal is rejected.
 */
export function validateEiaRows(rows, cfg, now) {
  const observations = new Map();
  const problems = [];
  if (!Array.isArray(rows)) return { observations, problems: ['EIA response did not contain a list of prices.'] };
  const today = localDate(now, cfg.timezone);
  for (const row of rows) {
    const where = `EIA row ${JSON.stringify(row && row.period)}`;
    if (!row || typeof row !== 'object') { problems.push('EIA returned an unreadable row.'); continue; }
    if (row.series !== cfg.benchmark.seriesId) { problems.push(`${where}: wrong series "${row.series}".`); continue; }
    if (String(row.units || '').toUpperCase() !== cfg.benchmark.units) { problems.push(`${where}: wrong units "${row.units}".`); continue; }
    if (!isDateText(row.period)) { problems.push(`${where}: unreadable date.`); continue; }
    if (weekdayOf(row.period) !== 1) { problems.push(`${where}: date is not a Monday.`); continue; }
    if (row.period > today) { problems.push(`${where}: dated in the future.`); continue; }
    const t = parseThousandths(row.value);
    if (t === null) { problems.push(`${where}: price ${JSON.stringify(row.value)} is missing or not a valid number.`); continue; }
    if (t < 500 || t > 20000) { problems.push(`${where}: price $${formatThousandths(t)} is outside any plausible range.`); continue; }
    if (observations.has(row.period) && observations.get(row.period) !== t) { problems.push(`${where}: EIA returned two different prices for the same week.`); observations.delete(row.period); continue; }
    observations.set(row.period, t);
  }
  return { observations, problems };
}

// ---------- weekly decision ----------

/**
 * Decides which weekly records (if any) should be added right now.
 *
 * The rule: the week beginning Monday M uses the EIA figure dated the Monday
 * before (M minus 7 days). EIA releases that figure on Tuesday (Wednesday after
 * a federal holiday), so it is always public before M begins. The figure dated
 * M itself is not released until after M has started, so it is never used for M.
 *
 * A week that already has a record is never touched again.
 *
 * Returns { created: [record], alerts: [{ level: 'error'|'warning', message }] }.
 */
export function planUpdate({ now, observations, records, cfg, retrievedAt }) {
  const tz = cfg.timezone;
  const created = [];
  const alerts = [];
  const have = new Set(records.map((r) => r.weekStart));
  const current = weekStartFor(now, tz);
  const next = addDays(current, 7);

  for (const weekStart of [current, next]) {
    if (have.has(weekStart)) continue;
    const isCurrent = weekStart === current;
    let observationDate = addDays(weekStart, -7);
    const notes = [];

    if (!observations.has(observationDate)) {
      if (!isCurrent) continue; // Normal: EIA has not released it yet. Try again on the next run.
      // The week has started and its figure never arrived. The most recent figure
      // that was public before the cutoff is therefore an earlier one.
      const earlier = [...observations.keys()].filter((d) => d < observationDate).sort().pop();
      if (!earlier) {
        alerts.push({ level: 'error', message: `No usable EIA figure for the week of ${weekStart}. Last confirmed rate retained.` });
        continue;
      }
      notes.push(`EIA figure dated ${observationDate} was not available; used the most recent earlier figure (${earlier}).`);
      alerts.push({ level: 'error', message: `Week of ${weekStart}: EIA figure dated ${observationDate} was missing, so the earlier figure dated ${earlier} was used. Please review.` });
      observationDate = earlier;
    }

    const thousandths = observations.get(observationDate);
    const found = lookupSurcharge(cfg, thousandths);
    if (found.status !== 'ok') {
      alerts.push({ level: 'error', message: `Week of ${weekStart}: EIA diesel $${formatThousandths(thousandths)} is above the top of the surcharge chart. No rate was set; the last confirmed rate stays on display as "pending" until staff enter a rate manually.` });
      continue;
    }
    if (isCurrent && records.length > 0) {
      notes.push('Recorded after the Monday cutoff because earlier scheduled runs did not complete.');
      alerts.push({ level: 'warning', message: `Week of ${weekStart} was recorded late (after the Monday cutoff).` });
    }
    created.push(buildRecord({ weekStart, cfg, method: 'auto', percentHundredths: found.percentHundredths, observationDate, thousandths, cents: found.cents, retrievedAt, now, notes }));
    have.add(weekStart);
  }

  if (!have.has(current)) {
    alerts.push({ level: 'error', message: `No rate is recorded for the current week (${current}). Dealers see the last confirmed rate marked as pending.` });
  }
  // By Thursday the figure dated this Monday should be out, even after a holiday.
  if (!have.has(next) && now >= startOfDayInZone(addDays(current, 3), tz) && !observations.has(current)) {
    alerts.push({ level: 'error', message: `EIA has not published the figure dated ${current}, which is overdue. Next week's rate (${next}) is not set yet.` });
  }
  return { created, alerts };
}

export function buildRecord({ weekStart, cfg, method, percentHundredths, observationDate, thousandths, cents, retrievedAt, now, notes }) {
  const tz = cfg.timezone;
  const record = {
    weekStart,
    displayEnd: addDays(weekStart, 4), // Friday, as shown on the weekly Dealer Update
    effectiveStart: startOfDayInZone(weekStart, tz).toISOString(),
    effectiveEnd: startOfDayInZone(addDays(weekStart, 7), tz).toISOString(),
    surchargePercent: formatHundredths(percentHundredths),
    method,
    benchmark: method === 'auto' ? {
      source: cfg.benchmark.source,
      seriesId: cfg.benchmark.seriesId,
      units: cfg.benchmark.units,
      observationDate,
      priceDollarsPerGallon: formatThousandths(thousandths),
      roundedForChart: formatHundredths(cents),
      retrievedAt,
    } : null,
    configVersion: cfg.configVersion,
    recordedAt: now.toISOString(),
    notes: notes || [],
  };
  return record;
}

/** Staff-entered rate for a week that has no record. Never replaces an existing week. */
export function buildManualRecord({ weekStart, percentText, note, records, cfg, now }) {
  if (!isDateText(weekStart) || weekdayOf(weekStart) !== 1) throw new Error(`Manual week must be a Monday written as YYYY-MM-DD (got "${weekStart}").`);
  if (records.some((r) => r.weekStart === weekStart)) throw new Error(`Week of ${weekStart} already has a recorded rate. Recorded weeks are never overwritten.`);
  const percentHundredths = parseHundredthsStrict(percentText, 'Manual percent');
  if (percentHundredths > 2500) throw new Error('Manual percent above 25.00 is refused as a likely typo.');
  if (!note || !note.trim()) throw new Error('A manual rate needs a short note saying who set it and why.');
  return buildRecord({ weekStart, cfg, method: 'manual', percentHundredths, retrievedAt: null, now, notes: [`Entered manually: ${note.trim()}`] });
}
