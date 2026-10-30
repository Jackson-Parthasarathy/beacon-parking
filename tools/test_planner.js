// Regression checks for app/planner.js. Usage: node tools/test_planner.js
const P = require('../app/planner.js');
const D = require('../app/data/segments.json');
const byId = Object.fromEntries(D.curbs.map(c => [c.id, c]));
const season = D.season['Beacon Hill'];
const et = d => d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

const chestnutOdd = byId[421];
const occ = P.occurrences(chestnutOdd, new Date('2026-10-01T04:00:00Z'), new Date('2027-03-31T04:00:00Z'), { season });
const days = occ.map(o => et(o.start));
assert(days[0] === 'Fri, Oct 2, 8:00 AM', '1st Friday of October at 8 AM EDT');
assert(!days.some(d => d.startsWith('Fri, Oct 30')), '5th Friday skipped on an every-other-week street');
assert(days.includes('Fri, Nov 6, 8:00 AM'), '8 AM stays 8 AM after DST ends');
assert(!days.some(d => /Jan|Feb/.test(d)), 'no sweeping in January and February');
assert(days.includes('Fri, Mar 5, 8:00 AM'), 'season restarts March 1');
assert(P.occurrences(chestnutOdd, new Date('2026-10-01T04:00:00Z'), new Date('2026-11-01T04:00:00Z'), { season, skipFifthWeek: false })
  .some(o => et(o.start).startsWith('Fri, Oct 30')), '5th week included when the setting is off');

const home = [-71.0705, 42.3587];   // Louisburg Square, a neutral test point
const r = P.rank({ curbs: D.curbs, now: new Date('2026-10-30T14:00:00Z'), home, car: { curbId: 421 }, settings: {}, season });
assert(et(r.deadline) === 'Fri, Nov 6, 8:00 AM', 'deadline is the next sweep of the car curb');
assert(r.options.length > 0 && r.options.every(o => o.at < r.deadline && o.until > r.deadline), 'every option is before the deadline and outlasts it');
assert(r.options.every(o => !o.curb.metered && !o.curb.daily), 'metered and nightly curbs never recommended');

const winter = P.rank({ curbs: D.curbs, now: new Date('2026-12-20T15:00:00Z'), home, car: { curbId: 421 }, settings: {}, season });
assert(winter.options.every(o => o.until > winter.deadline), 'winter: no move that ends sooner than staying put');

const snow = P.rank({ curbs: D.curbs, now: new Date('2027-01-10T15:00:00Z'), home, car: { curbId: 519 }, settings: { snowEmergency: true }, season });
assert(snow.mustMoveNow && snow.fallback.length > 0 && snow.fallback.every(o => !o.curb.snowArtery), 'snow emergency on a snow route: move now, off snow routes');
