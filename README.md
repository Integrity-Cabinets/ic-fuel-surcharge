# Integrity Cabinets: Fuel Surcharge, Lead Times & Announcements Banner

A banner for the dealer portal page that shows this week's fuel surcharge, current lead times, and any announcements.

- The **surcharge** updates itself every Monday. Nobody has to touch it.
- The **lead times** move forward one week every Monday by themselves.
- **Announcements** appear when staff add one, and disappear on the end date given.

## How it works

1. **GitHub runs a small job twice a day.** It asks the U.S. Energy Information Administration (EIA) for the weekly U.S. on-highway diesel average, looks the price up in Integrity's surcharge chart, and saves the result in `data/fuel-surcharge.json`.
2. **The banner on the portal reads that saved file.** Every dealer sees the same number. Nothing is calculated in the dealer's browser.
3. **Every week is kept on file** in `data/fuel-surcharge.json`, with the diesel price and date used, for customer questions and invoice reconciliation.

## The rules it follows

| Rule | Value | Where it came from |
|---|---|---|
| Benchmark | EIA U.S. weekly retail on-highway diesel, all types, $/gal including taxes | Announcement of Sept 18, 2023 |
| Chart | 28 tiers, $3.00–$3.25 = 0.25% up to $9.76–$10.00 = 7.00% | Announcement of Sept 18, 2023 |
| When it changes | Monday 12:00 a.m. Central, for orders placed that week | Announcement; time of day assumed |
| Which EIA figure | The one dated the Monday before. EIA releases it on Tuesday (Wednesday after a federal holiday), so it is the latest figure public before the new week starts | Matches the Nov 9, 2026 Dealer Update |
| In-between prices | Round to the nearest cent first ($6.254 → $6.25, $6.255 → $6.26) | Derek, Nov 16, 2026 |
| Below $3.00 | 0% | Derek, Nov 16, 2026 |
| Above $10.00 | No rate is set. The banner keeps the last rate marked "pending" and staff are alerted | Derek, Nov 16, 2026 |

Example: the week of November 16 uses the EIA figure dated November 9. The figure dated November 16 comes out on Tuesday the 17th and is saved for the week of November 23. It never changes the current week.

The banner does not say what the percentage is applied to. Add that wording once it is confirmed.

## One-time setup (about 20 minutes)

1. **Get a free EIA key.** Register at https://www.eia.gov/opendata/ and the key arrives by email.
2. **Create a GitHub repository** under the `Integrity-Cabinets` account named `ic-fuel-surcharge`. It must be **Public**, the same as the resources widget, so the portal can read the data file. Only the rate, lead times and run status are in it. The key is not.
3. **Upload everything in this folder** to the repository.
4. **Add the schedule.** In the repository, open the Actions tab and choose "set up a workflow yourself". Name the file `update-fuel-surcharge.yml`, replace the sample text with the whole contents of `workflow-for-github/update-fuel-surcharge.yml`, and commit. GitHub saves it at `.github/workflows/update-fuel-surcharge.yml`, which is the only place a schedule runs from.
5. **Add the key as a secret.** In the repository: Settings → Secrets and variables → Actions → New repository secret. Name: `EIA_API_KEY`. Value: your key.
6. **Run it once.** Actions tab → "Update fuel surcharge" → Run workflow. Leave the three boxes blank. A green check means it worked.
7. **Check the result.** Open `data/fuel-surcharge.json`. Compare the percentage and diesel price with the EIA website and with the rate Customer Service sent out this week. **Do not put the banner on the portal until these match.**
8. **Check the lead times** in `data/lead-times.json` against what Customer Service is quoting this week (see Lead times below).
9. **Add the banner to Squarespace.** Edit the portal page, add a **Code** block below the resources widget, and paste in the whole contents of `widget/fuel-surcharge-banner.html`. If the account or repository name differs from step 2, change the one `DATA_URL` line near the bottom.

To get emailed when a run fails: on the repository page choose Watch → Custom → Actions. GitHub then emails you when a run shows a red X.

## Lead times

Lead times roll forward by themselves. `data/lead-times.json` holds the dates for one starting week (`anchorWeek`). Every Monday at 12:00 a.m. Central the banner moves each date forward 7 days. No job is involved, so nothing can fail to run.

Normal pattern (confirmed November 16, 2026): Rush is the production week 2 weeks out, Regular is 4 weeks out, Elite is 7 weeks out.

**The rollover does not know about holidays or shutdowns.** Those are entered as one-week overrides. The 2026 holiday schedule is already in the file. With it, the banner shows:

| Orders entered week of | Rush Orders | Regular Production | Elite Production |
|---|---|---|---|
| Nov 16 | Nov 30 – Dec 4 | Dec 14 – 18 | Jan 4 – 8 |
| Nov 23 | Dec 7 – 11 | Dec 21 – 25 | Jan 11 – 15 |
| Nov 30 | Dec 14 – 18 | Jan 4 – 8 (holiday) | Jan 18 – 22 |
| Dec 7 | Dec 21 – 25 | Jan 11 – 15 (holiday) | Jan 25 – 29 |
| Dec 14 | Contact Customer Service * | Jan 18 – 22 (holiday) | Feb 1 – 5 |
| Dec 21 | Jan 4 – 8 | Jan 25 – 29 (holiday) | Feb 8 – 12 |
| Dec 28 | Jan 4 – 8 (holiday) | Jan 25 – 29 | Feb 15 – 19 |
| Jan 4 | Jan 18 – 22 | Feb 1 – 5 | Feb 22 – 26 |

\* The normal Rush week for orders entered the week of Dec 14 is Dec 28 – Jan 1, which has no production. Replace "Contact Customer Service" in `overrides` with the right week once confirmed, or delete that override line to show Dec 28 – Jan 1.

Still to confirm: whether Regular for the week of Nov 23 should read Dec 21 – 25 given the Dec 24 – 25 closure, and whether Elite orders entered the weeks of Dec 21 and Dec 28 are combined the way standard orders are.

To make changes, edit the file on GitHub with the pencil icon and click **Commit changes**. The portal shows it within about five minutes.

- **Change one week only.** Add a line to `overrides`. The week must be that week's Monday and the label must match exactly. The normal pattern resumes the following week.
  ```
  "overrides": [
    { "week": "2026-11-16", "label": "Rush Orders", "value": "November 30th" }
  ]
  ```
- **Shift the pattern from now on** (production running ahead or behind, or after a shutdown). Set `anchorWeek` to this week's Monday and enter this week's dates in `items`. Everything rolls forward from there.

If the file has a typo the banner cannot read, it shows "Please contact Customer Service for current lead times" instead of a wrong date.

## Announcements

Edit `data/announcements.json` on GitHub. Each announcement has the text and the dates it should show (both included). Up to three show at once. Plain text only.

```
"announcements": [
  { "text": "Our offices will be closed Thursday and Friday, November 26 and 27.", "showFrom": "2026-11-16", "showThrough": "2026-11-27" }
]
```

Leave the list empty (`[]`) to show none. Expired announcements can stay in the file; they simply stop showing.

## When something goes wrong

The job never invents a number. If it cannot get a valid EIA price, it changes nothing, records why in `data/status.json`, and shows a red X in the Actions tab.

| What dealers see | What it means | What to do |
|---|---|---|
| Rate with "Effective" dates | Normal | Nothing |
| Last rate with "Was effective" and "pending" | No rate is recorded for this week | Read `data/status.json`. Fix the cause and re-run, or enter a manual rate |
| "Fuel surcharge unavailable" | No rate has ever been saved, or the data file cannot be reached | Check setup steps 2 to 6 |

**Entering a rate by hand** (for example, diesel above $10.00): Actions → Update fuel surcharge → Run workflow, then fill in the Monday date, the percent with two decimals, and a note saying who set it and why. It only fills a week that has no rate. It will not overwrite one.

**Recovery after downtime.** Each run checks this week and next week and fills in whichever is missing, so a missed run is made up by the next one. A catch-up run for a week already under way still uses the figure dated the Monday before, never a newer one.

**Open portal pages.** The banner re-checks the data every 15 minutes and whenever the tab is brought back into view. It also switches to the new week by itself at Monday 12:00 a.m. Central, because next week's rate is normally already saved by the previous Tuesday or Wednesday.

**Recorded weeks are permanent.** If EIA later revises a price, or the chart is changed, past and current weeks stay as they were. To correct a recorded week, edit `data/fuel-surcharge.json` by hand and add a line to that week's `notes` saying what changed and why.

## Changing the chart

Edit `config/surcharge-config.json`, and change `configVersion` so later records show which chart they used. Each run first checks the chart for gaps, overlaps and missing rates and refuses to run if it finds any. Changes apply only to weeks not yet recorded.

## Previewing on your own computer (optional)

Needs Node.js 20 or newer (https://nodejs.org).

```
node --test                       runs the checks
node scripts/make-preview.mjs     builds widget/preview.html with SAMPLE data
```

Open `widget/preview.html` to see the banner in its three states. It is labelled as a demo and uses the sample file in `tests/fixtures`, not live data.

## What is in this folder

| File | Purpose |
|---|---|
| `config/surcharge-config.json` | The surcharge chart and rules |
| `data/fuel-surcharge.json` | Every week's rate (written by the job) |
| `data/lead-times.json` | Starting lead-time dates that roll forward weekly |
| `data/announcements.json` | Announcements (edited by staff) |
| `data/status.json` | Result of the latest run (created on first run) |
| `scripts/update.mjs` | The job: fetch from EIA, check, save |
| `scripts/lib.mjs` | The calculation and calendar rules |
| `scripts/make-preview.mjs` | Builds the sample preview page |
| `tests/` | Checks for tier edges, rounding, the Monday cutoff, daylight saving, Tuesday arrivals, duplicate runs, missing data and feed failure |
| `widget/fuel-surcharge-banner.html` | The banner to paste into Squarespace |
| `workflow-for-github/update-fuel-surcharge.yml` | The schedule. Goes into GitHub at `.github/workflows/` (setup step 4) |
| `.env.example` | Placeholder showing the key's name, for local runs only |

## Tested and not yet verified (as of November 16, 2026)

**Tested:** all 12 checks in `tests/` pass. The banner was viewed at desktop and phone widths with sample data in its normal, pending and unavailable states. The lead-time rollover was checked in a browser across the Monday midnight switch, a year change, a one-week override and an unreadable file. Announcements were checked before, during and after their dates.

**Not yet verified, and only checkable once it is set up:**

- **The live EIA connection.** The job has never called EIA with a real key. The web address and the series code `EMD_EPD2D_PTE_NUS_DPG` come from EIA's published API layout and were not confirmed against a live answer. If either is wrong, the first run fails with a clear message and saves nothing. Setup step 7 is the check.
- **The GitHub schedule.** The workflow file has not been run on GitHub.
- **The banner inside Squarespace.** Fonts, width and spacing may need a small adjustment once it sits on the real page.
- **Failure emails.** These depend on the Watch setting above and have not been triggered.

**Known limit:** if EIA publishes a figure more than six days late and the scheduled runs were also down that same week, a catch-up run cannot tell that the figure arrived after the Monday cutoff. The Thursday "overdue" alert flags the late figure when it happens.
