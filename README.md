# Beacon Parking

A phone web app for Beacon Hill street cleaning. It knows every Beacon Hill
curb's sweeping schedule, keeps track of where the car is, ranks where to move
it next, and sends calendar invites to both of you for when to move it.

## How it decides where to move

Every Beacon Hill residential curb is swept 8 AM to noon on alternating weeks
(odd sides in the 1st and 3rd weeks of the month, even sides in the 2nd and
4th). Right at noon, a just-swept curb is empty because everyone had to leave,
which makes it the easiest time to find a spot.

So the app finds every sweep that ends before your car's own sweep (leaving
the time you need to search, 60 minutes by default) and ranks them by:

1. **How long you can stay** (half the score): the date of that curb's next sweep.
   A move only counts if it outlasts staying where you are.
2. **Walking distance from home** (a quarter).
3. **How much curb opens at the same time nearby** (a quarter): more open curb
   means better odds.

It never recommends metered curbs, curbs swept every night, or (during a
declared snow emergency) snow routes. If a sweep or snow emergency means the
car has to move now, it switches to the best curbs that are open right now.

Two calendar events go out each time the car is saved:

- **Move car to X at 12:00 PM**: starts 10 minutes before the top pick opens.
  Its notes list the backup options.
- **Car deadline**: the hour before your current curb gets swept, in case the
  first event was missed.

Each event alerts you 30 minutes before (60 minutes for the deadline) and at
8 PM the evening before.

## Schedule rules it follows (City of Boston)

- Beacon Hill daytime sweeping runs **March 1 to December 31**, not April to November.
- Streets swept every other week are **not enforced in the 5th week** of a
  month. There is a setting to turn this off if a posted sign says otherwise.
- City holidays are not excluded, so the app errs toward moving.
- Data comes from Analyze Boston (sweeping schedule, street segments, address
  points, meters, snow routes, snow garages). It is refreshed automatically on
  the 1st of each month.

The posted sign always wins.

## Setup (about 20 minutes, once)

### 1. Publish the app (GitHub Pages, free)

From this folder:

```bash
gh repo create beacon-parking --public --source . --push
```

Then on GitHub, go to the repo's Settings, then Pages, set "Source" to
**GitHub Actions**, and re-run the Deploy workflow (Actions tab). The app will
be at `https://<username>.github.io/beacon-parking/`.

The repo has to be public for free Pages. Nothing private goes in it: your
home location and email addresses live only in your Google script.

### 2. Shared sync and calendar invites (Google Apps Script, free)

Do this from whichever of you has a Google account. The events live on that
account's calendar, and everyone listed in `GUESTS` (for example the Outlook
address) gets a real invite.

1. Go to script.google.com, then New project. Name it "Beacon Parking".
2. Replace the contents of `Code.gs` with `backend/Code.gs` from this folder.
3. Paste the `CONFIG` block from `backend/config.local.gs` over the CONFIG at
   the top, and fill in the email addresses and your partner's name.
4. Project Settings (gear icon): check "Show appsscript.json manifest file in
   editor", then replace its contents with `backend/appsscript.json`.
5. Deploy, then New deployment, then select type **Web app**. Execute as:
   **Me**. Who has access: **Anyone**. Deploy and approve the calendar
   permission. Copy the Web app URL (it ends in `/exec`).
6. Paste that URL into `CONFIG.WEB_APP_URL`, save, choose `setup` in the
   function dropdown, and click Run. The execution log prints one setup link
   per person.

Anyone with the URL can reach the web app, but it only responds to requests
that carry the passphrase from step 6.

### 3. Each iPhone

1. Text each person their setup link and open it in **Safari**. The phone is
   now connected and knows whose phone it is.
2. Tap Share, then **Add to Home Screen**. Open it from the home screen from
   now on.
3. Allow location when asked; that powers "I just parked here".

## Daily use

- **Parked?** Tap "I just parked here" and confirm the side of the street. That
  updates both phones and resends the invites.
- **Map colors:** red means sweeping now, orange within 24 hours, yellow
  within 3 days, green clear. Dashed gray curbs are metered or swept nightly.
  Blue dashes are snow routes. Tap any curb for its schedule.
- **Snow emergency:** flip the switch when the City declares one. Either of you
  can flip it, and it updates both phones and the calendar.

## Maintenance

```bash
python tools/fetch_raw.py      # download City data to tools/raw/
python tools/build_data.py     # rebuild app/data/segments.json
node tools/test_planner.js     # schedule and ranking checks
node tools/test_backend.js     # Apps Script logic with mocked Google services
```

When `Code.gs` changes, paste it into the Apps Script project again, then go
to Deploy, then Manage deployments, then Edit, and pick a new version. That
keeps the same URL.

## Files

| Path | What it is |
|---|---|
| `app/` | The web app (Leaflet map, planner, offline cache) |
| `app/planner.js` | Sweep schedule math and the ranking |
| `app/data/segments.json` | 61 Beacon Hill curbs with schedules and map lines |
| `backend/Code.gs` | Shared state and calendar invites (Apps Script) |
| `tools/` | Data pipeline and tests |
| `.github/workflows/pages.yml` | Deploy plus monthly data refresh |
