# Beau on Beacon Hill

A phone web app for Beacon Hill street cleaning. It knows every Beacon Hill
curb's sweeping schedule, keeps track of where the car is (automatically, if
you set up the iPhone Shortcut), ranks where to move it next, lets you and
Caroline claim who is moving it, plans around trips, and sends calendar
invites to both of you.

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
3. **How easy the curb is to get** (a quarter). It starts as how much curb
   opens nearby at the same moment, and shifts toward your own logged search
   times as they come in ("How long did it take?" after each park). Missing a
   suggested curb counts against it.

It never recommends metered curbs, curbs swept every night, or (during a
snow emergency) snow routes, and it marks down curbs with a moving-truck
permit during your stay. If the car has to move now, it switches to the best
curbs open right now.

**Trips:** add time away and the plan moves your deadline up to departure,
puts curbs that last the whole trip first, and never schedules a move while
you are away. If nothing lasts the whole trip (every-other-week streets top
out near two weeks), it picks the longest-lasting spot and says so a week
ahead.

## Calendar and nudges

Each time the car is saved, two invites go to both calendars:

- **Move car to X at 12:00 PM**: starts 10 minutes before the top pick opens.
  Its notes list the backup options. When one of you taps "I'll move it", the
  same invite is renamed "Caroline moves car to X" (one update, no re-invite).
- **Car deadline**: the hour before your current curb gets swept (or before
  you leave on a trip), in case the first event was missed.

The Google script also checks every 15 minutes and emails you both, once per
situation, when:

- nobody has claimed tomorrow's move by 8 PM the night before,
- the car is still logged on a curb that gets swept in the next 90 minutes, or
  sweeping has started,
- a trip a week out has no curb that lasts,
- a moving-truck permit lands on the car's block,
- boston.gov shows a snow emergency banner (the app's snow switch turns on by
  itself, and off again when the banner is gone).

## Schedule rules it follows (City of Boston)

- Beacon Hill daytime sweeping runs **March 1 to December 31**, not April to November.
- Streets swept every other week are **not enforced in the 5th week** of a
  month. There is a setting to turn this off if a posted sign says otherwise.
- City holidays are flagged ("may be suspended") but still counted, so the app
  errs toward moving.
- Data comes from Analyze Boston: sweeping schedule, street segments, address
  points, meters, snow routes and snow garages (refreshed on the 1st of each
  month), and moving-truck permits (refreshed every 3 hours).

The posted sign always wins.

## Setup

### 1. The app (done)

Hosted free on GitHub Pages at https://jackson-parthasarathy.github.io/beacon-parking/
from this repo. Every push redeploys within a minute.

### 2. Shared sync, invites and nudges (Google Apps Script, free)

1. Fill in `backend/config.local.gs` (emails, names, home) and run
   `python backend/build_paste.py`. That writes `backend/config.local.Code.gs`,
   the complete script with your settings in it. Both files are gitignored.
2. Go to script.google.com, then New project. Name it "Beau on Beacon Hill".
3. Project Settings (gear icon): check "Show appsscript.json manifest file in
   editor". Back in the Editor, replace `appsscript.json` with
   `backend/appsscript.json`, and replace `Code.gs` with
   `backend/config.local.Code.gs`. Save.
4. Deploy, then New deployment, then select type **Web app**. Execute as:
   **Me**. Who has access: **Anyone**. Deploy and approve the permissions
   (Google warns the app is unverified because it is your own script: choose
   Advanced, then Go to Beau on Beacon Hill). Copy the Web app URL (it ends in
   `/exec`).
5. Paste that URL into `WEB_APP_URL` in the CONFIG at the top, save, choose
   `setup` in the function dropdown, and click Run. The execution log prints
   one setup link per person, plus the values for the iPhone Shortcut, and
   installs the 15-minute background check.

Anyone with the URL can reach the web app, but it only responds to requests
that carry the passphrase made in step 5.

**Updating the script later:** paste the new `config.local.Code.gs` (and
`appsscript.json` if it changed), then Deploy, then Manage deployments, the
pencil, Version: **New version**, Deploy. That keeps the same URL. Run `setup`
again afterward; it approves any new permissions and reinstalls the check.

### 3. Each phone

1. Text each person their setup link.
2. On the iPhone, open the app URL in Safari or Chrome, tap Share, then **Add
   to Home Screen**.
3. Open the app from the home screen. In the "Connect this phone" box, paste
   your setup link and tap Connect. (A home screen app keeps its own storage
   separate from the browser, which is why the link is pasted here.)
4. Allow location when asked; that powers "I just parked here".
5. Optional, recommended: Settings, then "Hands-free logging", and build the
   Shortcut it describes (about 5 minutes). Then the car logs itself when
   your phone disconnects from the car.

If sync fails, Settings, then "Shared sync", then **Test connection** says
exactly what is wrong.

## Daily use

- **Parked?** With the Shortcut, it logs itself and the app asks "Right side
  of the street?". Without it, tap "I just parked here". Either way both
  phones update and the invites are resent.
- **Next move:** tap "I'll move it" so the other person knows.
- **After parking:** answer "How long did it take?" with one tap.
- **Map:** red means sweeping now, orange within 24 hours, yellow within 3
  days, green clear. Dashed gray curbs are metered or swept nightly. Blue
  dashes are snow routes, orange squares are moving-truck permits. Tap any
  curb for its schedule.

## Maintenance

```bash
python tools/fetch_raw.py           # download City data to tools/raw/
python tools/build_data.py          # rebuild app/data/segments.json
python tools/fetch_restrictions.py  # moving-truck permits (also runs at deploy)
node tools/test_planner.js          # schedule, ranking, trips, learning, permits
node tools/test_backend.js          # Apps Script logic with mocked Google services
```

## Files

| Path | What it is |
|---|---|
| `app/` | The web app (Leaflet map, offline cache) |
| `app/planner.js` | Sweep schedule math and the ranking |
| `app/engine.js` | Events, claims, trips, learning, curb lookups (shared with the backend) |
| `app/data/segments.json` | 61 Beacon Hill curbs with schedules, map lines and house numbers |
| `backend/Code.gs` | Shared state, invites, Shortcut endpoint, nudges (Apps Script) |
| `tools/` | Data pipeline and tests |
| `.github/workflows/pages.yml` | Deploy, permits every 3 hours, monthly schedule refresh |
